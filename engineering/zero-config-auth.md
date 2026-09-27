# Zero config onboarding

Self-hosted software usually dies at the onboarding step. Forcing a user to open a terminal, run OpenSSL to generate a 32-byte cryptographic secret, and paste it into a `.env` file guarantees a high abandonment rate.

YAOS implements a consumer-grade, zero-terminal claim flow while keeping the server self-hosted and provider-agnostic.

## The deployment migration: killing the CLI

The first version of YAOS used a hosted realtime stack. It was useful for prototyping, but it tied onboarding to a provider-specific CLI.

The current server removes that dependency. Operators run Bun directly or inside Docker, then claim the server from the browser.

This keeps onboarding simple without making the primary architecture serverless.

## The single-use claim architecture

When deployed, the YAOS server boots into an "Unclaimed" state.

- The user visits the server URL in their browser and is greeted by a lightweight, dependency-free HTML setup page.
- The browser uses `crypto.getRandomValues()` to generate a high-entropy token locally.
- The user clicks "Claim". The token is sent to the server.
- The server hashes the token (SHA-256) and stores only the hash inside a singleton config record via an ACID transaction.
- The setup route permanently locks itself.

For subsequent authentication, the plugin uses `Authorization: Bearer <token>` for HTTP endpoints.

For WebSocket sync transport, YAOS currently includes the token as a query parameter for compatibility across browser and WebView socket APIs. This is an explicit, documented compromise for v1 and should be replaced by an explicit post-connect auth handshake in a future revision.

## Current transport model (v1)

- HTTP routes (`/vault/*`, setup helpers, snapshot APIs) authenticate with `Authorization: Bearer <token>`.
- WebSocket sync (`/vault/sync/:room`) currently accepts a query token for compatibility with constrained mobile and WebView environments.
- All traffic is expected over HTTPS/WSS in normal deployment.

## Threat model notes (v1)

This compromise is acceptable for YAOS v1's current self-hosted model when:

- TLS is enabled end-to-end (HTTPS/WSS).
- Server/operator logs are private and access-controlled.
- The shared token is treated as a secret and rotated when exposed.

It is still not ideal because URL parameters can appear in application logs, browser debugging surfaces, and proxy instrumentation. For that reason, query-token auth should be treated as transitional rather than final architecture.

## Planned hardening (post-v1)

- Move WebSocket auth to an explicit post-connect handshake frame.
- Prefer short-lived session credentials derived from the long-lived setup token.
- Ensure auth material is redacted from traces and diagnostics by default.
- Add an operator option to disable query-token WebSocket auth once clients support handshake auth.

For the broader list of accepted compromises and tracked debt, see `engineering/warts-and-limits.md`.

## The URI protocol handshake

To completely eliminate the copy-paste step, the setup page generates a custom deep-link: `obsidian://yaos?action=setup&host=...&token=...`.

When clicked, the OS routes this directly to the Obsidian plugin, which intercepts the URI, configures its internal settings, and immediately boots the sync engine.

## Capability negotiation and optional storage

YAOS treats attachments and snapshots as optional. If the operator has not configured S3-compatible storage, the server reports those capabilities as unavailable and the plugin hides the related UI.

We solve this via capability negotiation:

- The default YAOS deployment provisions only the text-sync CRDT engine. It requires no object storage.
- When the Obsidian plugin connects, it performs a capability probe (`GET /api/capabilities`).
- If the server lacks object storage, it returns `{ attachments: false, snapshots: false }`.
- The plugin reads this and gracefully disables the attachment and snapshot UI. It continues to sync markdown text flawlessly.

![Capability negotiation without mandatory object storage](./diagrams/deploy-button-resilience-without-mandatory-r2.webp)

Power users who want attachment sync can add S3-compatible storage later. The server will detect the new configuration, update its capabilities, and the plugin will unlock the UI without a code change.
