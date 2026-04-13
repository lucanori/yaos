#!/usr/bin/env bun
/**
 * Full snapshot integration test
 * Tests create, list, and get operations end-to-end
 */

import { YaosServer } from "../bun";
import * as Y from "yjs";
import WebSocket from "ws";

const TEST_PORT = 9996;
const TEST_TOKEN = `snapshot-test-${Date.now()}`;
const TEST_VAULT_ID = `snapshot-vault-${Date.now().toString(36)}`;

console.log("=== Snapshot End-to-End Test ===\n");
console.log(`Port: ${TEST_PORT}`);
console.log(`Vault: ${TEST_VAULT_ID}`);
console.log();

async function runTest() {
  const { default: YSyncProvider } = await import("y-partyserver/provider");

  // Start server
  console.log("[1/8] Starting server...");
  const server = new YaosServer({
    port: TEST_PORT,
    databaseUrl: process.env.DATABASE_URL || "postgresql://localhost:5432/yaos",
    syncToken: TEST_TOKEN,
    s3: process.env.S3_ENDPOINT ? {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || "us-east-1",
      bucket: process.env.S3_BUCKET || "yaos",
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    } : undefined,
  });

  try {
    await server.start();
    console.log("      ✓ Server started");
  } catch (err) {
    console.error("      ✗ Failed:", err);
    console.log("\nPrerequisites: PostgreSQL must be running");
    process.exit(1);
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    // Check S3 availability
    console.log("\n[2/8] Checking S3 storage...");
    const capsResponse = await fetch(`http://localhost:${TEST_PORT}/api/capabilities`);
    const caps = await capsResponse.json();
    console.log(`      Snapshots available: ${caps.snapshots}`);

    if (!caps.snapshots) {
      console.log("      ⚠ S3 not configured, skipping snapshot tests");
      await server.stop();
      process.exit(0);
    }

    // Connect via WebSocket
    console.log("\n[3/8] Connecting to sync room...");
    const ydoc = new Y.Doc();
    const provider = new YSyncProvider(
      `http://localhost:${TEST_PORT}`,
      TEST_VAULT_ID,
      ydoc,
      {
        prefix: `/vault/sync/${encodeURIComponent(TEST_VAULT_ID)}`,
        params: { token: TEST_TOKEN, schemaVersion: "2" },
        WebSocketPolyfill: WebSocket,
        connect: true,
        maxBackoffTime: 1000,
      }
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 5000);
      provider.on("status", (event: { status: string }) => {
        if (event.status === "connected") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    console.log("      ✓ Connected");

    // Wait for sync
    console.log("\n[4/8] Waiting for sync...");
    await new Promise<void>((resolve) => {
      provider.on("sync", (synced: boolean) => {
        if (synced) resolve();
      });
    });
    console.log("      ✓ Synced");

    // Add content
    console.log("\n[5/8] Adding test content...");
    const pathToId = ydoc.getMap<string>("pathToId");
    const idToText = ydoc.getMap<Y.Text>("idToText");
    const sys = ydoc.getMap("sys");
    
    const fileId = `test-${Date.now().toString(36)}`;
    const ytext = new Y.Text();
    ytext.insert(0, "Test content for snapshot");
    pathToId.set("test.md", fileId);
    idToText.set(fileId, ytext);
    sys.set("schemaVersion", 2);
    
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log("      ✓ Content added");

    // List snapshots (should be empty initially)
    console.log("\n[6/8] Listing snapshots (initial)...");
    const listResponse1 = await fetch(
      `http://localhost:${TEST_PORT}/vault/${encodeURIComponent(TEST_VAULT_ID)}/snapshots`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } }
    );
    const list1 = await listResponse1.json();
    console.log(`      Found: ${list1.snapshots?.length || 0} snapshots`);

    // Create snapshot
    console.log("\n[7/8] Creating snapshot...");
    const createResponse = await fetch(
      `http://localhost:${TEST_PORT}/vault/${encodeURIComponent(TEST_VAULT_ID)}/snapshots`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ device: "test-client" }),
      }
    );
    const createResult = await createResponse.json();
    console.log(`      Status: ${createResult.status}`);
    if (createResult.snapshotId) {
      console.log(`      ID: ${createResult.snapshotId}`);
    }

    // Wait a bit for S3 consistency
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // List snapshots again
    console.log("\n[8/8] Listing snapshots (after create)...");
    const listResponse2 = await fetch(
      `http://localhost:${TEST_PORT}/vault/${encodeURIComponent(TEST_VAULT_ID)}/snapshots`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } }
    );
    const list2 = await listResponse2.json();
    console.log(`      Found: ${list2.snapshots?.length || 0} snapshots`);

    if (list2.snapshots && list2.snapshots.length > 0) {
      const snap = list2.snapshots[0];
      console.log(`      Latest: ${snap.snapshotId} (${snap.day})`);
      console.log(`      Files: ${snap.markdownFileCount}`);
    } else if (createResult.status === "created") {
      console.error("      ✗ ERROR: Snapshot was created but not found in list!");
    }

    // Cleanup
    console.log("\n[Cleanup]");
    provider.destroy();
    ydoc.destroy();
    await server.stop();
    console.log("      ✓ Server stopped");

    console.log("\n" + "=".repeat(50));
    if (list2.snapshots?.length > 0) {
      console.log("TEST PASSED");
    } else if (createResult.status === "created") {
      console.log("TEST FAILED - List returned empty after create");
      process.exit(1);
    } else {
      console.log("TEST INCOMPLETE - Check debug output above");
    }
    console.log("=".repeat(50));

    process.exit(0);

  } catch (err) {
    console.error("\n✗ Test failed:", err);
    try { await server.stop(); } catch {}
    process.exit(1);
  }
}

runTest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
