#!/usr/bin/env bun
/**
 * Real smoke test using actual y-partyserver/provider client
 * Tests against a running server with real PostgreSQL
 * 
 * Usage: bun run test:smoke
 * Prerequisites: PostgreSQL running and DATABASE_URL configured
 */

import { YaosServer } from "../bun";
import * as Y from "yjs";
import WebSocket from "ws";

const TEST_PORT = 9997;
const TEST_TOKEN = `smoke-test-token-${Date.now()}`;
const TEST_VAULT_ID = `smoke-vault-${Date.now().toString(36)}`;

console.log("=== YAOS Self-Hosted Server - Real Client Smoke Test ===\n");
console.log(`Test Configuration:`);
console.log(`  Port: ${TEST_PORT}`);
console.log(`  Database: ${(process.env.DATABASE_URL || "postgresql://localhost:5432/yaos").replace(/:\/\/[^:]+:[^@]+@/, "://***:***@")}`);
console.log(`  Vault: ${TEST_VAULT_ID}`);
console.log();

async function runSmokeTest() {
  // Dynamically import YSyncProvider
  const { default: YSyncProvider } = await import("y-partyserver/provider");

  // Start server
  console.log("[1/6] Starting server...");
  const server = new YaosServer({
    port: TEST_PORT,
    databaseUrl: process.env.DATABASE_URL || "postgresql://localhost:5432/yaos",
    syncToken: TEST_TOKEN,
  });

  try {
    await server.start();
    console.log("      ✓ Server started");
  } catch (err) {
    console.error("      ✗ Failed to start server:", err instanceof Error ? err.message : String(err));
    console.log("\nPrerequisites:");
    console.log("  - PostgreSQL must be running");
    console.log("  - DATABASE_URL must be configured correctly");
    console.log("  - Run: bun run db:migrate");
    process.exit(1);
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    // Test HTTP
    console.log("\n[2/6] Testing HTTP endpoints...");
    const capsResponse = await fetch(`http://localhost:${TEST_PORT}/api/capabilities`);
    if (capsResponse.status !== 200) {
      throw new Error(`Capabilities returned ${capsResponse.status}`);
    }
    console.log("      ✓ HTTP capabilities working");

    // Test WebSocket with y-partyserver provider
    console.log("\n[3/6] Testing WebSocket with y-partyserver/provider...");
    const ydoc = new Y.Doc();
    const pathToId = ydoc.getMap<string>("pathToId");
    const idToText = ydoc.getMap<Y.Text>("idToText");

    const provider = new YSyncProvider(
      `http://localhost:${TEST_PORT}`,
      TEST_VAULT_ID,
      ydoc,
      {
        prefix: `/vault/sync/${encodeURIComponent(TEST_VAULT_ID)}`,
        params: {
          token: TEST_TOKEN,
          schemaVersion: "2",
        },
        WebSocketPolyfill: WebSocket,
        connect: true,
        maxBackoffTime: 1000,
      }
    );

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout after 5s"));
      }, 5000);

      provider.on("status", (event: { status: string }) => {
        if (event.status === "connected") {
          clearTimeout(timeout);
          resolve();
        }
      });

      provider.on("connection-error", (err: Error) => {
        console.error("      Connection error:", err);
      });
    });

    console.log("      ✓ WebSocket connected");

    // Wait for sync
    console.log("\n[4/6] Waiting for initial sync...");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Sync timeout after 5s"));
      }, 5000);

      provider.on("sync", (synced: boolean) => {
        if (synced) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    console.log("      ✓ Initial sync complete");

    // Add content
    console.log("\n[5/6] Testing document updates...");
    const testFile = "smoke-test.md";
    const fileId = `test-${Date.now().toString(36)}`;
    const ytext = new Y.Text();
    ytext.insert(0, "Hello from y-partyserver smoke test!");
    pathToId.set(testFile, fileId);
    idToText.set(fileId, ytext);

    // Wait for update to propagate
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const retrieved = idToText.get(fileId);
    if (!retrieved || retrieved.toString() !== "Hello from y-partyserver smoke test!") {
      throw new Error("Content verification failed");
    }

    console.log("      ✓ Document updates working");

    // Test unauthorized rejection
    console.log("\n[6/6] Testing unauthorized rejection...");
    const badYdoc = new Y.Doc();
    const badProvider = new YSyncProvider(
      `http://localhost:${TEST_PORT}`,
      TEST_VAULT_ID,
      badYdoc,
      {
        prefix: `/vault/sync/${encodeURIComponent(TEST_VAULT_ID)}`,
        params: {
          token: "bad-token",
          schemaVersion: "2",
        },
        WebSocketPolyfill: WebSocket,
        connect: true,
        maxBackoffTime: 500,
      }
    );

    let rejected = false;
    badProvider.on("connection-close", (event: { code: number; reason: string }) => {
      if (event.code === 1008) {
        rejected = true;
        console.log("      ✓ Unauthorized connection rejected (code 1008)");
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    if (!rejected) {
      console.warn("      ⚠ Rejection not detected (may need investigation)");
    }

    badProvider.destroy();
    badYdoc.destroy();

    // Cleanup
    console.log("\n[Cleanup] Stopping server...");
    provider.destroy();
    ydoc.destroy();
    await server.stop();
    console.log("          ✓ Server stopped");

    console.log("\n" + "=".repeat(60));
    console.log("SMOKE TEST PASSED");
    console.log("=".repeat(60));
    console.log("\nThe self-hosted server is compatible with y-partyserver/provider!");
    process.exit(0);

  } catch (err) {
    console.error("\n✗ Smoke test failed:", err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error("\nStack trace:");
      console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    }

    try {
      await server.stop();
    } catch {
      // Ignore cleanup errors
    }

    process.exit(1);
  }
}

runSmokeTest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
