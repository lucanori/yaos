# YAOS Self-Hosted Server

Self-hosted server implementation for YAOS (Yet Another Obsidian Sync) using Bun runtime, PostgreSQL for primary storage, and S3-compatible object storage.

## Migration from Cloudflare Workers

This implementation replaces the Cloudflare Workers + Durable Objects + R2 architecture with:
- **Runtime**: Bun (Node.js alternative)
- **Primary Storage**: PostgreSQL (replaces Durable Objects)
- **Object Storage**: Any S3-compatible service (replaces R2)
- **WebSocket**: Native Bun WebSocket support (replaces partyserver)

## Quick Start

### Prerequisites

1. **Bun** - Install from [bun.sh](https://bun.sh)
2. **PostgreSQL** - Version 12+ recommended
3. **S3-compatible storage** - Optional, for attachments and snapshots

### Installation

```bash
# Install dependencies
bun install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
bun run db:migrate

# Start the development server
bun run dev
```

### Environment Variables

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

## API Compatibility

This server maintains compatibility with the plugin-facing API:

- WebSocket sync at `/vault/sync/{vaultId}`
- HTTP endpoints for blobs, snapshots, capabilities
- CORS headers for browser-based access
- Same authentication flow (claim or env token)

## Architecture

### Storage Layer

- **PostgreSQLStorage**: Implements chunked document storage, checkpoints, and journals
- **PostgresTraceStorage**: Stores trace/debug events
- **PostgresConfigStorage**: Server configuration and claim state
- **S3Storage**: Blob and snapshot storage

### Room Management

- **RoomManager**: Manages room lifecycle with LRU eviction
- **Room**: Handles WebSocket connections, Yjs document sync, and persistence

### HTTP Server

- **BunServer**: Bun-native HTTP and WebSocket server
- Route handlers for all plugin-facing endpoints

## Database Schema

### yaos_storage
Room-scoped key-value storage for document checkpoints and journals.

### yaos_config
Global server configuration (claim status, token hash, update metadata).

### yaos_traces
Time-series trace events for debugging and monitoring.

## Known Gaps

1. **WebSocket Protocol**: Custom implementation may have subtle differences from y-partyserver
2. **Hibernation**: Rooms stay in memory (no equivalent to Cloudflare Durable Object hibernation)
3. **Rate Limiting**: Not implemented (add reverse proxy like nginx/caddy for rate limiting)
4. **Geographic Distribution**: Single-node deployment (no edge distribution)
5. **Background Jobs**: No cron-based snapshot scheduling
6. **Metrics**: No built-in metrics/monitoring beyond trace logs

## Development

```bash
# Type checking
bun run typecheck

# Start production server
bun run start
```

## Deployment

### Docker

A Dockerfile can be created for containerized deployment:

```dockerfile
FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --production
COPY . .
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
```

### Systemd

Create a systemd service for running as a system service.

## License

Same as the main YAOS project.
