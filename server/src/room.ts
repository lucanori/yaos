import * as Y from "yjs";
import { PostgresStorage } from "./storage/postgres";
import { YPartyServer } from "./ywebsocket";
import { ChunkedDocStore } from "./chunkedDocStore";
import { readRoomMeta, type RoomMeta, writeRoomMeta } from "./roomMeta";
import {
  createSnapshot,
  hasSnapshotForDay,
  type SnapshotResult,
} from "./snapshot";
import {
  appendTraceEntry,
  listRecentTraceEntries,
  prepareTraceEntryForStorage,
  type TraceEntry as StoredTraceEntry,
} from "./traceStore";
import type { S3Storage } from "./storage/s3";
import type { PostgresTraceStorage } from "./storage/postgresTrace";

const MAX_DEBUG_TRACE_EVENTS = 200;
const JOURNAL_COMPACT_MAX_ENTRIES = 50;
const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024;
const TRACE_DEBUG_LIMIT = 100;
const LOG_PREFIX = "[yaos-sync:room]";

interface ServerTraceEntry extends StoredTraceEntry {}

interface RoomOptions {
  roomId: string;
  storage: PostgresStorage;
  traceStorage: PostgresTraceStorage;
  s3Storage?: S3Storage;
}

export interface WebSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  on(event: "message", handler: (data: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  readyState: number;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class Room {
  readonly roomId: string;
  private storage: PostgresStorage;
  private traceStorage: PostgresTraceStorage;
  private s3Storage: S3Storage | undefined;
  
  private document: Y.Doc;
  private documentLoaded = false;
  private loadPromise: Promise<void> | null = null;
  private chunkedDocStore: ChunkedDocStore | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private snapshotMaybeChain: Promise<void> = Promise.resolve();
  private lastSavedStateVector: Uint8Array | null = null;
  private roomMeta: RoomMeta | null = null;
  
  readonly yPartyServer: YPartyServer;
  private clients = new Set<WebSocket>();
  
  constructor(options: RoomOptions) {
    this.roomId = options.roomId;
    this.storage = options.storage;
    this.traceStorage = options.traceStorage;
    this.s3Storage = options.s3Storage;
    // Create document with gc enabled (matching y-partyserver)
    this.document = new Y.Doc({ gc: true });

    // Create y-partyserver compatible server BEFORE setting up persistence handlers
    // This ensures YPartyServer attaches its handlers first
    this.yPartyServer = new YPartyServer(this.roomId, this.document);
  }

  async initialize(): Promise<void> {
    await this.ensureDocumentLoaded();
  }

  async handleWebSocket(socket: WebSocket): Promise<void> {
    const clientId = crypto.randomUUID();
    this.clients.add(socket);

    await this.recordTrace("client-connected", {
      clientId,
      clientCount: this.clients.size,
    });

    // Set up message forwarding from socket to y-partyserver
    socket.on("message", (data: Buffer) => {
      try {
        const message = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.yPartyServer.handleMessage(message, socket);
      } catch (err) {
        console.error(`${LOG_PREFIX} Error handling message:`, err);
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      this.yPartyServer.removeConnection(socket);
      this.recordTrace("client-disconnected", {
        clientId,
        clientCount: this.clients.size,
      });
    });

    socket.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} WebSocket error for ${clientId}:`, err);
      this.clients.delete(socket);
      this.yPartyServer.removeConnection(socket);
    });

    // Ensure document is loaded before adding connection
    await this.ensureDocumentLoaded();

    // Add connection to y-partyserver
    this.yPartyServer.addConnection(socket);
  }

  async handleHttp(method: string, pathname: string, body?: unknown): Promise<unknown> {
    if (method === "GET" && pathname === "/__yaos/meta") {
      return {
        roomId: this.roomId,
        meta: await this.readRoomMetaCheap(),
      };
    }

    if (method === "GET" && pathname === "/__yaos/document") {
      await this.ensureDocumentLoaded();
      return Y.encodeStateAsUpdate(this.document);
    }

    if (method === "GET" && pathname === "/__yaos/debug") {
      const recent = await listRecentTraceEntries(this.traceStorage, TRACE_DEBUG_LIMIT);
      return {
        roomId: this.roomId,
        recent,
      };
    }

    if (method === "POST" && pathname === "/__yaos/trace") {
      const data = body as { event?: string; data?: Record<string, unknown> };
      if (!data.event || typeof data.event !== "string") {
        return { error: "missing event" };
      }
      await this.recordTrace(data.event, data.data ?? {});
      return { ok: true };
    }

    if (method === "POST" && pathname === "/__yaos/snapshot-maybe") {
      await this.ensureDocumentLoaded();
      const data = body as { device?: string };
      return await this.createDailySnapshotMaybe(data.device);
    }

    return { error: "not found" };
  }

  async save(): Promise<void> {
    await this.ensureDocumentLoaded();
    const baseStateVector = this.lastSavedStateVector;
    const persistedStateVector = Y.encodeStateVector(this.document);
    
    if (baseStateVector && equalBytes(baseStateVector, persistedStateVector)) {
      return;
    }
    
    const delta = baseStateVector
      ? Y.encodeStateAsUpdate(this.document, baseStateVector)
      : Y.encodeStateAsUpdate(this.document);
    
    if (delta.byteLength === 0) {
      return;
    }
    
    await this.enqueueSave(delta, persistedStateVector);
    await this.syncRoomMetaFromDocument();
  }

  private async ensureDocumentLoaded(): Promise<void> {
    if (this.documentLoaded) return;
    
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = this.loadDocument();
    
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async loadDocument(): Promise<void> {
    if (this.documentLoaded) return;

    const store = this.getChunkedDocStore();
    const state = await store.loadState();
    
    if (state.checkpoint) {
      Y.applyUpdate(this.document, state.checkpoint);
    }
    
    for (const update of state.journalUpdates) {
      Y.applyUpdate(this.document, update);
    }

    this.lastSavedStateVector = (
      state.checkpointStateVector && state.journalUpdates.length === 0
    )
      ? state.checkpointStateVector.slice()
      : Y.encodeStateVector(this.document);
    
    this.documentLoaded = true;
    
    await this.syncRoomMetaFromDocument();
    
    await this.recordTrace("checkpoint-load", {
      hasCheckpoint: state.checkpoint !== null,
      checkpointStateVectorBytes: state.checkpointStateVector?.byteLength ?? 0,
      journalEntryCount: state.journalStats.entryCount,
      journalBytes: state.journalStats.totalBytes,
      replayMode:
        state.checkpoint !== null && state.journalUpdates.length > 0
          ? "checkpoint+journal"
          : state.checkpoint !== null
            ? "checkpoint-only"
            : state.journalUpdates.length > 0
              ? "journal-only"
              : "empty",
    });
  }

  private getChunkedDocStore(): ChunkedDocStore {
    if (!this.chunkedDocStore) {
      this.chunkedDocStore = new ChunkedDocStore(this.storage);
    }
    return this.chunkedDocStore;
  }

  private enqueueSave(delta: Uint8Array, persistedStateVector: Uint8Array): Promise<void> {
    const run = this.saveChain.then(async () => {
      const store = this.getChunkedDocStore();
      const journalStats = await store.appendUpdate(delta);
      
      if (
        journalStats.entryCount > JOURNAL_COMPACT_MAX_ENTRIES
        || journalStats.totalBytes > JOURNAL_COMPACT_MAX_BYTES
      ) {
        const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
        const checkpointStateVector = Y.encodeStateVector(this.document);
        await store.rewriteCheckpoint(checkpointUpdate, checkpointStateVector);
        
        await this.recordTrace("checkpoint-fallback-triggered", {
          reason: "journal-compaction-threshold-exceeded",
          journalEntryCount: journalStats.entryCount,
          journalBytes: journalStats.totalBytes,
          maxJournalEntries: JOURNAL_COMPACT_MAX_ENTRIES,
          maxJournalBytes: JOURNAL_COMPACT_MAX_BYTES,
          note: "clients behind compaction boundary may require checkpoint-based catchup",
        });
        
        this.lastSavedStateVector = checkpointStateVector;
        return;
      }
      
      this.lastSavedStateVector = persistedStateVector;
    });
    
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  private async readRoomMetaCheap(): Promise<RoomMeta | null> {
    const stored = await readRoomMeta(this.storage);
    if (stored) {
      this.roomMeta = stored;
    }
    
    if (this.documentLoaded) {
      const liveSchemaVersion = this.currentSchemaVersion();
      if (!this.roomMeta || this.roomMeta.schemaVersion !== liveSchemaVersion) {
        const nextMeta: RoomMeta = {
          schemaVersion: liveSchemaVersion,
          updatedAt: new Date().toISOString(),
        };
        this.roomMeta = nextMeta;
        void this.syncRoomMetaFromDocument();
      }
    }
    
    return this.roomMeta;
  }

  private currentSchemaVersion(): number | null {
    const stored = this.document.getMap("sys").get("schemaVersion");
    if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
      return stored;
    }
    return null;
  }

  private async syncRoomMetaFromDocument(): Promise<void> {
    const nextSchemaVersion = this.currentSchemaVersion();
    if (this.roomMeta && this.roomMeta.schemaVersion === nextSchemaVersion) {
      return;
    }
    
    const nextMeta: RoomMeta = {
      schemaVersion: nextSchemaVersion,
      updatedAt: new Date().toISOString(),
    };
    
    try {
      await writeRoomMeta(this.storage, nextMeta);
      this.roomMeta = nextMeta;
    } catch (err) {
      console.error(`${LOG_PREFIX} room meta persist failed:`, err);
    }
  }

  private async createDailySnapshotMaybe(triggeredBy?: string): Promise<SnapshotResult> {
    const serialized = { chain: this.snapshotMaybeChain };
    
    const run = async (): Promise<SnapshotResult> => {
      if (!this.s3Storage) {
        return {
          status: "unavailable",
          reason: "S3 storage not configured",
        };
      }

      const currentDay = new Date().toISOString().slice(0, 10);
      
      if (await hasSnapshotForDay(this.roomId, currentDay, this.s3Storage)) {
        return {
          status: "noop",
          reason: `Snapshot already taken today (${currentDay})`,
        };
      }

      const index = await createSnapshot(
        this.document,
        this.roomId,
        this.s3Storage,
        triggeredBy,
      );
      
      return {
        status: "created",
        snapshotId: index.snapshotId,
        index,
      };
    };

    const promise = serialized.chain.then(run);
    this.snapshotMaybeChain = promise.then(() => undefined, () => undefined);
    return await promise;
  }

  private async recordTrace(event: string, data: Record<string, unknown>): Promise<void> {
    const entry = prepareTraceEntryForStorage({
      ...data,
      ts: new Date().toISOString(),
      event,
      roomId: this.roomId,
    }) as ServerTraceEntry;

    console.debug(JSON.stringify({
      source: "yaos-sync/room",
      ...entry,
    }));

    try {
      await appendTraceEntry(this.traceStorage, entry, MAX_DEBUG_TRACE_EVENTS);
    } catch (err) {
      console.error(`${LOG_PREFIX} trace persist failed:`, err);
    }
  }
}
