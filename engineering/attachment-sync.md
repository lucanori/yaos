# Attachment sync: content addressing and bounded fan-out

Markdown text belongs in the CRDT. Images, PDFs, and other binary file types use a separate, content-addressed blob pipeline backed by S3-compatible object storage.

## The server blob proxy

The client hashes each file with SHA-256 and sends an authenticated `PUT` to the YAOS server. The server validates the request, forwards the bytes to object storage, and keeps blob addressing deterministic through the hash.

This keeps the client simple, avoids presigned-URL churn, and makes attachment sync work the same way on Bun, Docker, and any S3-compatible provider.

![Attachment upload lifecycle](./diagrams/attachment-upload-lifecycle-presigned-s3-flow-vs-native-worker-proxy.webp)

## Bounding blob fan-out

When checking which blobs already exist, the naive approach is unbounded `Promise.all(...)` fan-out.

YAOS uses a strict, concurrency-limited worker pool instead. That keeps large existence checks from starving the server, reduces retry storms, and leaves headroom for live sync and snapshot traffic.

## The block-level chunking trap

I really like how Dropbox and OneDrive do block-level file sync.

Imagine you had a 50 MB PDF, and you open it to read, and you make one highlight. The file is updated, so it has to be uploaded to the server. If we chunked a 50 MB PDF into many tiny blocks in object storage, we would only have to upload the modified chunks when the file changes. However, this introduces a massive architectural burden: **distributed garbage collection**.

If a user deletes or modifies that PDF, the server must track which chunks are now orphaned and which are still actively shared by other files in the vault. We would have to build a highly available reference-counting garbage collector. A single race condition in the GC would permanently corrupt users' files by deleting a chunk that is still in use.

Bandwidth is cheap; distributed garbage collection is a nightmare. Instead, YAOS uses standard last-writer-wins full file overwrites.

![Why YAOS avoids block-level chunking](./diagrams/why-yaos-avoids-block-level-chunking.webp)

## Blob sync queues

Attachment synchronization in YAOS intentionally avoids complex asynchronous scheduling in favor of a simple batch-based queue.

If a user uploads a 50 MB video and a 50 KB image in the same batch, the image file waits for the video to finish before the next batch can start.

This is a deliberate design choice prioritizing stability over maximal throughput. We did not build an asynchronous lock-free worker pool with exponential backoff and persistent state reconciliation. Those systems are notorious for introducing subtle retry and resume bugs.

Because disk writes run through a universal per-path lock, blob sync is primarily a throughput and backpressure concern, not a core text-correctness concern.

We use the network bandwidth slightly less efficiently because of batch boundaries, though:

- It does not permanently leak concurrency slots.
- It does not create race conditions between the in-memory queue and the IndexedDB persisted state.
- It does not reorder operations in a way that breaks your expected timeline.

This can be improved later if high blob I/O becomes a real problem.

## Hardened upload limits and integrity

To protect the server infrastructure and prevent accidental giant uploads from generating needless bandwidth churn, the server enforces a hard maximum upload size of 10 MB on the blob route. This matches the plugin's default attachment policy. The cap applies only to blob attachments, not to the live CRDT WebSocket stream or server-side snapshot creation.

Finally, to ensure absolute integrity of the snapshot safety net, snapshot IDs are generated using cryptographic randomness rather than predictable `Math.random()` calls.
