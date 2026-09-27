---
status: completed
created_at: 2026-04-10
updated_at: 2026-04-21
files_edited:
  - .gitignore
  - .env.example
  - .github/workflows/docker-publish.yml
  - .github/workflows/release.yml
  - .github/workflows/self-hosted-path.yml
  - .github/workflows/trigger-build.yml
  - .markdownlint.json
  - .markdownlintignore
  - Dockerfile
  - compose.yaml
  - manifest.json
  - package.json
  - build-server-release.mjs
  - bun.lock
  - README.md
  - engineering/attachment-sync.md
  - engineering/checkpoint-journal.md
  - engineering/do-hardening-implementation.md
  - engineering/do-hardening-rfc.md
  - engineering/mobile-qa-checklist.md
  - engineering/snapshots-recovery.md
  - engineering/warts-and-limits.md
  - engineering/zero-config-auth.md
  - engineering/zero-ops-update-pipeline.md
  - eslint.config.mts
  - server/.env.example
  - server/.gitignore
  - server/README.md
  - server/SELF_HOSTED.md
  - server/package.json
  - server/scripts/update-from-release.mjs
  - server/src/bun.ts
  - server/src/concurrency.ts
  - server/src/config.ts
  - server/src/db/migrate.ts
  - server/src/hex.ts
  - server/src/index.ts
  - server/src/main.ts
  - server/src/room.ts
  - server/src/roomManager.ts
  - server/src/roomMeta.ts
  - server/src/server.ts
  - server/src/snapshot.ts
  - server/src/storage/postgres.ts
  - server/src/storage/postgresConfig.ts
  - server/src/storage/postgresTrace.ts
  - server/src/storage/s3.ts
  - server/src/test/integration.ts
  - server/src/test/README.md
  - server/src/test/smoke.ts
  - server/src/test/validate.ts
  - server/src/version.ts
  - server/src/ywebsocket.ts
  - server/tsconfig.json
  - server/wrangler.toml
  - src/main.ts
  - src/settings.ts
  - src/sync/blobSync.ts
  - src/sync/vaultSync.ts
  - src/utils/concurrency.ts
  - src/types.ts
  - docker/bin/start-server.sh
  - docker/postgres/init/001-bootstrap.sql
  - tests/chunked-doc-store.ts
  - tests/hardening-worker.mjs
  - tests/schema-guard.mjs
  - tests/server-update-local.mjs
  - tests/snapshots.ts
  - tests/sync-client.ts
  - tests/trace-store.ts
  - tests/worker-integration.mjs
rationale:
  - replace the Cloudflare-specific server runtime with a self-hosted Bun server backed by PostgreSQL and S3-compatible storage
  - preserve plugin-facing HTTP and WebSocket contracts closely enough for the existing client to connect without client protocol rewrites
  - provide a Docker-based local stack for validation and self-hosted operation
  - finish the self-hosted cutover by deleting the remaining Worker and Wrangler path, aligning tests and workflows to the Bun server, and documenting both Bun-direct and Docker operation
  - normalize Docker assets to root-level project conventions and update the local stack to PostgreSQL 18
supporting_docs:
  - AGENTS.md
  - engineering/checkpoint-journal.md
  - engineering/attachment-sync.md
  - engineering/zero-config-auth.md
  - substrate/traces/research/2026-04-10-yaos-cloudflare-exit-feasibility.md
  - substrate/traces/plans/2026-04-10-self-hosted-bun-postgres-s3-migration-plan.md
  - substrate/traces/research/2026-04-21-self-hosted-completion-assessment.md
  - substrate/traces/reviews/2026-04-21-docker-base-image-vuln.md
  - substrate/traces/reviews/2026-04-21-update-script-path-traversal.md
---

# Summary of changes

Implemented a self-hosted YAOS server path based on Bun, PostgreSQL, and S3-compatible object storage.

The migration replaced the active Cloudflare-specific server path for self-hosted usage with:

- Bun HTTP and WebSocket runtime
- PostgreSQL-backed storage adapters for room data, config, and traces
- generic S3-compatible object storage adapter
- room manager and room lifecycle in process
- Docker Compose stack for local validation with PostgreSQL and external S3-compatible storage

On the plugin side, the settings and product copy were updated to stop assuming Cloudflare-specific deployment and R2 terminology.

# Technical reasoning

The most reusable seam in the original design was the chunked checkpoint-and-journal persistence engine. The implementation preserved that logic and moved the storage backend underneath it to PostgreSQL rather than redesigning CRDT persistence from scratch.

The WebSocket layer required a more invasive rewrite. The self-hosted server now implements a compatible Yjs sync path that works with the existing `y-partyserver/provider` client, including fatal auth control-frame behavior using `__YPS:` messages on rejected WebSocket connections.

