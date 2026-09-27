import type { Server as BunServerType, ServerWebSocket } from "bun";
import * as Y from "yjs";
import { PostgresConfigStorage } from "./storage/postgresConfig";
import { S3Storage } from "./storage/s3";
import { RoomManager } from "./roomManager";
import { renderMobileSetupPage, renderRunningPage, renderSetupPage } from "./setupPage";
import {
  SERVER_MAX_SCHEMA_VERSION,
  SERVER_MIN_PLUGIN_VERSION,
  SERVER_MIN_SCHEMA_VERSION,
  SERVER_RECOMMENDED_PLUGIN_VERSION,
  SERVER_VERSION,
} from "./version";
import type { SnapshotResult } from "./snapshot";
import { sha256Hex } from "./hex";

const MAX_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;
const EXISTS_BATCH_LIMIT = 50;
const CORS_ALLOW_HEADERS = "Authorization, Content-Type";
const CORS_ALLOW_METHODS = "GET, POST, PUT, OPTIONS";
const CORS_EXPOSE_HEADERS = "X-YAOS-Snapshot-Day";
const LOG_PREFIX = "[yaos-sync:bun]";

interface ServerConfig {
  port: number;
  databaseUrl: string;
  syncToken?: string;
  canonicalRepo?: string;
  s3?: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

type AuthState =
  | { mode: "env"; claimed: true; envToken: string }
  | { mode: "claim"; claimed: true; tokenHash: string }
  | { mode: "unclaimed"; claimed: false };

type UpdateProvider = "github" | "gitlab" | "unknown";

type FatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";
const LEGACY_CLIENT_SCHEMA_VERSION = 1;

interface WebSocketData {
  roomId: string;
  authorized: boolean;
  socketId: string;
  rejection?: {
    code: FatalAuthCode;
    details: Record<string, unknown>;
  };
}

// Global socket registry to route messages from Bun's WebSocket handler to Room handlers
type RoomSocketEntry = {
  room: import("./room").Room;
  socket: BunWebSocketAdapter;
};
const socketRegistry = new Map<string, RoomSocketEntry>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsPreflight(): Response {
  return withCors(new Response(null, { status: 204 }));
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isValidHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

function getHttpAuthToken(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token || null;
}

function getSocketAuthToken(req: Request): string | null {
  const headerToken = getHttpAuthToken(req);
  if (headerToken) return headerToken;
  return new URL(req.url).searchParams.get("token");
}

function parseClientSchemaVersion(url: URL): { version: number; source: "query" | "legacy-default" } | null {
  const raw = url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema");
  if (raw === null || raw.trim() === "") {
    return { version: LEGACY_CLIENT_SCHEMA_VERSION, source: "legacy-default" };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return { version: parsed, source: "query" };
}

function parseSyncPath(pathname: string): { vaultId: string } | null {
  const directMatch = pathname.match(/^\/vault\/sync\/([^/]+)$/);
  if (directMatch) {
    const [, vaultId] = directMatch;
    if (vaultId) {
      return { vaultId: decodeURIComponent(vaultId) };
    }
  }
  return null;
}

function parseVaultPath(pathname: string): { vaultId: string; rest: string[] } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "vault") return null;
  const vaultId = parts[1];
  if (!vaultId) return null;
  return {
    vaultId: decodeURIComponent(vaultId),
    rest: parts.slice(2),
  };
}

function isWebSocketRequest(req: Request): boolean {
  return (req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

function rejectSocket(
  req: Request,
  code: FatalAuthCode,
  details: Record<string, unknown> = {},
): Response {
  if (!isWebSocketRequest(req)) {
    return json(
      { error: code },
      code === "unauthorized"
        ? 401
        : code === "update_required"
          ? 426
          : 503,
    );
  }

  // For WebSocket requests, we return a special response that tells the
  // server to upgrade but mark it as rejected. The rejection frames will
  // be sent in handleWebSocketOpen before closing.
  // This is necessary because Bun requires us to return the upgrade response
  // from the fetch handler, and then the WebSocket handlers take over.
  return new Response(null, {
    status: 101,
    headers: {
      "Upgrade": "websocket",
      "Connection": "Upgrade",
      "X-YAOS-Rejection": JSON.stringify({ code, details }),
    },
  });
}

async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  return sha256Hex(bytes);
}

function supportsBuckets(s3: S3Storage | undefined): boolean {
  return s3 !== undefined;
}

function canonicalRepoForSetup(canonicalRepo?: string): string | undefined {
  const raw = canonicalRepo?.trim();
  if (!raw) return undefined;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : undefined;
}

function buildObsidianSetupUrl(host: string, token: string, vaultId?: string): string {
  const params = new URLSearchParams({
    action: "setup",
    host,
    token,
  });
  if (vaultId) {
    params.set("vaultId", vaultId);
  }
  return `obsidian://yaos?${params.toString()}`;
}

function getCapabilities(
  auth: AuthState,
  s3: S3Storage | undefined,
  config: { updateProvider?: string | null; updateRepoUrl?: string | null; updateRepoBranch?: string | null } | null = null
): {
  claimed: boolean;
  authMode: "env" | "claim" | "unclaimed";
  attachments: boolean;
  snapshots: boolean;
  serverVersion: string;
  minPluginVersion: string | null;
  recommendedPluginVersion: string | null;
  minSchemaVersion: number | null;
  maxSchemaVersion: number | null;
  migrationRequired: boolean;
  updateProvider: UpdateProvider | null;
  updateRepoUrl: string | null;
  updateRepoBranch: string | null;
} {
  const bucketEnabled = supportsBuckets(s3);
  return {
    claimed: auth.claimed,
    authMode: auth.mode,
    attachments: bucketEnabled,
    snapshots: bucketEnabled,
    serverVersion: SERVER_VERSION,
    minPluginVersion: SERVER_MIN_PLUGIN_VERSION,
    recommendedPluginVersion: SERVER_RECOMMENDED_PLUGIN_VERSION,
    minSchemaVersion: SERVER_MIN_SCHEMA_VERSION,
    maxSchemaVersion: SERVER_MAX_SCHEMA_VERSION,
    migrationRequired: false,
    updateProvider: (config?.updateProvider as UpdateProvider) ?? null,
    updateRepoUrl: config?.updateRepoUrl ?? null,
    updateRepoBranch: config?.updateRepoBranch ?? null,
  };
}

export class YaosServer {
  private server: BunServerType<WebSocketData> | null = null;
  private config: ServerConfig;
  private configStorage: PostgresConfigStorage;
  private roomManager: RoomManager;
  private s3Storage: S3Storage | undefined;

  constructor(config: ServerConfig) {
    this.config = config;
    this.configStorage = new PostgresConfigStorage({
      connectionString: config.databaseUrl,
    });
    this.roomManager = new RoomManager({
      connectionString: config.databaseUrl,
      s3Storage: config.s3 ? new S3Storage(config.s3) : undefined,
    });
    
    if (config.s3) {
      this.s3Storage = new S3Storage(config.s3);
    }
  }

  async start(): Promise<void> {
    await this.configStorage.initialize();
    await this.roomManager.initialize();

    const self = this;

    this.server = Bun.serve({
      port: this.config.port,
      fetch: (req: Request, server: BunServerType<WebSocketData>) => self.handleRequest(req, server),
      websocket: {
        message: (ws: ServerWebSocket<WebSocketData>, message: string | Buffer) => {
          self.handleWebSocketMessage(ws, message);
        },
        open: (ws: ServerWebSocket<WebSocketData>) => {
          self.handleWebSocketOpen(ws);
        },
        close: (ws: ServerWebSocket<WebSocketData>) => {
          self.handleWebSocketClose(ws);
        },
      },
    });

    console.log(`${LOG_PREFIX} Server running on http://localhost:${this.config.port}`);
  }

  async stop(): Promise<void> {
    await this.roomManager.closeAll();
    await this.configStorage.close();
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  private async getAuthState(): Promise<AuthState> {
    const envToken = this.config.syncToken?.trim();
    if (envToken) {
      return { mode: "env", claimed: true, envToken };
    }

    const config = await this.configStorage.readConfig();
    if (config.claimed && typeof config.tokenHash === "string" && config.tokenHash.length > 0) {
      return { mode: "claim", claimed: true, tokenHash: config.tokenHash };
    }

    return { mode: "unclaimed", claimed: false };
  }

  private async isAuthorized(state: AuthState, token: string | null): Promise<boolean> {
    if (!token) return false;
    if (state.mode === "env") {
      return token === state.envToken;
    }
    if (state.mode === "claim") {
      return (await hashToken(token)) === state.tokenHash;
    }
    return false;
  }

  private async handleRequest(req: Request, server: BunServerType<WebSocketData>): Promise<Response> {
    const url = new URL(req.url);
    
    if (
      req.method === "OPTIONS"
      && (url.pathname.startsWith("/vault/") || url.pathname.startsWith("/api/"))
    ) {
      return corsPreflight();
    }

    const authState = await this.getAuthState();

    if (req.method === "GET" && url.pathname === "/") {
      const body = authState.claimed
        ? renderRunningPage({
          host: url.origin,
          authMode: authState.mode,
          attachments: supportsBuckets(this.s3Storage),
          snapshots: supportsBuckets(this.s3Storage),
        })
        : renderSetupPage({
          host: url.origin,
          deployRepo: canonicalRepoForSetup(this.config.canonicalRepo),
        });
      return html(body);
    }

    if (req.method === "GET" && url.pathname === "/mobile-setup") {
      return html(
        renderMobileSetupPage({
          host: url.origin,
          deployRepo: canonicalRepoForSetup(this.config.canonicalRepo),
        }),
      );
    }

    if (req.method === "GET" && url.pathname === "/api/capabilities") {
      let config = null;
      try {
        const stored = await this.configStorage.readConfig();
        config = stored;
      } catch (err) {
        console.warn(`${LOG_PREFIX} config fetch failed for capabilities:`, err);
      }
      return withCors(json(getCapabilities(authState, this.s3Storage, config)));
    }

    if (req.method === "POST" && url.pathname === "/claim") {
      let body: { token?: string; vaultId?: string } = {};
      try {
        body = await req.json() as { token?: string; vaultId?: string };
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      if (typeof body.token !== "string" || body.token.trim().length < 32) {
        return json({ error: "invalid token" }, 400);
      }
      if (body.vaultId !== undefined && (typeof body.vaultId !== "string" || body.vaultId.trim().length < 8)) {
        return json({ error: "invalid vaultId" }, 400);
      }

      const token = body.token.trim();
      const vaultId = typeof body.vaultId === "string" ? body.vaultId.trim() : "";
      const tokenHash = await hashToken(token);
      const claimed = await this.configStorage.claim(tokenHash);
      if (!claimed) {
        return json({ error: "already_claimed" }, 403);
      }

      let claimedConfig = null;
      try {
        claimedConfig = await this.configStorage.readConfig();
      } catch (err) {
        console.warn(`${LOG_PREFIX} config fetch failed after claim:`, err);
      }

      return json({
        ok: true,
        host: url.origin,
        obsidianUrl: buildObsidianSetupUrl(url.origin, token, vaultId || undefined),
        capabilities: getCapabilities({ mode: "claim", claimed: true, tokenHash }, this.s3Storage, claimedConfig),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/update-metadata") {
      const token = getHttpAuthToken(req);
      if (!authState.claimed) {
        return withCors(json({ error: "unclaimed" }, 503));
      }
      if (authState.mode === "env" && !authState.envToken) {
        return withCors(json({ error: "server_misconfigured" }, 503));
      }
      if (!(await this.isAuthorized(authState, token))) {
        return withCors(json({ error: "unauthorized" }, 401));
      }

      let body: {
        updateProvider?: unknown;
        updateRepoUrl?: unknown;
        updateRepoBranch?: unknown;
      } = {};
      try {
        body = await req.json() as typeof body;
      } catch {
        return withCors(json({ error: "invalid json" }, 400));
      }

      let updatedConfig;
      try {
        updatedConfig = await this.configStorage.updateMetadata(body);
      } catch (err) {
        const message = err instanceof Error ? err.message : "metadata write failed";
        const status = message.includes("(403)")
          ? 403
          : message.includes("(400)")
            ? 400
            : 500;
        return withCors(json({ error: message }, status));
      }

      return withCors(json({
        ok: true,
        capabilities: getCapabilities(authState, this.s3Storage, updatedConfig),
      }));
    }

    const syncRoute = parseSyncPath(url.pathname);

    if (syncRoute) {
      return this.handleSyncRoute(req, server, url, syncRoute.vaultId, authState);
    }

    const vaultRoute = parseVaultPath(url.pathname);
    if (!vaultRoute) {
      return withCors(json({ error: "not found" }, 404));
    }

    return this.handleVaultRoute(req, url, vaultRoute.vaultId, vaultRoute.rest, authState);
  }

  private async handleSyncRoute(
    req: Request,
    server: BunServerType<WebSocketData>,
    url: URL,
    vaultId: string,
    authState: AuthState
  ): Promise<Response> {
    const token = getSocketAuthToken(req);
    const clientSchema = parseClientSchemaVersion(url);

    // Check all rejection conditions first
    let rejection: { code: FatalAuthCode; details: Record<string, unknown> } | null = null;

    if (!authState.claimed) {
      await this.recordVaultTrace(vaultId, "ws-rejected", { reason: "unclaimed" });
      rejection = { code: "unclaimed", details: {} };
    } else if (authState.mode === "env" && !authState.envToken) {
      await this.recordVaultTrace(vaultId, "ws-rejected", { reason: "server_misconfigured" });
      rejection = { code: "server_misconfigured", details: {} };
    } else if (!(await this.isAuthorized(authState, token))) {
      await this.recordVaultTrace(vaultId, "ws-rejected", { reason: "unauthorized" });
      rejection = { code: "unauthorized", details: {} };
    } else if (!clientSchema) {
      await this.recordVaultTrace(vaultId, "ws-rejected", {
        reason: "update_required",
        detail: "invalid_client_schema",
        rawSchema: url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema") ?? null,
      });
      rejection = {
        code: "update_required",
        details: {
          reason: "invalid_client_schema",
          clientSchemaVersion: null,
          roomSchemaVersion: null,
        },
      };
    } else {
      const roomSchemaVersion = await this.fetchVaultSchemaVersion(vaultId);
      if (roomSchemaVersion !== null && clientSchema.version < roomSchemaVersion) {
        await this.recordVaultTrace(vaultId, "ws-rejected", {
          reason: "update_required",
          detail: "client_schema_older_than_room",
          clientSchemaVersion: clientSchema.version,
          clientSchemaSource: clientSchema.source,
          roomSchemaVersion,
        });
        rejection = {
          code: "update_required",
          details: {
            reason: "client_schema_older_than_room",
            clientSchemaVersion: clientSchema.version,
            roomSchemaVersion,
          },
        };
      }
    }

    // Handle rejection
    if (rejection) {
      if (isWebSocketRequest(req)) {
        // For WebSocket: upgrade with rejection data, handleWebSocketOpen will send frames
        const success = server.upgrade(req, {
          data: {
            roomId: vaultId,
            authorized: false,
            socketId: crypto.randomUUID(),
            rejection,
          } as WebSocketData,
        });
        if (success) {
          return new Response(null, { status: 101 });
        }
        return json({ error: "websocket upgrade failed" }, 500);
      } else {
        // For HTTP: return appropriate error response
        return withCors(rejectSocket(req, rejection.code, rejection.details));
      }
    }

    // Success - proceed with connection
    await this.recordVaultTrace(vaultId, "ws-connected", {
      userAgent: req.headers.get("user-agent") ?? undefined,
      clientSchemaVersion: clientSchema!.version,
      clientSchemaSource: clientSchema!.source,
      roomSchemaVersion: await this.fetchVaultSchemaVersion(vaultId),
    });

    if (isWebSocketRequest(req)) {
      // Upgrade the WebSocket for successful connection
      const success = server.upgrade(req, {
        data: {
          roomId: vaultId,
          authorized: true,
          socketId: crypto.randomUUID(),
        } as WebSocketData,
      });
      if (success) {
        return new Response(null, { status: 101 });
      }
      return json({ error: "websocket upgrade failed" }, 500);
    }

    return withCors(json({ error: "websocket required" }, 426));
  }

  private async handleVaultRoute(
    req: Request,
    url: URL,
    vaultId: string,
    rest: string[],
    authState: AuthState
  ): Promise<Response> {
    const token = getHttpAuthToken(req);

    if (!authState.claimed) {
      await this.recordVaultTrace(vaultId, "http-rejected", {
        reason: "unclaimed",
        method: req.method,
        path: url.pathname,
      });
      return withCors(json({ error: "unclaimed" }, 503));
    }

    if (authState.mode === "env" && !authState.envToken) {
      await this.recordVaultTrace(vaultId, "http-rejected", {
        reason: "server_misconfigured",
        method: req.method,
        path: url.pathname,
      });
      return withCors(json({ error: "server_misconfigured" }, 503));
    }

    if (!(await this.isAuthorized(authState, token))) {
      await this.recordVaultTrace(vaultId, "http-unauthorized", {
        method: req.method,
        path: url.pathname,
      });
      return withCors(json({ error: "unauthorized" }, 401));
    }

    const [resource, ...resourceRest] = rest;
    if (!resource) {
      return withCors(json({ error: "not found" }, 404));
    }

    if (resource === "debug" && req.method === "GET" && resourceRest[0] === "recent") {
      const room = await this.roomManager.getOrCreateRoom(vaultId);
      const result = await room.handleHttp("GET", "/__yaos/debug");
      return withCors(json(result));
    }

    if (resource === "blobs") {
      return this.handleBlobRoute(req, vaultId, resourceRest);
    }

    if (resource === "snapshots") {
      return this.handleSnapshotRoute(req, vaultId, resourceRest);
    }

    return withCors(json({ error: "not found" }, 404));
  }

  private async handleBlobRoute(
    req: Request,
    vaultId: string,
    rest: string[]
  ): Promise<Response> {
    if (!this.s3Storage) {
      return withCors(json({ error: "attachments_unavailable" }, 503));
    }

    if (req.method === "POST" && rest[0] === "exists") {
      return this.handleBlobExists(req, vaultId);
    }

    const hash = rest[0];
    if (!hash) {
      return withCors(json({ error: "not found" }, 404));
    }

    if (req.method === "PUT" && rest.length === 1) {
      return this.handleBlobUpload(req, vaultId, hash);
    }

    if (req.method === "GET" && rest.length === 1) {
      return this.handleBlobDownload(vaultId, hash);
    }

    return withCors(json({ error: "not found" }, 404));
  }

  private async handleBlobExists(req: Request, vaultId: string): Promise<Response> {
    let body: { hashes?: string[] };
    try {
      body = await req.json() as { hashes?: string[] };
    } catch {
      return withCors(json({ error: "invalid json" }, 400));
    }

    if (!Array.isArray(body.hashes)) {
      return withCors(json({ error: "missing hashes array" }, 400));
    }

    const hashes = body.hashes
      .slice(0, EXISTS_BATCH_LIMIT)
      .filter((hash): hash is string => typeof hash === "string" && isValidHash(hash));

    const present: string[] = [];
    for (const hash of hashes) {
      const key = `v1/${vaultId}/blobs/${hash}`;
      const object = await this.s3Storage!.head(key);
      if (object) {
        present.push(hash);
      }
    }

    return withCors(json({ present }));
  }

  private async handleBlobUpload(req: Request, vaultId: string, hash: string): Promise<Response> {
    if (!isValidHash(hash)) {
      return withCors(json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400));
    }

    const body = await req.arrayBuffer();
    if (!body.byteLength) {
      return withCors(json({ error: "missing request body" }, 400));
    }
    if (body.byteLength > MAX_BLOB_UPLOAD_BYTES) {
      return withCors(json({
        error: `contentLength exceeds max upload size (${MAX_BLOB_UPLOAD_BYTES} bytes)`,
      }, 413));
    }

    const key = `v1/${vaultId}/blobs/${hash}`;
    await this.s3Storage!.put(key, new Uint8Array(body), {
      contentType: req.headers.get("Content-Type") ?? "application/octet-stream",
    });

    return withCors(new Response(null, { status: 204 }));
  }

  private async handleBlobDownload(vaultId: string, hash: string): Promise<Response> {
    if (!isValidHash(hash)) {
      return withCors(json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400));
    }

    const key = `v1/${vaultId}/blobs/${hash}`;
    const object = await this.s3Storage!.get(key);
    if (!object || !object.body) {
      return withCors(json({ error: "not found" }, 404));
    }

    const headers = new Headers({
      "Cache-Control": "no-store",
    });
    if (object.contentType) {
      headers.set("Content-Type", object.contentType);
    } else {
      headers.set("Content-Type", "application/octet-stream");
    }

    return withCors(new Response(object.body as ReadableStream<Uint8Array>, { headers }));
  }

  private async handleSnapshotRoute(
    req: Request,
    vaultId: string,
    rest: string[]
  ): Promise<Response> {
    const { listSnapshots, getSnapshotPayload, createSnapshot } = await import("./snapshot");

    if (req.method === "POST" && rest.length === 0) {
      let body: { device?: string } = {};
      try {
        body = await req.json() as { device?: string };
      } catch {
        body = {};
      }

      const result = await this.createSnapshotFromLiveDoc(vaultId, body.device);
      if (result.status === "unavailable") {
        return withCors(json(result));
      }
      await this.recordVaultTrace(vaultId, "snapshot-created-manual", {
        snapshotId: result.snapshotId,
        triggeredBy: body.device,
      });
      return withCors(json(result));
    }

    if (req.method === "POST" && rest[0] === "maybe" && rest.length === 1) {
      let body: { device?: string } = {};
      try {
        body = await req.json() as { device?: string };
      } catch {
        body = {};
      }

      const room = await this.roomManager.getOrCreateRoom(vaultId);
      const result = await room.handleHttp("POST", "/__yaos/snapshot-maybe", body) as SnapshotResult;
      await this.recordVaultTrace(vaultId, "snapshot-created", {
        status: result.status,
        snapshotId: result.snapshotId,
        triggeredBy: body.device,
      });
      return withCors(json(result));
    }

    if (req.method === "GET" && rest.length === 0) {
      if (!this.s3Storage) {
        return withCors(json({ error: "snapshots_unavailable" }, 503));
      }

      const snapshots = await listSnapshots(vaultId, this.s3Storage);
      return withCors(json({ snapshots }));
    }

    if (req.method === "GET" && rest.length === 1) {
      if (!this.s3Storage) {
        return withCors(json({ error: "snapshots_unavailable" }, 503));
      }

      const snapshotId = rest[0];
      if (!snapshotId) {
        return withCors(json({ error: "missing_snapshot_id" }, 400));
      }

      const result = await getSnapshotPayload(vaultId, snapshotId, this.s3Storage);
      if (!result) {
        return withCors(json({ error: "not found" }, 404));
      }

      return withCors(new Response(result.payload, {
        headers: {
          "Content-Type": "application/gzip",
          "Cache-Control": "no-store",
          "X-YAOS-Snapshot-Day": result.index.day,
        },
      }));
    }

    return withCors(json({ error: "not found" }, 404));
  }

  private async createSnapshotFromLiveDoc(
    vaultId: string,
    triggeredBy?: string,
  ): Promise<SnapshotResult> {
    if (!this.s3Storage) {
      return {
        status: "unavailable",
        reason: "S3 storage not configured",
      };
    }

    const { createSnapshot, hasSnapshotForDay } = await import("./snapshot");
    const room = await this.roomManager.getOrCreateRoom(vaultId);
    const documentResult = await room.handleHttp("GET", "/__yaos/document");
    
    if (!documentResult || !(documentResult instanceof Uint8Array)) {
      return {
        status: "unavailable",
        reason: "Failed to get document",
      };
    }

    const doc = new Y.Doc();
    try {
      if (documentResult.byteLength > 0) {
        Y.applyUpdate(doc, documentResult);
      }

      const currentDay = new Date().toISOString().slice(0, 10);
      if (await hasSnapshotForDay(vaultId, currentDay, this.s3Storage)) {
        return {
          status: "noop",
          reason: `Snapshot already taken today (${currentDay})`,
        };
      }

      const index = await createSnapshot(doc, vaultId, this.s3Storage, triggeredBy);
      return {
        status: "created",
        snapshotId: index.snapshotId,
        index,
      };
    } finally {
      doc.destroy();
    }
  }

  private async fetchVaultSchemaVersion(vaultId: string): Promise<number | null> {
    try {
      const room = await this.roomManager.getOrCreateRoom(vaultId);
      const metaResult = await room.handleHttp("GET", "/__yaos/meta");
      
      if (metaResult && typeof metaResult === "object" && "meta" in metaResult) {
        const meta = (metaResult as { meta?: { schemaVersion?: unknown } }).meta;
        if (meta && typeof meta.schemaVersion === "number") {
          return meta.schemaVersion;
        }
      }

      const documentResult = await room.handleHttp("GET", "/__yaos/document");
      if (documentResult && documentResult instanceof Uint8Array) {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, documentResult);
          const stored = doc.getMap("sys").get("schemaVersion");
          if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
            return stored;
          }
        } finally {
          doc.destroy();
        }
      }
      
      return null;
    } catch (err) {
      console.warn(`${LOG_PREFIX} schema probe failed:`, err);
      return null;
    }
  }

  private async recordVaultTrace(
    vaultId: string,
    event: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const room = await this.roomManager.getOrCreateRoom(vaultId);
      await room.handleHttp("POST", "/__yaos/trace", { event, data });
    } catch (err) {
      console.warn(`${LOG_PREFIX} trace write failed:`, err);
    }
  }

