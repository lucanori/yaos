import * as Y from "yjs";
import { gzipSync } from "fflate";
import { mapWithConcurrency } from "./concurrency";
import type { S3Storage } from "./storage/s3";

export interface SnapshotIndex {
  snapshotId: string;
  vaultId: string;
  createdAt: string;
  day: string;
  schemaVersion: number | undefined;
  markdownFileCount: number;
  blobFileCount: number;
  crdtSizeBytes: number;
  crdtRawSizeBytes: number;
  referencedBlobHashes: string[];
  triggeredBy?: string;
}

export interface SnapshotResult {
  status: "created" | "noop" | "unavailable";
  snapshotId?: string;
  reason?: string;
  index?: SnapshotIndex;
}

const SNAPSHOT_FETCH_CONCURRENCY = 4;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function blobKey(vaultId: string, hash: string): string {
  return `v1/${vaultId}/blobs/${hash}`;
}

function generateSnapshotId(): string {
  const ts = Date.now().toString(36);
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${ts}-${rand}`;
}

function snapshotPrefix(vaultId: string, day: string, snapshotId: string): string {
  return `v1/${vaultId}/snapshots/${day}/${snapshotId}`;
}

function normalizeBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/**
 * Convert AWS SDK response body to Uint8Array
 * AWS SDK v3 in Node.js returns a Readable stream (async iterable), not Web ReadableStream
 */
async function bodyToUint8Array(body: unknown): Promise<Uint8Array> {
  // If it's already a Uint8Array, return it
  if (body instanceof Uint8Array) {
    return body;
  }

  // If it's a string, encode it
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }

  // If it has transformToByteArray method (SDK utility streams), use it
  if (body && typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function") {
    return await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }

  // If it has transformToString method (SDK utility streams), use it
  if (body && typeof (body as { transformToString?: () => Promise<string> }).transformToString === "function") {
    const str = await (body as { transformToString: () => Promise<string> }).transformToString();
    return new TextEncoder().encode(str);
  }

  // If it's a Node.js Readable stream (async iterable), collect chunks
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    const iterableBody = body as AsyncIterable<Uint8Array | Buffer>;
    for await (const chunk of iterableBody) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        const buf = chunk as Buffer;
        chunks.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      } else {
        throw new Error(`Unexpected chunk type: ${typeof chunk}`);
      }
    }
    
    // Concatenate chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  // If it's a Web ReadableStream, use getReader
  if (body && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  throw new Error(`Unknown body type: ${typeof body}`);
}

async function listAllKeys(s3: S3Storage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await s3.list({
      prefix,
      limit: 1000,
      cursor,
    });

    for (const object of page.objects) {
      keys.push(object.key);
    }

    if (!page.truncated) break;
    cursor = page.cursor;
  }

  return keys;
}

export async function hasSnapshotForDay(
  vaultId: string,
  day: string,
  s3: S3Storage,
): Promise<boolean> {
  const page = await s3.list({
    prefix: `v1/${vaultId}/snapshots/${day}/`,
    limit: 1,
  });
  return page.objects.length > 0;
}

export async function createSnapshot(
  ydoc: Y.Doc,
  vaultId: string,
  s3: S3Storage,
  triggeredBy?: string,
): Promise<SnapshotIndex> {
  const day = today();
  const snapshotId = generateSnapshotId();
  const prefix = snapshotPrefix(vaultId, day, snapshotId);

  const rawUpdate = Y.encodeStateAsUpdate(ydoc);
  const compressed = gzipSync(rawUpdate);

  const pathToId = ydoc.getMap<string>("pathToId");
  const pathToBlob = ydoc.getMap<unknown>("pathToBlob");
  const sys = ydoc.getMap<unknown>("sys");

  const referencedBlobHashes: string[] = [];
  pathToBlob.forEach((ref: unknown) => {
    if (!ref || typeof ref !== "object" || !("hash" in ref)) return;
    const hash = (ref as { hash?: unknown }).hash;
    if (typeof hash === "string") {
      referencedBlobHashes.push(hash);
    }
  });

  const index: SnapshotIndex = {
    snapshotId,
    vaultId,
    createdAt: new Date().toISOString(),
    day,
    schemaVersion: sys.get("schemaVersion") as number | undefined,
    markdownFileCount: pathToId.size,
    blobFileCount: pathToBlob.size,
    crdtSizeBytes: compressed.byteLength,
    crdtRawSizeBytes: rawUpdate.byteLength,
    referencedBlobHashes,
    triggeredBy,
  };

  await Promise.all([
    s3.put(`${prefix}/crdt.bin.gz`, compressed, {
      contentType: "application/gzip",
    }),
    s3.put(`${prefix}/index.json`, JSON.stringify(index), {
      contentType: "application/json",
    }),
  ]);

  return index;
}

export async function listSnapshots(
  vaultId: string,
  s3: S3Storage,
): Promise<SnapshotIndex[]> {
  const keys = await listAllKeys(s3, `v1/${vaultId}/snapshots/`);
  const indexKeys = keys.filter((key) => key.endsWith("/index.json"));

  const indexes = await mapWithConcurrency(
    indexKeys,
    SNAPSHOT_FETCH_CONCURRENCY,
    async (key) => {
      try {
        const object = await s3.get(key);
        if (!object || !object.body) return null;
        
        // Use the new bodyToUint8Array function to handle both Node.js and Web streams
        const bytes = await bodyToUint8Array(object.body);
        const text = new TextDecoder().decode(bytes);
        return JSON.parse(text) as SnapshotIndex;
      } catch (err) {
        console.error(`[listSnapshots] Error fetching ${key}:`, err);
        return null;
      }
    },
  );

  return indexes
    .filter((index): index is SnapshotIndex => index !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSnapshotPayload(
  vaultId: string,
  snapshotId: string,
  s3: S3Storage,
): Promise<{ index: SnapshotIndex; payload: Uint8Array } | null> {
  const snapshots = await listSnapshots(vaultId, s3);
  const index = snapshots.find((entry) => entry.snapshotId === snapshotId);
  if (!index) return null;

  const object = await s3.get(
    `${snapshotPrefix(vaultId, index.day, snapshotId)}/crdt.bin.gz`,
  );
  if (!object || !object.body) return null;

  const bytes = await bodyToUint8Array(object.body);
  return {
    index,
    payload: normalizeBytes(bytes),
  };
}