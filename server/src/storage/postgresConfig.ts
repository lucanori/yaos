import { Pool } from "pg";

export type UpdateProvider = "github" | "gitlab" | "unknown";

export interface StoredServerConfig {
  claimed: boolean;
  tokenHash: string | null;
  updateProvider: UpdateProvider | null;
  updateRepoUrl: string | null;
  updateRepoBranch: string | null;
}

export interface PostgresConfigStorageConfig {
  connectionString: string;
}

export class PostgresConfigStorage {
  private pool: Pool;

  constructor(config: PostgresConfigStorageConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
    });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS yaos_config (
          key TEXT PRIMARY KEY,
          value JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        INSERT INTO yaos_config (key, value, updated_at)
        VALUES ('global', $1, NOW())
        ON CONFLICT (key) DO NOTHING
      `, [JSON.stringify({
        claimed: false,
        tokenHash: null,
        updateProvider: null,
        updateRepoUrl: null,
        updateRepoBranch: null,
      })]);
    } finally {
      client.release();
    }
  }

  async readConfig(): Promise<StoredServerConfig> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT value FROM yaos_config WHERE key = 'global'`
      );
      
      if (result.rows.length === 0) {
        return {
          claimed: false,
          tokenHash: null,
          updateProvider: null,
          updateRepoUrl: null,
          updateRepoBranch: null,
        };
      }

      const value = result.rows[0].value as StoredServerConfig;
      return {
        claimed: value.claimed ?? false,
        tokenHash: value.tokenHash ?? null,
        updateProvider: value.updateProvider ?? null,
        updateRepoUrl: value.updateRepoUrl ?? null,
        updateRepoBranch: value.updateRepoBranch ?? null,
      };
    } finally {
      client.release();
    }
  }

  async claim(tokenHash: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      
      const existing = await client.query(
        `SELECT value FROM yaos_config WHERE key = 'global' FOR UPDATE`
      );

      if (existing.rows.length > 0) {
        const config = existing.rows[0].value as StoredServerConfig;
        if (config.claimed && config.tokenHash) {
          await client.query("ROLLBACK");
          return false;
        }
      }

      await client.query(
        `INSERT INTO yaos_config (key, value, updated_at)
         VALUES ('global', $1, NOW())
         ON CONFLICT (key) 
         DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify({
          claimed: true,
          tokenHash,
          updateProvider: null,
          updateRepoUrl: null,
          updateRepoBranch: null,
        })]
      );

      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updateMetadata(metadata: {
    updateProvider?: unknown;
    updateRepoUrl?: unknown;
    updateRepoBranch?: unknown;
  }): Promise<StoredServerConfig> {
    const client = await this.pool.connect();
    try {
      const updateProvider = this.normalizeUpdateProvider(metadata.updateProvider);
      const updateRepoUrl = this.normalizeUpdateRepoUrl(metadata.updateRepoUrl);
      const updateRepoBranch = this.normalizeUpdateRepoBranch(metadata.updateRepoBranch);

      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT value FROM yaos_config WHERE key = 'global' FOR UPDATE`
      );

      let current: StoredServerConfig;
      if (existing.rows.length > 0) {
        current = existing.rows[0].value as StoredServerConfig;
      } else {
        current = {
          claimed: false,
          tokenHash: null,
          updateProvider: null,
          updateRepoUrl: null,
          updateRepoBranch: null,
        };
      }

      const updated: StoredServerConfig = {
        ...current,
        ...(updateProvider !== null && { updateProvider }),
        ...(updateRepoUrl !== null && { updateRepoUrl }),
        ...(updateRepoBranch !== null && { updateRepoBranch }),
      };

      await client.query(
        `INSERT INTO yaos_config (key, value, updated_at)
         VALUES ('global', $1, NOW())
         ON CONFLICT (key) 
         DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(updated)]
      );

      await client.query("COMMIT");
      return updated;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private normalizeUpdateProvider(value: unknown): UpdateProvider | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new Error("invalid updateProvider");
    }
    const raw = value.trim().toLowerCase();
    if (!raw) return null;
    if (raw === "github" || raw === "gitlab" || raw === "unknown") {
      return raw;
    }
    throw new Error("invalid updateProvider");
  }

  private normalizeUpdateRepoUrl(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new Error("invalid updateRepoUrl");
    }
    const raw = value.trim();
    if (!raw) return null;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("invalid updateRepoUrl");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("invalid updateRepoUrl");
    }
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) {
      throw new Error("invalid updateRepoUrl");
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "").replace(/\.git$/i, "");
  }

  private normalizeUpdateRepoBranch(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new Error("invalid updateRepoBranch");
    }
    const raw = value.trim();
    if (!raw) return null;
    if (raw.length > 120) {
      throw new Error("invalid updateRepoBranch");
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes("..")) {
      throw new Error("invalid updateRepoBranch");
    }
    return raw;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
