import { YaosServer } from "./bun";
import { readOptionalS3Config } from "./s3-config";

const port = parseInt(process.env.PORT ?? "3000", 10);
const databaseUrl = process.env.DATABASE_URL;
const syncToken = process.env.SYNC_TOKEN;
const canonicalRepo = process.env.YAOS_CANONICAL_REPO;

if (!databaseUrl) {
  console.error("Error: DATABASE_URL environment variable is required");
  process.exit(1);
}

const s3Config = readOptionalS3Config();

const server = new YaosServer({
  port,
  databaseUrl,
  syncToken,
  canonicalRepo,
  s3: s3Config,
});

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nShutting down...");
  await server.stop();
  process.exit(0);
});

await server.start();