Object storage was moved from Cloudflare R2 bindings to an S3-compatible adapter. This preserved the key layout used for blobs and snapshots while making the runtime portable to generic S3 providers.

The local ops stack was wired to the actual new server rather than a placeholder smoke process, with PostgreSQL available out of the box. Object storage is handled through a separate external S3-compatible provider when attachments or snapshots are needed.

# Impact assessment

## Positive impact

- removes the hard runtime dependency on Cloudflare Workers, Durable Objects, and R2 for the self-hosted path
- provides a Bun-native server runtime and self-hosted deployment workflow
- preserves the plugin client enough for the existing sync smoke client to connect and exchange state
- validates blobs and snapshots against a local S3-compatible service

## Tradeoffs and remaining caveats

- Multi-instance coordination remains a future extension point, not a required runtime dependency
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

## Update — 2026-04-21 self-hosted completion pass

### Summary of changes

Completed the remaining repository cutover from the legacy Cloudflare and Wrangler path to a self-hosted-only Bun server model.

This pass removed the old Worker entrypoints and serverless integration tests, updated workflows to validate and release the Bun server path, and refreshed primary documentation so operators now have two explicit runtime options:

- run the server locally with Bun directly;
- run the server with Docker using the tracked deployment assets under `deployment/ops/`.

### Technical reasoning

The previous migration had already made the Bun and PostgreSQL runtime functional, but the repository still contained inactive serverless implementation files, old worker-oriented tests, and stale documentation wording. Leaving those in place made the repo look dual-runtime when the product direction had already become self-hosted-first.

This completion pass therefore:

1. deleted the Worker and Wrangler runtime path;
2. updated scripts and workflows to test only the self-hosted Bun server;
3. removed obsolete package dependencies and test helpers tied to the deleted runtime;
4. aligned README and server docs with the real Docker assets and Bun-direct startup path;
5. hardened the self-hosted update script against manifest path traversal and symlink escape attacks discovered during security review.

### Impact assessment

#### Positive impact

- repository now matches the declared self-hosted product philosophy;
- primary runtime, tests, and release automation all target the Bun server path;
- local development is clearer because Bun-direct startup is documented as a first-class option;
- Docker deployment instructions now point at the real tracked deployment assets;
- the local server updater now rejects malicious traversal and symlink artifacts.

#### Tradeoffs

- the old serverless runtime is no longer available in-tree;
- some historical engineering documents still mention the prior Cloudflare architecture as archival context, not as active implementation;
- the security review generated a draft review record for the updater traversal issue, even though the follow-up re-review found the remediation effective.

### Validation

The following checks were run in this completion pass:

1. `bun run build`
2. `bun run typecheck`
3. `bun run --cwd server typecheck`
4. `bun tests/chunked-doc-store.ts`
5. `bun tests/trace-store.ts`
6. `bun tests/snapshots.ts`
7. `bun run build:server-release && bun tests/server-update-local.mjs`
8. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55433/yaos_ci_test bun run test:ci` with temporary PostgreSQL container
9. security review via `security-specialist`, followed by a remediation-specific re-review

## Update — 2026-04-21 root Docker layout and PostgreSQL 18 pass

### Summary of changes

Moved the self-hosted Docker assets to standard root-level locations and updated the default local stack to PostgreSQL 18.

This pass added root-level `Dockerfile`, `compose.yaml`, and `.env.example`, moved helper assets under `docker/`, and added a dedicated push-triggered validation workflow for the self-hosted path.

### Technical reasoning

The previous self-hosted migration worked, but Docker assets still lived under `deployment/ops/`, which made the repository feel transitional. For a normal self-hosted project, operators expect to find the main container entrypoints at the repository root.

This pass therefore:

1. moved Docker image and compose entrypoints to the root of the repository;
2. moved helper startup and PostgreSQL bootstrap assets under a conventional `docker/` directory;
3. upgraded the local stack baseline from PostgreSQL 16 to PostgreSQL 18;
4. added a dedicated push-only workflow for self-hosted validation without depending on the existing user workflows;
5. remediated a base-image vulnerability in the Dockerfile by repinning to a patched Bun Alpine digest.

### Impact assessment

#### Positive impact

- Docker usage is now discoverable at the repository root;
- self-hosted onboarding is closer to standard project expectations;
- PostgreSQL 18 is the documented and tested local baseline;
- a dedicated self-hosted path workflow now exists for push-based validation;
- the patched Bun base image cleared the previously reported HIGH vulnerability finding.

#### Tradeoffs

- existing workflow files in the working tree still reflect session edits and may be restored by the user afterward;
- older references to `deployment/ops/` in historical traces remain as history, not active setup guidance.

### Validation

The following checks were run in this pass:

1. `docker compose --env-file .env.example -f compose.yaml config`
2. `docker build -t yaos-server .`
3. `bun run build`
4. `bun run typecheck`
5. `bun run --cwd server typecheck`
6. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55434/yaos_ci_test bun run test:ci` with temporary PostgreSQL 18 container
7. `trivy image --severity HIGH,CRITICAL --ignore-unfixed` against the patched Bun base image, yielding zero HIGH or CRITICAL findings in follow-up security review

