import { Pool, PoolClient } from "pg";

export interface StorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  transaction<T>(closure: (txn: TransactionLike) => Promise<T>): Promise<T>;
}

export interface TransactionLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

export interface PostgresStorageConfig {
  connectionString: string;
  roomId?: string;
}

export class PostgresStorage implements StorageLike {
  private pool: Pool;
  private roomId: string | null;

  constructor(config: PostgresStorageConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
    });
    this.roomId = config.roomId ?? null;
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS yaos_storage (
          room_id TEXT,
          key TEXT,
          value BYTEA,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (room_id, key)
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS yaos_storage_room_idx 
        ON yaos_storage(room_id)
      `);
    } finally {
      client.release();
    }
  }

  async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      const client = await this.pool.connect();
      try {
        const result = await client.query(
          `SELECT key, value FROM yaos_storage 
           WHERE room_id = $1 AND key = ANY($2)`,
          [this.roomId ?? "global", keyOrKeys]
        );
        const map = new Map<string, T>();
        for (const row of result.rows) {
          map.set(row.key, this.deserialize(row.value) as T);
        }
        return map;
      } finally {
        client.release();
      }
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT value FROM yaos_storage 
         WHERE room_id = $1 AND key = $2`,
        [this.roomId ?? "global", keyOrKeys]
      );
      if (result.rows.length === 0) return undefined;
      return this.deserialize(result.rows[0].value) as T;
    } finally {
      client.release();
    }
  }

  async put<T>(entries: Record<string, T>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [key, value] of Object.entries(entries)) {
        await client.query(
          `INSERT INTO yaos_storage (room_id, key, value, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (room_id, key) 
           DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [this.roomId ?? "global", key, this.serialize(value)]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM yaos_storage 
         WHERE room_id = $1 AND key = ANY($2)`,
        [this.roomId ?? "global", keys]
      );
      return result.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  async transaction<T>(closure: (txn: TransactionLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const txn = new PostgresTransaction(client, this.roomId ?? "global", this);
    try {
      await client.query("BEGIN");
      const result = await closure(txn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private serialize(value: unknown): Buffer {
    if (value instanceof Uint8Array) {
      return Buffer.from(value);
    }
    return Buffer.from(JSON.stringify(value));
  }

  private deserialize(buffer: Buffer): unknown {
    try {
      return JSON.parse(buffer.toString());
    } catch {
      return new Uint8Array(buffer);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresTransaction implements TransactionLike {
  private cache = new Map<string, unknown>();

  constructor(
    private client: PoolClient,
    private roomId: string,
    private storage: PostgresStorage
  ) {}

  async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      const map = new Map<string, T>();
      const uncached: string[] = [];
      
      for (const key of keyOrKeys) {
        if (this.cache.has(key)) {
          map.set(key, this.cache.get(key) as T);
        } else {
          uncached.push(key);
        }
      }

      if (uncached.length > 0) {
        const result = await this.client.query(
          `SELECT key, value FROM yaos_storage 
           WHERE room_id = $1 AND key = ANY($2)`,
          [this.roomId, uncached]
        );
        for (const row of result.rows) {
          const value = this.deserialize(row.value);
          this.cache.set(row.key, value);
          map.set(row.key, value as T);
        }
      }
      return map;
    }

    if (this.cache.has(keyOrKeys)) {
      return this.cache.get(keyOrKeys) as T;
    }

    const result = await this.client.query(
      `SELECT value FROM yaos_storage 
       WHERE room_id = $1 AND key = $2`,
      [this.roomId, keyOrKeys]
    );
    if (result.rows.length === 0) return undefined;
    const value = this.deserialize(result.rows[0].value);
    this.cache.set(keyOrKeys, value);
    return value as T;
  }

  async put<T>(entries: Record<string, T>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.client.query(
        `INSERT INTO yaos_storage (room_id, key, value, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (room_id, key) 
         DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [this.roomId, key, this.serialize(value)]
      );
      this.cache.set(key, value);
    }
  }

  async delete(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const result = await this.client.query(
      `DELETE FROM yaos_storage 
       WHERE room_id = $1 AND key = ANY($2)`,
      [this.roomId, keys]
    );
    for (const key of keys) {
      this.cache.delete(key);
    }
    return result.rowCount ?? 0;
  }

  private serialize(value: unknown): Buffer {
    if (value instanceof Uint8Array) {
      return Buffer.from(value);
    }
    return Buffer.from(JSON.stringify(value));
  }

  private deserialize(buffer: Buffer): unknown {
    try {
      return JSON.parse(buffer.toString());
    } catch {
      return new Uint8Array(buffer);
    }
  }
}
