# YAOS self-hosted server

Self-hosted server implementation for YAOS (Yet Another Obsidian Sync) using Bun runtime, PostgreSQL for primary storage, and external S3-compatible object storage.

## Run locally with Bun

### Prerequisites

1. **Bun** - Install from [bun.sh](https://bun.sh)
2. **PostgreSQL** - Version 18 recommended
3. **S3-compatible storage** - Optional external service for attachments and snapshots

### Installation

```bash
bun install

cp .env.example .env
# Edit .env with your configuration

bun run db:migrate

bun run dev
```

## Run with Docker

Use the tracked Docker assets from the repository root.

```bash
# From the repo root
cp .env.example .env
docker build -t yaos-server .
docker run --env-file .env -p 3000:3000 yaos-server
```

Or start the full stack with compose:

```bash
cp .env.example .env
docker compose up -d --build
```

The compose stack covers app and database layers only. Text sync works without object storage; configure an external S3-compatible provider if you want attachments or snapshots.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Server port (default: 3000) |
| `SYNC_TOKEN` | No | Pre-configured auth token |
| `S3_ENDPOINT` | No | S3-compatible endpoint URL |
| `S3_BUCKET` | No | S3 bucket name |
| `S3_ACCESS_KEY_ID` | No | S3 access key |
| `S3_SECRET_ACCESS_KEY` | No | S3 secret key |
| `S3_REGION` | No | S3 region (default: us-east-1) |

## API compatibility

This server maintains compatibility with the plugin-facing API:

- WebSocket sync at `/vault/sync/{vaultId}`
- HTTP endpoints for blobs, snapshots, capabilities
- CORS headers for browser-based access
- Same authentication flow (claim or env token)

## Architecture

### Storage layer

- **PostgreSQLStorage**: Implements chunked document storage, checkpoints, and journals
- **PostgresTraceStorage**: Stores trace/debug events
- **PostgresConfigStorage**: Server configuration and claim state
- **S3Storage**: Blob and snapshot storage

### Room management

- **RoomManager**: Manages room lifecycle with LRU eviction
- **Room**: Handles WebSocket connections, Yjs document sync, and persistence

### HTTP server

- **BunServer**: Bun-native HTTP and WebSocket server
- Route handlers for all plugin-facing endpoints

## Database schema

### yaos_storage

Room-scoped key-value storage for document checkpoints and journals.

### yaos_config

Global server configuration (claim status, token hash, update metadata).

### yaos_traces

Time-series trace events for debugging and monitoring.

## Known gaps

1. **WebSocket protocol**: Custom implementation may have subtle differences from `y-partyserver`.
2. **Room persistence**: Rooms stay in memory; no built-in hibernation or clustering.
3. **Rate limiting**: Not implemented; add a reverse proxy like nginx or Caddy.
4. **Geographic distribution**: Single-node deployment; no edge distribution.
5. **Background jobs**: No cron-based snapshot scheduling.
6. **Metrics**: No built-in metrics or monitoring beyond trace logs.

## Development

```bash
# Type checking
bun run typecheck

# Start production server
bun run start
```

## Deployment

### Systemd

Create a systemd service for running as a system service.

## License

Same as main YAOS project.
