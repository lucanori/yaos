---
status: completed
created_at: 2026-04-10
files_edited:
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - .github/workflows/yaos-ops-reusable.yml
  - .gitignore
  - README.md
  - build-server-release.mjs
  - engineering/warts-and-limits.md
  - package.json
  - version-bump.mjs
  - bun.lock
  - server/.gitignore
  - server/.gitlab-ci.yml
  - server/README.md
  - server/SELF_HOSTED.md
  - server/package.json
  - server/bun.lock
  - server/src/test/README.md
  - tests/diff-regressions.mjs
  - tests/worker-integration.mjs
  - package-lock.json
  - server/package-lock.json
rationale:
  - remove legacy npm-first workflow assumptions and make Bun the primary package manager and script runner across root and server
  - keep Obsidian plugin build/release behavior intact while switching development, CI, and release tooling to Bun
supporting_docs:
  - AGENTS.md
  - README.md
  - server/README.md
  - server/SELF_HOSTED.md
  - substrate/traces/operations/2026-04-10-self-hosted-migration-implementation.md
---

# Summary of changes

Completed the toolchain migration from mixed npm/Bun support to a Bun-first repository workflow.

The migration removed tracked npm lockfiles, started tracking Bun lockfiles, converted root scripts to Bun by default, and updated CI and helper scripts accordingly.

Documentation was also updated so repository instructions now describe Bun-based development and the self-hosted server path instead of npm- and Cloudflare-first flows.

# Technical reasoning

Obsidian does not require npm at runtime. The plugin only needs release artifacts such as `main.js`, `manifest.json`, and optional `styles.css`. Because npm is only a build-time tool choice, the repository can safely standardize on Bun as long as the generated artifacts and release semantics remain unchanged.

The migration therefore targeted:

- script entrypoints in `package.json`
- lockfile policy in `.gitignore`
- release packaging helpers such as `build-server-release.mjs`
- version-bump logic that previously depended on npm environment conventions
- CI workflows that previously used Node-specific setup steps
- Bun compatibility fixes in a small number of test files

# Impact assessment

## Positive impact

- a single package manager and script runner across root and server
- tracked `bun.lock` and `server/bun.lock` for reproducible installs
- removal of tracked `package-lock.json` files
- CI workflows aligned with the Bun toolchain
- working Bun-based plugin build, worker integration tests, and regression tests

## Remaining caveats

- some plugin/server product files changed earlier during the self-hosted migration and remain part of the working tree
- the self-hosted integration test still requires PostgreSQL when run
- `build:server-release` still depends on version consistency between `server/package.json` and `server/src/version.ts`

# Validation steps

The following checks were run after the Bun-only migration:

1. `bun install --frozen-lockfile` at repository root
2. `cd server && bun install --frozen-lockfile`
3. `bun run build`
4. `cd server && bun run typecheck`
5. `cd server && bun run validate`
6. `bun run test:integration:worker`
7. `bun run test:regressions`

All of the above completed successfully during verification.
