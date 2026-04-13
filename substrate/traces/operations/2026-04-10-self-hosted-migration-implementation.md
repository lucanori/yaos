---
status: completed
created_at: 2026-04-10
files_edited:
  - .gitignore
  - manifest.json
  - package-lock.json
  - package.json
  - server/.env.example
  - server/package.json
  - server/src/bun.ts
  - server/src/db/migrate.ts
  - server/src/hex.ts
  - server/src/main.ts
  - server/src/room.ts
  - server/src/roomManager.ts
  - server/src/roomMeta.ts
  - server/src/snapshot.ts
  - server/src/storage/postgres.ts
  - server/src/storage/postgresConfig.ts
  - server/src/storage/postgresTrace.ts
  - server/src/storage/s3.ts
  - server/src/test/integration.ts
  - server/src/test/smoke.ts
  - server/src/test/validate.ts
  - server/src/ywebsocket.ts
  - server/tsconfig.json
  - src/main.ts
  - src/settings.ts
  - src/sync/blobSync.ts
  - src/sync/vaultSync.ts
  - src/types.ts
  - deployment/ops/.env.example
  - deployment/ops/Dockerfile
  - deployment/ops/compose.yaml
  - deployment/ops/bin/start-server.sh
  - deployment/ops/postgres/init/001-bootstrap.sql
rationale:
  - replace the Cloudflare-specific server runtime with a self-hosted Bun server backed by PostgreSQL and S3-compatible storage
  - preserve plugin-facing HTTP and WebSocket contracts closely enough for the existing client to connect without client protocol rewrites
  - provide a Docker-based local stack for validation and self-hosted operation
supporting_docs:
  - AGENTS.md
  - engineering/checkpoint-journal.md
  - engineering/attachment-sync.md
  - engineering/zero-config-auth.md
  - substrate/traces/research/2026-04-10-yaos-cloudflare-exit-feasibility.md
  - substrate/traces/plans/2026-04-10-self-hosted-bun-postgres-redis-s3-migration-plan.md
---

# Summary of changes

Implemented a self-hosted YAOS server path based on Bun, PostgreSQL, and S3-compatible object storage.

The migration replaced the active Cloudflare-specific server path for self-hosted usage with:

- Bun HTTP and WebSocket runtime
- PostgreSQL-backed storage adapters for room data, config, and traces
- generic S3-compatible object storage adapter
- room manager and room lifecycle in process
- Docker Compose stack for local validation with PostgreSQL and MinIO

On the plugin side, the settings and product copy were updated to stop assuming Cloudflare-specific deployment and R2 terminology.

# Technical reasoning

The most reusable seam in the original design was the chunked checkpoint-and-journal persistence engine. The implementation preserved that logic and moved the storage backend underneath it to PostgreSQL rather than redesigning CRDT persistence from scratch.

The WebSocket layer required a more invasive rewrite. The self-hosted server now implements a compatible Yjs sync path that works with the existing `y-partyserver/provider` client, including fatal auth control-frame behavior using `__YPS:` messages on rejected WebSocket connections.

Object storage was moved from Cloudflare R2 bindings to an S3-compatible adapter. This preserved the key layout used for blobs and snapshots while making the runtime portable to generic S3 providers.

The local ops stack was wired to the actual new server rather than a placeholder smoke process, with PostgreSQL plus MinIO available out of the box and Redis remaining optional in the deployment design.

# Impact assessment

## Positive impact

- removes the hard runtime dependency on Cloudflare Workers, Durable Objects, and R2 for the self-hosted path
- provides a Bun-native server runtime and self-hosted deployment workflow
- preserves the plugin client enough for the existing sync smoke client to connect and exchange state
- validates blobs and snapshots against a local S3-compatible service

## Tradeoffs and remaining caveats

- Redis is deployment-wired but not yet used as a required runtime dependency
- the Cloudflare-specific server files remain in the repository for historical compatibility and comparison, even though the new self-hosted path is now present
- this migration was validated through focused smoke and endpoint checks rather than a full production migration rehearsal of real user data

# Validation steps

The following checks were run during verification:

1. `npm run typecheck` in `server/`
2. `npm run build` at repository root
3. `bun run src/test/validate.ts` in `server/`
4. `docker compose -f deployment/ops/compose.yaml --env-file deployment/ops/.env.example config`
5. `docker compose -f deployment/ops/compose.yaml --env-file deployment/ops/.env.example up -d --build`
6. `curl -fsS http://127.0.0.1:3000/api/capabilities`
7. real sync smoke using the existing client:
   - `YAOS_TEST_HOST="http://127.0.0.1:3000" SYNC_TOKEN="change-me-sync-token" YAOS_TEST_VAULT_ID="itest-vault" node --import jiti/register tests/sync-client.ts smoke.md "\n\nhello selfhost test"`
8. WebSocket rejection behavior using a bad token, verifying:
   - plain JSON error frame
   - `__YPS:` control frame
   - close code `1008`
9. snapshot create/list against the self-hosted server:
   - `POST /vault/itest-vault/snapshots`
   - `GET /vault/itest-vault/snapshots`
10. blob upload, existence check, and download against the self-hosted server
11. `docker compose ... down -v` cleanup after validation

No `.github/CONTRIBUTING.md` file was present in the repository at verification time.
