---
status: draft
created_at: 2026-04-21
reviewer: security-specialist
target: root Docker assets and self-hosted workflow
scope: Dockerfile, compose.yaml, .env.example, docker/**, .github/workflows/self-hosted-path.yml, related docs/config refs, self-hosted update path
supporting_docs:
  - Dockerfile
  - compose.yaml
  - session trivy image scan for oven/bun:1.3.12-alpine@sha256:26d8996560ca94eab9ce48afc0c7443825553c9a851f40ae574d47d20906826d
---

## Summary

1 high finding.
Docker base image ships known HIGH CVEs.

## Scope and methodology

Reviewed root Docker assets, self-hosted workflow, and updater interactions.
Ran read-only git diff review, Trivy fs scan on repo, Semgrep on changed files, Gitleaks scan, and Trivy image scan on pinned Bun base image.

## Findings by severity

### High

- `Dockerfile:1`
  - Evidence: `trivy image --severity HIGH,CRITICAL --ignore-unfixed oven/bun:1.3.12-alpine@sha256:26d8996560ca94eab9ce48afc0c7443825553c9a851f40ae574d47d20906826d` reported 5 HIGH CVEs in `libcrypto3`, `musl`, and `zlib`.
  - Impact: attacker with path to hit affected library code in app container gets DoS at minimum; some libc/crypto CVEs can escalate to memory corruption or code execution depending on trigger path.
  - False-positive notes: exact pinned digest reproduced the findings; these are real package-level vulns in final image, not generic Dockerfile lint noise.
  - Fix: upgrade to Bun image built on patched Alpine, repin digest, rebuild, rescan.

## Remediation timeline

1. Replace Bun base image with patched digest.
2. Rebuild app image and rerun Trivy image scan.
3. Re-run self-hosted path tests.

## Validation notes

Retest with `trivy image --severity HIGH,CRITICAL --ignore-unfixed <new-bun-image>` and confirm zero HIGH/CRITICAL findings in final image.