  private async handleWebSocketOpen(ws: ServerWebSocket<WebSocketData>): Promise<void> {
    const { roomId, authorized, socketId, rejection } = ws.data;

	if (!authorized && rejection) {
		// Send auth error frames before closing.
		const payload = JSON.stringify({ type: "error", code: rejection.code, ...rejection.details });

      // Send plain JSON frame first (for generic websocket clients/tests)
      ws.send(payload);

      // Send control frame with __YPS: prefix (y-partyserver compatibility)
      ws.send(`__YPS:${payload}`);

      // Close with appropriate code and reason
      const closeReason = rejection.code === "unauthorized"
        ? "unauthorized"
        : rejection.code === "update_required"
          ? "update required"
          : rejection.code === "unclaimed"
            ? "server unclaimed"
            : "server misconfigured";

      ws.close(1008, closeReason);
      return;
    }

    const room = await this.roomManager.getOrCreateRoom(roomId);

    // Create a WebSocket adapter that bridges Bun's ServerWebSocket to our Room's expected interface
    const socketAdapter = new BunWebSocketAdapter(ws);

    // Register in global registry for message routing
    const entry: RoomSocketEntry = { room, socket: socketAdapter };
    socketRegistry.set(socketId, entry);

    // Hand off to Room
    await room.handleWebSocket(socketAdapter);
  }

