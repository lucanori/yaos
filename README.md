# YAOS

**A zero-terminal, real-time sync engine for Obsidian, powered by your own sync server.**

Your notes stay in sync instantly across devices, without conflicted copies, delayed file sync, or proprietary cloud services.

<img src="https://github.com/user-attachments/assets/ee937050-8a05-4d56-9c5f-3ae5003496fc" alt="YAOS syncing a note across desktop and mobile in real time" width="720" />

[![License: 0-BSD](https://img.shields.io/badge/license-0--BSD-green)](LICENSE)

Self-hosted, local-first, no proprietary lock-in.

## How it compares

Most ways to sync Obsidian pick a trade-off. YAOS picks none.

| | Conflicts | Real-time | Self-hosted | No terminal | Free |
|---|:---:|:---:|:---:|:---:|:---:|
| **iCloud / Dropbox** | Conflicted copies | No | No | Yes | Yes |
| **Obsidian Sync** | Rare | Delayed | No | Yes | $96/yr |
| **Git / LiveSync** | Manual | Varies | Yes | No | Yes |
| **Relay / Screengarden** | No | Yes | No | Yes | Freemium |
| **YAOS** | **None** | **Yes** | **Yes** | **No*** | **$0** |

*Self-hosted servers require minimal terminal setup. One-click hosted options coming soon.

YAOS uses [Yjs CRDTs](https://yjs.dev) to keep one live vault state moving across devices instead of asking them to take polite turns uploading files and hoping nothing collides.

If you want the official, fully managed experience, pay for Obsidian Sync and support the team. If you want a fast, self-hosted, local-first alternative that you fully control, this is YAOS.

## Get started

YAOS has two parts: an Obsidian plugin and a self-hosted sync server. You run the server yourself using [Bun](https://bun.sh), PostgreSQL, and any S3-compatible storage.

### Quick start (self-hosted)

**1. Install the plugin**

Add through [BRAT](https://github.com/TfTHacker/obsidian42-brat): open BRAT settings → **Add Beta plugin** → paste `kavinsood/yaos`.

**2. Deploy your server**

See [server/SELF_HOSTED.md](server/SELF_HOSTED.md) for complete setup instructions:

```bash
cd server
bun install
bun run db:migrate
bun run dev
```

**3. Connect your vault**

Enter your server URL and sync token in **Settings → YAOS**.

That's it. Your vault is syncing.

## Attachments and snapshots

Text sync works out of the box. To sync images, PDFs, and other attachments, configure S3-compatible object storage.

S3-compatible storage also enables daily automatic snapshots and on-demand point-in-time backups. You can browse snapshots, diff against current state, and selectively restore individual files. Without object storage, text sync still works perfectly — you just won't have attachment sync or snapshots.

## Updating your server

Because you own your infrastructure, you control when updates apply.

Updates are currently manual: pull the latest code, run migrations if needed, and restart:

```bash
cd server
git pull
bun install
bun run db:migrate
bun run dev
```

Read release notes before updating. Some releases require manual migration steps.

## Works with scripts and AI agents

Because Obsidian vaults are just local Markdown files, YAOS plays unusually well with scripts, CLI tools, and AI agents that edit files directly on disk. The CRDT state stays aligned with the filesystem, so changes from any source — git, shell scripts, agents writing to disk — propagate cleanly across devices instead of falling back to conflicted-copy workflows.

If you're building agentic workflows on top of Obsidian vaults, YAOS gives you the sync infrastructure so you don't have to wire up your own.

## How it works

YAOS keeps your vault as normal local files, while also maintaining a shared real-time state for sync.

1. Each markdown file gets a stable ID and a `Y.Text` CRDT for its content.
2. All per-file CRDTs live inside one shared vault-level `Y.Doc` — this keeps cross-file operations transactional. A folder rename is atomic across all files; the vault structure can't tear.
3. Live editor edits flow through a Yjs + CodeMirror binding.
4. Each vault maps to one server-side sync room. The shared state is persisted to PostgreSQL.
5. Offline edits are stored in IndexedDB and merge on reconnect.
6. Attachments sync separately via content-addressed S3-compatible storage instead of being forced through the text CRDT.
7. Daily and on-demand snapshots exist as a safety net.

In practice, that means your vault still exists locally as normal files, Obsidian keeps behaving like Obsidian, and YAOS keeps the disk mirror and the shared CRDT state aligned instead of asking devices to take polite turns uploading files later.

## Engineering

This repository keeps deep architecture notes under [`engineering/`](./engineering). These capture the design rationale, trade-offs, and failure modes behind a production CRDT sync engine.

- **[Monolithic vault CRDT](./engineering/monolith.md)** — Why one vault-level `Y.Doc`, what we gain (ACID cross-file transactions), and what we consciously trade off.
- **[Filesystem bridge](./engineering/filesystem-bridge.md)** — How noisy Obsidian file events are converted into safe CRDT updates with dirty-set draining and content-acknowledged suppression.
- **[Checkpoint + journal persistence](./engineering/checkpoint-journal.md)** — The storage-engine rewrite that removed full-state rewrites and introduced state-vector-anchored delta journaling.
- **[Attachment sync](./engineering/attachment-sync.md)** — Native Worker proxy uploads, capability negotiation, and bounded fan-out under Cloudflare connection limits.
- **[Zero-config auth](./engineering/zero-config-auth.md)** — Browser claim UX, `obsidian://yaos` deep-link pairing, and env-token override behavior.
- **[Zero-ops update pipeline](./engineering/zero-ops-update-pipeline.md)** — Why detached deploy repos need bootstrap injection, reusable workflows, and migration safety gates.
- **[Warts and limits](./engineering/warts-and-limits.md)** — Canonical limits, safety invariants, and the pragmatic compromises currently in production.

## Limits

YAOS is optimized for personal or small-team note vaults, not for arbitrarily huge text archives. The monolithic `Y.Doc` design gives excellent real-time ergonomics and simpler cross-file behavior, but it creates a practical ceiling for very large vaults.

If your vault is normal notes, drafts, research, and attachments, YAOS is a great fit. If you want to sync giant text dumps or archival datasets, a simpler file-sync tool is a better choice.

Rule of thumb: around 50 MB of raw text (not counting attachments like images and PDFs) is a comfortable target.

## Configuration

After enabling, go to **Settings → YAOS**.

| Setting | Description |
|---------|-------------|
| **Server URL** | Your Worker URL (e.g. `https://sync.yourdomain.com`) |
| **Sync token** | Filled automatically by the setup link after claiming |
| **Device name** | Shown to other devices in live cursors and presence |
| **Exclude paths** | Comma-separated prefixes to skip (e.g. `templates/, .trash/`) |
| **Max text file size** | Skip text files larger than this for live document sync |
| **Sync attachments** | Enable S3-compatible storage for images, PDFs, and other non-markdown files |
| **Max attachment size** | Skip attachments larger than this (default 10 MB) |
| **Parallel transfers** | Number of simultaneous attachment upload/download slots |
| **Show remote cursors** | Display cursor positions and selections from other devices |
| **Edits from other apps** | Control how YAOS handles changes from git, scripts, or other editors |
| **Debug logging** | Verbose console output for troubleshooting |

`Manual connection` and `Advanced` sections are available in the settings UI when you need to inspect or override connection details.

## Commands

Access via command palette (Ctrl/Cmd+P):

| Command | Description |
|---------|-------------|
| **Reconnect to sync server** | Force reconnect after network changes |
| **Force reconcile** | Re-merge disk state with CRDT |
| **Show sync debug info** | Connection state, file counts, queue status |
| **Take snapshot now** | Create an immediate backup to object storage |
| **Browse and restore snapshots** | View snapshots, diff against current state, selective restore |
| **Reset local cache** | Clear IndexedDB, re-sync from server |
| **Nuclear reset** | Wipe all CRDT state everywhere, re-seed from disk |

## Troubleshooting

**"Unauthorized" errors**: Token mismatch between plugin and server. Check both match exactly.

**"S3 not configured"**: The server doesn't have S3-compatible storage configured. See [server/SELF_HOSTED.md](server/SELF_HOSTED.md).

**Sync stops on mobile**: Use "Reconnect to sync server" command. Check you have network connectivity.

**Files not syncing**: Check exclude patterns. Files over max size are skipped. Use debug logging to see what's happening, and then raise an issue on GitHub.

**Conflicts after offline edits**: CRDTs merge automatically but the result depends on operation order. Review merged content if needed.

## License

[0-BSD](LICENSE)
