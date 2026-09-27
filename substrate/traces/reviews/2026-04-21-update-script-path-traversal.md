---
status: draft
created_at: 2026-04-21
reviewer: security-specialist
target: self-hosted migration cleanup
scope: modified server/runtime code, update scripts, workflows, test helpers, and local self-hosted exposure changes
supporting_docs:
  - server/scripts/update-from-release.mjs
  - build-server-release.mjs
  - tests/server-update-local.mjs
  - substrate/traces/research/2026-04-21-self-hosted-completion-assessment.md
---

## Summary

1 high severity finding.

## Scope and methodology

Reviewed the modified YAOS files in this branch, with emphasis on self-hosted server runtime, release/update pipeline, and test harnesses. Ran containerized static checks with `semgrep`, `trivy`, and `gitleaks` inside `ghcr.io/digitalygo/pentest-toolbox:latest`.

## Findings by severity

### High

- `server/scripts/update-from-release.mjs:106-123` — untrusted `updateOwnedPaths` is joined directly into `extractDir`/`repoRoot` and then passed to `rmSync()`/`cpSync()`. A crafted release ZIP or manifest can use `..`/absolute paths to delete or overwrite arbitrary files as the updater user. Reject paths unless `resolve(root, relativePath)` stays under the intended root, and also block symlinks/unsafe ZIP entries before extraction.

## Remediation timeline

1. Fix updater path validation first.
2. Add a regression test with a malicious manifest path and a symlink entry.
3. Re-run release/update smoke tests against a crafted artifact.

## Validation notes

Retest by confirming the updater refuses `../` and absolute paths, preserves files outside the repo root, and still applies legitimate release artifacts.
