import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("Error: DATABASE_URL environment variable is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

async function migrate() {
  const client = await pool.connect();
  
  try {
    console.log("Running database migrations...");

    // Storage table for room data
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

    // Config table
    await client.query(`
      CREATE TABLE IF NOT EXISTS yaos_config (
        key TEXT PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Traces table
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

    // Insert default config if not exists
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

    console.log("Migrations completed successfully!");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

await migrate();