  private handleWebSocketMessage(ws: ServerWebSocket<WebSocketData>, message: string | Buffer): void {
    const { socketId } = ws.data;
    const entry = socketRegistry.get(socketId);

    if (!entry) {
      console.warn(`${LOG_PREFIX} Received message for unknown socket: ${socketId}`);
      return;
    }

    const { room, socket } = entry;

    // Convert message to Uint8Array and pass to YPartyServer
    let data: Uint8Array;
    if (typeof message === "string") {
      // String messages are handled separately (like __YPS:)
      console.log(`${LOG_PREFIX} Received string message: ${message.slice(0, 100)}`);
      return;
    } else {
      data = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    }

    // Pass to YPartyServer for handling
    room.yPartyServer.handleMessage(data, socket);
  }

  private handleWebSocketClose(ws: ServerWebSocket<WebSocketData>): void {
    const { socketId } = ws.data;
    const entry = socketRegistry.get(socketId);

    if (entry) {
      const { room, socket } = entry;
      room.yPartyServer.removeConnection(socket);
      socket.dispatchClose();
      socketRegistry.delete(socketId);
    }
  }
}

// WebSocket adapter that bridges Bun's ServerWebSocket to the Room's expected WebSocket interface
class BunWebSocketAdapter {
  private messageHandlers: Array<(data: Buffer) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];
  readyState = 1;

  constructor(private bunWs: ServerWebSocket<WebSocketData>) {}

  send(data: string | Uint8Array): void {
    if (this.bunWs.readyState !== 1) return;
    this.bunWs.send(data);
  }

  close(): void {
    this.bunWs.close();
  }

  on(event: "message", handler: (data: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: string, handler: ((data: Buffer) => void) | (() => void) | ((err: Error) => void)): void {
    if (event === "message") {
      this.messageHandlers.push(handler as (data: Buffer) => void);
    } else if (event === "close") {
      this.closeHandlers.push(handler as () => void);
    } else if (event === "error") {
      this.errorHandlers.push(handler as (err: Error) => void);
    }
  }

  dispatchMessage(data: Uint8Array): void {
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (const handler of this.messageHandlers) {
      try {
        handler(buffer);
      } catch (err) {
        console.error(`${LOG_PREFIX} Error in message handler:`, err);
      }
    }
  }

  dispatchClose(): void {
    this.readyState = 3;
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch (err) {
        console.error(`${LOG_PREFIX} Error in close handler:`, err);
      }
    }
  }

  dispatchError(err: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(err);
      } catch (e) {
        console.error(`${LOG_PREFIX} Error in error handler:`, e);
      }
    }
  }
}

export default YaosServer;
