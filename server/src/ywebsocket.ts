// y-partyserver compatible WebSocket server implementation for Bun
// Exactly matches y-partyserver behavior

import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import type { Awareness } from "y-protocols/awareness";

// Message types (matching y-partyserver)
const messageSync = 0;
const messageAwareness = 1;

// WebSocket ready states
const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

interface WebSocketLike {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

/**
 * Read a sync message from decoder and write response to encoder
 * Returns the sync message type for tracking
 */
function readSyncMessage(
  decoder: decoding.Decoder,
  encoder: encoding.Encoder,
  doc: Y.Doc,
  transactionOrigin: unknown,
  readOnly = false
): number {
  const messageType = decoding.readVarUint(decoder);
  switch (messageType) {
    case syncProtocol.messageYjsSyncStep1:
      syncProtocol.readSyncStep1(decoder, encoder, doc);
      break;
    case syncProtocol.messageYjsSyncStep2:
      if (!readOnly) {
        syncProtocol.readSyncStep2(decoder, doc, transactionOrigin);
      }
      break;
    case syncProtocol.messageYjsUpdate:
      if (!readOnly) {
        syncProtocol.readUpdate(decoder, doc, transactionOrigin);
      }
      break;
    default:
      throw new Error("Unknown sync message type");
  }
  return messageType;
}

/**
 * Send message to connection if ready
 */
function send(conn: WebSocketLike, message: Uint8Array): void {
  if (
    conn.readyState !== undefined &&
    conn.readyState !== wsReadyStateConnecting &&
    conn.readyState !== wsReadyStateOpen
  ) {
    return;
  }
  try {
    conn.send(message);
  } catch {}
}

export class YPartyServer {
  private doc: Y.Doc;
  private awareness: Awareness;
  private clients = new Map<WebSocketLike, boolean>();
  private roomId: string;

  constructor(roomId: string, doc: Y.Doc) {
    this.roomId = roomId;
    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalState(null);

    // Stop the check interval to prevent memory leaks
    clearInterval(this.awareness._checkInterval);

    // Set up document update handler to broadcast to all clients
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      this.broadcast(message);
    });

    // Set up awareness update handler
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changedClients = added.concat(updated, removed);
        if (changedClients.length === 0) return;

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
        );
        const buff = encoding.toUint8Array(encoder);
        this.broadcast(buff);
      }
    );
  }

  addConnection(socket: WebSocketLike): void {
    this.clients.set(socket, true);

    // Send sync step 1 to client (same as y-partyserver's onConnect)
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    send(socket, encoding.toUint8Array(encoder));

    // Send awareness states if any exist
    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          Array.from(awarenessStates.keys())
        )
      );
      send(socket, encoding.toUint8Array(awarenessEncoder));
    }
  }

  removeConnection(socket: WebSocketLike): void {
    this.clients.delete(socket);
  }

  handleMessage(message: Uint8Array | ArrayBuffer, socket: WebSocketLike): void {
    // Convert to Uint8Array if needed
    let uint8Array: Uint8Array;
    if (message instanceof Uint8Array) {
      uint8Array = message;
    } else if (message instanceof ArrayBuffer) {
      uint8Array = new Uint8Array(message);
    } else {
      // Handle ArrayBufferView
      const view = message as ArrayBufferView;
      uint8Array = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }

    try {
      const encoder = encoding.createEncoder();
      const decoder = decoding.createDecoder(uint8Array);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case messageSync: {
          // Read sync message and generate response
          encoding.writeVarUint(encoder, messageSync);
          readSyncMessage(decoder, encoder, this.doc, socket, false);

          // Send response if there's data
          if (encoding.length(encoder) > 1) {
            send(socket, encoding.toUint8Array(encoder));
          }
          break;
        }

        case messageAwareness: {
          // Read awareness update
          const awarenessData = decoding.readVarUint8Array(decoder);

          // Apply to local awareness
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            awarenessData,
            socket
          );

          // Broadcast to all other connections (including sender, like y-partyserver does)
          const awarenessEncoder = encoding.createEncoder();
          encoding.writeVarUint(awarenessEncoder, messageAwareness);
          encoding.writeVarUint8Array(awarenessEncoder, awarenessData);
          const awarenessBuff = encoding.toUint8Array(awarenessEncoder);

          for (const [conn] of this.clients) {
            send(conn, awarenessBuff);
          }
          break;
        }

        default:
          console.warn(`[y-partyserver] Unknown message type: ${messageType}`);
      }
    } catch (err) {
      console.error(`[y-partyserver] Error handling message:`, err);
    }
  }

  private broadcast(message: Uint8Array, exclude?: WebSocketLike): void {
    for (const [socket] of this.clients) {
      if (socket !== exclude && socket.readyState === 1) {
        send(socket, message);
      }
    }
  }

  getDoc(): Y.Doc {
    return this.doc;
  }

  getAwareness(): Awareness {
    return this.awareness;
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

// Re-export message types
export { messageSync, messageAwareness };
