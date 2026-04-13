#!/usr/bin/env bun
/**
 * S3 Stream Handling Test
 * Verifies that snapshot listing works with AWS SDK v3 streams
 */

import { S3Storage } from "../storage/s3";
import { listSnapshots, createSnapshot } from "../snapshot";
import * as Y from "yjs";

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const S3_BUCKET = process.env.S3_BUCKET || "yaos";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY_ID || "minioadmin";
const S3_SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY || "minioadmin";
const TEST_VAULT_ID = process.env.TEST_VAULT_ID || `stream-test-${Date.now().toString(36)}`;

console.log("=== S3 Stream Handling Test ===\n");
console.log("Configuration:");
console.log(`  Endpoint: ${S3_ENDPOINT}`);
console.log(`  Bucket: ${S3_BUCKET}`);
console.log(`  Vault ID: ${TEST_VAULT_ID}`);
console.log();

async function runTest() {
  // Create S3 storage
  const s3 = new S3Storage({
    endpoint: S3_ENDPOINT,
    region: process.env.S3_REGION || "us-east-1",
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    forcePathStyle: true,
  });

  // Test 1: Create a snapshot
  console.log("[Test 1] Creating snapshot...");
  const ydoc = new Y.Doc();
  const pathToId = ydoc.getMap<string>("pathToId");
  const idToText = ydoc.getMap<Y.Text>("idToText");
  const sys = ydoc.getMap("sys");

  // Add test content
  const fileId = "test-file-1";
  const ytext = new Y.Text();
  ytext.insert(0, "Test content for stream handling");
  pathToId.set("test.md", fileId);
  idToText.set(fileId, ytext);
  sys.set("schemaVersion", 2);

  let index;
  try {
    index = await createSnapshot(ydoc, TEST_VAULT_ID, s3, "stream-test");
    console.log(`  ✓ Created: ${index.snapshotId}`);
    console.log(`    Day: ${index.day}`);
    console.log(`    Size: ${index.crdtSizeBytes} bytes`);
  } catch (err) {
    console.error(`  ✗ Failed to create snapshot:`, err);
    process.exit(1);
  }

  // Test 2: List snapshots (this is where the bug was)
  console.log("\n[Test 2] Listing snapshots...");
  try {
    const list = await listSnapshots(TEST_VAULT_ID, s3);
    console.log(`  ✓ Found: ${list.length} snapshot(s)`);

    if (list.length === 0) {
      console.error("  ✗ FAIL: Expected 1 snapshot but got 0!");
      console.error("\n  This indicates the stream handling bug is NOT fixed.");
      console.error("  The AWS SDK returns a Node.js stream that needs to be");
      console.error("  consumed using async iteration, not .getReader().");
      process.exit(1);
    }

    const snap = list[0];
    console.log(`    ID: ${snap.snapshotId}`);
    console.log(`    Created: ${snap.createdAt}`);
    console.log(`    Files: ${snap.markdownFileCount}`);

    if (snap.snapshotId !== index.snapshotId) {
      console.error(`  ✗ FAIL: Snapshot ID mismatch!`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`  ✗ Failed to list:`, err);
    process.exit(1);
  }

  // Test 3: Retrieve snapshot payload (verify stream reading works)
  console.log("\n[Test 3] Retrieving snapshot payload...");
  try {
    const { getSnapshotPayload } = await import("../snapshot");
    const result = await getSnapshotPayload(TEST_VAULT_ID, index.snapshotId, s3);

    if (!result) {
      console.error("  ✗ FAIL: Could not retrieve snapshot payload");
      process.exit(1);
    }

    console.log(`  ✓ Payload retrieved: ${result.payload.byteLength} bytes`);
    console.log(`    Index matches: ${result.index.snapshotId === index.snapshotId}`);
  } catch (err) {
    console.error(`  ✗ Failed to get payload:`, err);
    process.exit(1);
  }

  console.log("\n" + "=".repeat(50));
  console.log("ALL TESTS PASSED");
  console.log("=".repeat(50));
  console.log("\nThe stream handling fix is working correctly!");
  console.log("AWS SDK v3 streams are now properly consumed using");
  console.log("async iteration compatible with Node.js/Bun.");

  ydoc.destroy();
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
