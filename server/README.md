# YAOS server

Self-hosted sync server for the YAOS Obsidian plugin. Built with Bun, PostgreSQL, and external S3-compatible storage.

## Quick start

### Run with Bun

```bash
cd server
bun install
cp .env.example .env
# Edit .env with your configuration
bun run db:migrate
bun run dev
```

### Run with Docker

Use the tracked Docker assets from the repository root:

```bash
cp .env.example .env
docker build -t yaos-server .
docker run --env-file .env -p 3000:3000 yaos-server
```

For the full stack, use `compose.yaml` from the repository root. It runs app and PostgreSQL; configure external S3-compatible storage separately if you need attachments or snapshots.

## Architecture

- One vault maps to one sync room managed in memory.
- Yjs sync runs through `y-partyserver` protocol.
- PostgreSQL persists document checkpoints and journals.
- Attachments are uploaded through the server and stored in external S3-compatible storage.
- Snapshots are gzipped CRDT archives stored in external S3-compatible storage.
- Auth uses the claimed setup token by default, with `SYNC_TOKEN` as an optional hard override.

## Development

```bash
# Type checking
bun run typecheck

# Run development server with hot reload
bun run dev

# Run tests
bun run test:integration
bun run test:smoke
```

## Endpoints

### WebSocket sync

- `wss://<host>/vault/sync/<vaultId>?token=<setup-token>`

### Blob APIs

- `POST /vault/<vaultId>/blobs/exists`
- `PUT /vault/<vaultId>/blobs/<sha256>`
- `GET /vault/<vaultId>/blobs/<sha256>`

### Snapshot APIs

- `POST /vault/<vaultId>/snapshots/maybe`
- `POST /vault/<vaultId>/snapshots`
- `GET /vault/<vaultId>/snapshots`
- `GET /vault/<vaultId>/snapshots/<snapshotId>`

### Debug

- `GET /vault/<vaultId>/debug/recent`

All HTTP endpoints require `Authorization: Bearer <setup-token>` once the server has been claimed.

If you set `SYNC_TOKEN`, that environment value becomes the required token instead.

## Operational safeguards

- Blob uploads are capped at 10 MB by default.
- Blob existence checks use bounded concurrency.
- Snapshot creation is daily-idempotent through the `/snapshots/maybe` route.
- Snapshot archives are stored compressed to keep storage usage modest.

## Deployment notes

Current server path is self-hosted first:

- **Runtime**: Bun
- **Primary storage**: PostgreSQL
- **Object storage**: External S3-compatible service for attachments and snapshots
- **WebSocket**: Native Bun WebSocket support via the server runtime

Background architecture notes live in the engineering docs.

## License

Same as main YAOS project.
