import { Pool } from "pg";
import type { TraceEntry } from "../traceStore";

export interface TraceStorageLike {
  list<T = unknown>(options?: {
    prefix?: string;
    reverse?: boolean;
    limit?: number;
    end?: string;
  }): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

export interface PostgresTraceStorageConfig {
  connectionString: string;
}

export class PostgresTraceStorage implements TraceStorageLike {
  private pool: Pool;

  constructor(config: PostgresTraceStorageConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
    });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS yaos_traces (
          key TEXT PRIMARY KEY,
          room_id TEXT,
          value JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS yaos_traces_key_idx 
        ON yaos_traces(key)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS yaos_traces_room_idx 
        ON yaos_traces(room_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS yaos_traces_created_idx 
        ON yaos_traces(created_at DESC)
      `);
    } finally {
      client.release();
    }
  }

  async list<T = unknown>(options?: {
    prefix?: string;
    reverse?: boolean;
    limit?: number;
    end?: string;
  }): Promise<Map<string, T>> {
    const client = await this.pool.connect();
    try {
      let query = `SELECT key, value FROM yaos_traces`;
      const params: (string | number)[] = [];
      let whereClause = "";

      if (options?.prefix) {
        whereClause = ` WHERE key LIKE $${params.length + 1}`;
        params.push(`${options.prefix}%`);
      }

      if (options?.end) {
        const operator = options.reverse ? ">" : "<";
        whereClause += whereClause ? ` AND key ${operator} $${params.length + 1}` : ` WHERE key ${operator} $${params.length + 1}`;
        params.push(options.end);
      }

      query += whereClause;

      const order = options?.reverse ? "ASC" : "DESC";
      query += ` ORDER BY key ${order}`;

      if (options?.limit) {
        query += ` LIMIT $${params.length + 1}`;
        params.push(options.limit);
      }

      const result = await client.query(query, params);
      const map = new Map<string, T>();
      
      for (const row of result.rows) {
        map.set(row.key, row.value as T);
      }

      if (options?.reverse) {
        const reversed = new Map<string, T>();
        const entries = Array.from(map.entries()).reverse();
        for (const [key, value] of entries) {
          reversed.set(key, value);
        }
        return reversed;
      }

      return map;
    } finally {
      client.release();
    }
  }

  async put<T>(key: string, value: T): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO yaos_traces (key, value, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) 
         DO UPDATE SET value = EXCLUDED.value, created_at = EXCLUDED.created_at`,
        [key, JSON.stringify(value)]
      );
    } finally {
      client.release();
    }
  }

  async delete(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM yaos_traces WHERE key = ANY($1)`,
        [keys]
      );
      return result.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  async getRecentForRoom(roomId: string, limit: number): Promise<TraceEntry[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT value FROM yaos_traces 
         WHERE room_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [roomId, limit]
      );
      return result.rows.map((row) => row.value as TraceEntry);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