## Update — 2026-04-21 external S3 only cleanup

### Summary of changes

Removed MinIO-specific references from the default self-hosted stack and documentation, keeping object storage support generic and external.

This pass simplified the root compose stack back to app plus PostgreSQL, preserved optional generic `S3_*` support, and updated test helpers so they no longer imply MinIO-specific defaults.

### Technical reasoning

YAOS already supports generic S3-compatible storage at the application level. Bundling MinIO in the default stack and docs created unnecessary provider coupling that no longer matched the desired product direction.

This pass therefore:

1. removed the bundled MinIO and MinIO bootstrap services from `compose.yaml`;
2. removed MinIO-specific environment names from `.env.example`;
3. introduced a shared optional S3 config reader so runtime and test helpers resolve generic `S3_*` variables consistently;
4. updated docs and traces to describe external S3-compatible providers generically;
5. kept text sync working without object storage, while making attachments and snapshots clearly depend on external S3 configuration.

### Impact assessment

#### Positive impact

- no default coupling to a specific S3-compatible vendor;
- cleaner operator story for providers such as Contabo, AWS S3, Backblaze B2 S3, or others;
- compose stack is simpler and focused on the mandatory services only;
- test helpers no longer imply misleading MinIO defaults.

#### Tradeoffs

- default compose stack no longer provides a turnkey local object-storage service;
- attachments and snapshots now require explicit external S3 configuration from the operator.

### Validation

The following checks were run in this pass:

1. `bun run build`
2. `bun run typecheck`
3. `bun run --cwd server typecheck`
4. `POSTGRES_PASSWORD=foo REDIS_PASSWORD=bar docker compose config`
5. `bun run server/src/test/s3-stream.ts` to verify clean skip behavior without `S3_*`
6. `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55435/yaos_ci_test bun run test:ci` with temporary PostgreSQL 18 container
7. security review via `security-specialist`, with no real findings and no review file written

## Update — 2026-04-22 Redis removal and local compose verification

### Summary of changes

Removed Redis from the active YAOS self-hosted stack because it was not used by the runtime, then fixed and verified the local Docker Compose startup path.

This pass simplified the compose setup to app plus PostgreSQL only, removed unused Redis environment placeholders, and verified that the stack now boots locally and serves the plugin-facing capabilities endpoint.

### Technical reasoning

Redis had remained in the compose file as a legacy optional component even though the current Bun server does not read `REDIS_URL` or use Redis-backed coordination, cache, or rate limiting. Keeping it in the stack created confusion and added an unnecessary service.

During local startup verification, PostgreSQL initially failed because the service was forced to run as `user: postgres` while also using a hardened read-only container setup. The compose file was adjusted to let the official Postgres entrypoint manage its own initialization while retaining targeted hardening.

This pass therefore:

1. removed `REDIS_URL` from the app service in `compose.yaml`;
2. removed the Redis service and volume from `compose.yaml`;
3. removed `REDIS_PASSWORD` from `.env.example`;
4. updated active self-hosted docs to describe the required stack as app plus PostgreSQL, with optional external S3 only;
5. fixed the PostgreSQL service startup hardening so the compose stack can boot successfully for local verification.

### Impact assessment

#### Positive impact

- the default stack now reflects the actual runtime dependencies exactly;
- local operators have fewer moving parts to manage;
- compose-based local setup is now verified end to end;
- documentation is clearer about what is required versus optional.

#### Tradeoffs

- Redis is no longer present as a ready-made placeholder for future optional features;
- if Redis-backed functionality is introduced later, it will need to be added back intentionally with real runtime usage.

### Validation

The following checks were run in this pass:

1. `POSTGRES_PASSWORD=test docker compose config`
2. `POSTGRES_PASSWORD=test docker compose config --services`
3. `POSTGRES_PASSWORD=test docker compose config --volumes`
4. `bun run typecheck`
5. `bun run --cwd server typecheck`
6. `export POSTGRES_PASSWORD=localtest SYNC_TOKEN=local-sync-token; docker compose up -d --build`
7. `curl -fsS http://127.0.0.1:3000/api/capabilities`
8. `docker compose down -v`
9. security review via `security-specialist`, with no real findings and no review file written
