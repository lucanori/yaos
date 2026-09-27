# Server update pipeline for self-hosted installs

Status: implemented
Owner: YAOS  
Scope: Server update lifecycle for self-hosted Bun installs

## Problem

YAOS now ships as a self-hosted server. Updates should stay simple for operators and avoid hidden platform coupling.

## Current update flow

### Bun install

```bash
cd server
git pull
bun install
bun run db:migrate
bun run dev
```

### Docker install

Rebuild the image, then restart the container with the same environment file.

```bash
# From the repository root
cp deployment/ops/.env.example deployment/ops/.env
docker build -f deployment/ops/Dockerfile -t yaos-server .
docker run --env-file deployment/ops/.env -p 3000:3000 yaos-server
```

## Constraints

- No terminal-free update magic.
- No remote self-mutation by cloud provider APIs.
- No dependency on serverless deploy flows.
- Keep update steps explicit and reversible.

## Safety gates

### Migration gate

If a release requires a manual migration, stop before restart and follow release notes.

### Compatibility guard

Server exposes compatibility metadata via `/api/capabilities`. Plugin should block only incompatible combinations.

### Metadata safety

Update metadata should be patch-based so a new device cannot wipe existing update state.

## Historical note

Older YAOS drafts used a detached deploy repo. That flow is legacy only and no longer describes the primary server path.
