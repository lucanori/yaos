# YAOS server

Self-hosted sync server for the YAOS Obsidian plugin. Built with Bun, PostgreSQL, and S3-compatible storage.

## Quick start

```bash
cd server
bun install
cp .env.example .env
# Edit .env with your configuration
bun run db:migrate
bun run dev
```

See [SELF_HOSTED.md](./SELF_HOSTED.md) for complete documentation.

## Architecture

- One vault maps to one sync room managed in-memory.
- Yjs sync runs through `y-partyserver` protocol.
- PostgreSQL persists document checkpoints and journals.
- Attachments are uploaded through the server and stored in S3-compatible storage.
- Snapshots are gzipped CRDT archives stored in S3-compatible storage.
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

## Legacy Cloudflare Workers path

The repository retains Cloudflare Workers configuration (`wrangler.toml`, etc.) for historical reference and comparison. The active self-hosted implementation replaces the Cloudflare-specific architecture with:

- **Runtime**: Bun (instead of Cloudflare Workers)
- **Primary Storage**: PostgreSQL (instead of Durable Objects)
- **Object Storage**: Any S3-compatible service (instead of Cloudflare R2)
- **WebSocket**: Native Bun WebSocket support (instead of partyserver on Workers)

## License

Same as the main YAOS project.
