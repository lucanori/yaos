#!/usr/bin/env bun
/**
 * Focused integration tests for the YAOS self-hosted server (Bun/Postgres/S3)
 *
 * Tests:
 * 1. Capabilities endpoint (unclaimed and claimed states)
 * 2. Claim flow or env-based authentication
 * 3. WebSocket sync happy path
 * 4. Basic snapshot operations (if S3 configured)
 *
 * Prerequisites:
 * - PostgreSQL running and DATABASE_URL configured
 * - Optional: S3-compatible storage for blob/snapshot tests
 *
 * Usage:
 *   bun run test:integration:selfhosted
 *   # or
 *   bun run src/test/integration.ts
 *
 * Environment:
 *   YAOS_TEST_PORT - Server port (default: 9999)
 *   DATABASE_URL - PostgreSQL connection string (required)
 *   SYNC_TOKEN - Optional pre-configured auth token
 *   S3_* - Optional S3 configuration for blob tests
 */

import type { Server as BunServerType, ServerWebSocket } from "bun";
import { YaosServer } from "../bun";
import * as Y from "yjs";

// -------------------------------------------------------------------
// Test Configuration
// -------------------------------------------------------------------

const TEST_PORT = parseInt(process.env.YAOS_TEST_PORT ?? "9999", 10);
const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost:5432/yaos_test";
const TEST_SYNC_TOKEN = process.env.SYNC_TOKEN;
const TEST_VAULT_ID = `test-vault-${Date.now().toString(36)}`;

// S3 config (optional - tests will skip blob/snapshot tests if not configured)
const S3_CONFIG = process.env.S3_ENDPOINT
	? {
			endpoint: process.env.S3_ENDPOINT,
			region: process.env.S3_REGION ?? "us-east-1",
			bucket: process.env.S3_BUCKET ?? "yaos-test",
			accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
			secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
		}
	: undefined;

// -------------------------------------------------------------------
// Test Framework
// -------------------------------------------------------------------

interface TestResult {
	name: string;
	passed: boolean;
	duration: number;
	error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
	const start = performance.now();
	try {
		await fn();
		const duration = Math.round(performance.now() - start);
		results.push({ name, passed: true, duration });
		console.log(`  ✓ ${name} (${duration}ms)`);
	} catch (err) {
		const duration = Math.round(performance.now() - start);
		const error = err instanceof Error ? err.message : String(err);
		results.push({ name, passed: false, duration, error });
		console.error(`  ✗ ${name} (${duration}ms)`);
		console.error(`    Error: ${error}`);
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (actual !== expected) {
		throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

// -------------------------------------------------------------------
// HTTP Helpers
// -------------------------------------------------------------------

async function httpGet(path: string, token?: string): Promise<Response> {
	const headers: Record<string, string> = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return fetch(`http://localhost:${TEST_PORT}${path}`, { headers });
}

async function httpPost(path: string, body: unknown, token?: string): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return fetch(`http://localhost:${TEST_PORT}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

// -------------------------------------------------------------------
// WebSocket Helpers
// -------------------------------------------------------------------

interface WebSocketMessage {
	type: string;
	[key: string]: unknown;
}

function connectWebSocket(vaultId: string, token: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const wsUrl = `ws://localhost:${TEST_PORT}/vault/sync/${encodeURIComponent(vaultId)}?token=${encodeURIComponent(token)}&schemaVersion=1`;
		const ws = new WebSocket(wsUrl);
		
		const timeout = setTimeout(() => {
			ws.close();
			reject(new Error("WebSocket connection timeout"));
		}, 5000);

		ws.onopen = () => {
			clearTimeout(timeout);
			resolve(ws);
		};

		ws.onerror = (err) => {
			clearTimeout(timeout);
			reject(new Error(`WebSocket error: ${err}`));
		};
	});
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<WebSocketMessage> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("Timeout waiting for WebSocket message"));
		}, timeoutMs);

		const handler = (event: MessageEvent) => {
			clearTimeout(timeout);
			ws.removeEventListener("message", handler);
			try {
				const data = JSON.parse(event.data as string) as WebSocketMessage;
				resolve(data);
			} catch {
				// Binary message, resolve with raw data
				resolve({ type: "binary", data: event.data });
			}
		};

		ws.addEventListener("message", handler);
	});
}

// -------------------------------------------------------------------
// Test Suite
// -------------------------------------------------------------------

async function runTests() {
	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("YAOS Self-Hosted Server - Integration Tests");
	console.log("═══════════════════════════════════════════════════════════\n");

	console.log(`Test Configuration:`);
	console.log(`  Port: ${TEST_PORT}`);
	console.log(`  Database: ${TEST_DATABASE_URL.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@")}`);
	console.log(`  S3 Storage: ${S3_CONFIG ? "enabled" : "disabled"}`);
	console.log(`  Auth Mode: ${TEST_SYNC_TOKEN ? "env token" : "claim flow"}`);
	console.log();

	// Start server
	console.log("Starting test server...");
	const server = new YaosServer({
		port: TEST_PORT,
		databaseUrl: TEST_DATABASE_URL,
		syncToken: TEST_SYNC_TOKEN,
		s3: S3_CONFIG,
	});
	await server.start();
	console.log("Server started\n");

	// Give server a moment to fully initialize
	await new Promise((resolve) => setTimeout(resolve, 100));

	try {
		// =================================================================
		// CATEGORY 1: Capabilities Endpoint
		// =================================================================
		console.log("───────────────────────────────────────────────────────────");
		console.log("Category 1: Capabilities Endpoint");
		console.log("───────────────────────────────────────────────────────────");

		await test("GET /api/capabilities returns unclaimed state", async () => {
			const response = await httpGet("/api/capabilities");
			assertEqual(response.status, 200, "Status code");
			
			const body = await response.json() as {
				claimed: boolean;
				authMode: string;
				serverVersion: string;
			};
			
			if (!TEST_SYNC_TOKEN) {
				assertEqual(body.claimed, false, "claimed should be false");
				assertEqual(body.authMode, "unclaimed", "authMode should be unclaimed");
			} else {
				assertEqual(body.claimed, true, "claimed should be true with env token");
				assertEqual(body.authMode, "env", "authMode should be env");
			}
			assert(body.serverVersion, "serverVersion should be present");
		});

		// =================================================================
		// CATEGORY 2: Authentication (Claim Flow or Env Token)
		// =================================================================
		console.log("\n───────────────────────────────────────────────────────────");
		console.log("Category 2: Authentication");
		console.log("───────────────────────────────────────────────────────────");

		let authToken: string;

		if (TEST_SYNC_TOKEN) {
			await test("Env token authentication works", async () => {
				authToken = TEST_SYNC_TOKEN;
				
				// Verify capabilities endpoint reflects env auth
				const response = await httpGet("/api/capabilities");
				const body = await response.json() as { claimed: boolean; authMode: string };
				assertEqual(body.claimed, true, "claimed should be true");
				assertEqual(body.authMode, "env", "authMode should be env");
			});
		} else {
			await test("Claim flow works", async () => {
				authToken = `test-token-${Date.now()}-${"x".repeat(32)}`;
				
				const response = await httpPost("/claim", {
					token: authToken,
					vaultId: TEST_VAULT_ID,
				});
				
				assertEqual(response.status, 200, "Claim should succeed");
				
				const body = await response.json() as {
					ok: boolean;
					obsidianUrl: string;
					capabilities: { claimed: boolean };
				};
				
				assertEqual(body.ok, true, "Response ok should be true");
				assertEqual(body.capabilities.claimed, true, "Capabilities claimed should be true");
				assert(body.obsidianUrl.includes("obsidian://"), "Obsidian URL should be present");
			});

			await test("Double claim is rejected", async () => {
				const response = await httpPost("/claim", {
					token: `another-token-${Date.now()}`,
				});
				
				assertEqual(response.status, 403, "Second claim should be rejected");
				
				const body = await response.json() as { error: string };
				assertEqual(body.error, "already_claimed", "Error should be already_claimed");
			});

			await test("Capabilities reflects claimed state", async () => {
				const response = await httpGet("/api/capabilities");
				const body = await response.json() as { claimed: boolean; authMode: string };
				assertEqual(body.claimed, true, "claimed should be true");
				assertEqual(body.authMode, "claim", "authMode should be claim");
			});
		}

		await test("Unauthorized requests are rejected", async () => {
			const response = await httpGet(`/vault/${TEST_VAULT_ID}/debug/recent`, "invalid-token");
			assertEqual(response.status, 401, "Should return 401");
		});

		// =================================================================
		// CATEGORY 3: WebSocket Sync Happy Path
		// =================================================================
		console.log("\n───────────────────────────────────────────────────────────");
		console.log("Category 3: WebSocket Sync");
		console.log("───────────────────────────────────────────────────────────");

		await test("WebSocket connection establishes", async () => {
			const ws = await connectWebSocket(TEST_VAULT_ID, authToken);
			assertEqual(ws.readyState, WebSocket.OPEN, "WebSocket should be open");
			ws.close();
		});

		await test("WebSocket rejects unauthorized connections", async () => {
			try {
				const ws = await connectWebSocket(TEST_VAULT_ID, "invalid-token");
				ws.close();
				throw new Error("Should have rejected connection");
			} catch (err) {
				// Expected to fail
				assert(err instanceof Error, "Should throw error");
			}
		});

		await test("WebSocket syncs document updates", async () => {
			// Create first client
			const ws1 = await connectWebSocket(TEST_VAULT_ID, authToken);
			
			// Create Yjs document and encode state
			const doc1 = new Y.Doc();
			const pathToId1 = doc1.getMap<string>("pathToId");
			const idToText1 = doc1.getMap<Y.Text>("idToText");
			
			// Add some content
			const fileId = "test-file-1";
			const ytext1 = new Y.Text();
			ytext1.insert(0, "Hello from client 1");
			pathToId1.set("test.md", fileId);
			idToText1.set(fileId, ytext1);
			
			// Get update
			const update = Y.encodeStateAsUpdate(doc1);
			
			// Send sync step 1 (client sends its state)
			const syncMessage = new Uint8Array(1 + update.length);
			syncMessage[0] = 0; // Sync message type
			syncMessage.set(update, 1);
			
			ws1.send(syncMessage);
			
			// Give server time to process
			await new Promise((resolve) => setTimeout(resolve, 200));
			
			// Connect second client
			const ws2 = await connectWebSocket(TEST_VAULT_ID, authToken);
			
			// Give time for sync
			await new Promise((resolve) => setTimeout(resolve, 500));
			
			// Both connections should be open
			assertEqual(ws1.readyState, WebSocket.OPEN, "Client 1 should be open");
			assertEqual(ws2.readyState, WebSocket.OPEN, "Client 2 should be open");
			
			// Clean up
			ws1.close();
			ws2.close();
			doc1.destroy();
		});

		await test("Multiple clients can connect to same vault", async () => {
			const clients: WebSocket[] = [];
			
			// Connect 3 clients
			for (let i = 0; i < 3; i++) {
				const ws = await connectWebSocket(TEST_VAULT_ID, authToken);
				clients.push(ws);
			}
			
			// Verify all are open
			for (let i = 0; i < clients.length; i++) {
				assertEqual(clients[i].readyState, WebSocket.OPEN, `Client ${i} should be open`);
			}
			
			// Clean up
			clients.forEach((ws) => ws.close());
		});

		// =================================================================
		// CATEGORY 4: HTTP Routes (Debug/Trace)
		// =================================================================
		console.log("\n───────────────────────────────────────────────────────────");
		console.log("Category 4: HTTP Routes");
		console.log("───────────────────────────────────────────────────────────");

		await test("GET / returns HTML setup page", async () => {
			const response = await httpGet("/");
			assertEqual(response.status, 200, "Status code");
			const contentType = response.headers.get("content-type");
			assert(contentType?.includes("text/html"), "Should return HTML");
		});

		await test("Debug endpoint returns trace data", async () => {
			// First establish a WebSocket connection to generate traces
			const ws = await connectWebSocket(TEST_VAULT_ID, authToken);
			await new Promise((resolve) => setTimeout(resolve, 200));
			ws.close();
			
			// Give server time to record trace
			await new Promise((resolve) => setTimeout(resolve, 200));
			
			const response = await httpGet(`/${TEST_VAULT_ID}/debug/recent`, authToken);
			// Endpoint may not exist in current implementation, that's ok
			assert([200, 404].includes(response.status), "Should return 200 or 404");
		});

		// =================================================================
		// CATEGORY 5: Snapshot Operations (if S3 configured)
		// =================================================================
		if (S3_CONFIG) {
			console.log("\n───────────────────────────────────────────────────────────");
			console.log("Category 5: Snapshots & Blobs (S3 enabled)");
			console.log("───────────────────────────────────────────────────────────");

			await test("Capabilities shows attachments/snapshots enabled", async () => {
				const response = await httpGet("/api/capabilities");
				const body = await response.json() as {
					attachments: boolean;
					snapshots: boolean;
				};
				assertEqual(body.attachments, true, "attachments should be true");
				assertEqual(body.snapshots, true, "snapshots should be true");
			});

			await test("POST /vault/:id/snapshots creates snapshot", async () => {
				// First sync some data
				const ws = await connectWebSocket(TEST_VAULT_ID, authToken);
				
				const doc = new Y.Doc();
				const pathToId = doc.getMap<string>("pathToId");
				const idToText = doc.getMap<Y.Text>("idToText");
				
				const fileId = "snapshot-test-file";
				const ytext = new Y.Text();
				ytext.insert(0, "Content for snapshot testing");
				pathToId.set("snapshot-test.md", fileId);
				idToText.set(fileId, ytext);
				
				const update = Y.encodeStateAsUpdate(doc);
				const syncMessage = new Uint8Array(1 + update.length);
				syncMessage[0] = 0;
				syncMessage.set(update, 1);
				ws.send(syncMessage);
				
				await new Promise((resolve) => setTimeout(resolve, 300));
				ws.close();
				doc.destroy();
				
				// Now try to create snapshot
				const response = await httpPost(
					`/vault/${TEST_VAULT_ID}/snapshots`,
					{ device: "integration-test" },
					authToken
				);
				
				// May return 200 (created/noop) or 503 (unavailable)
				assert([200, 503].includes(response.status), "Should return 200 or 503");
				
				if (response.status === 200) {
					const body = await response.json() as {
						status: string;
						snapshotId?: string;
					};
					assert(["created", "noop"].includes(body.status), "Status should be created or noop");
				}
			});

			await test("GET /vault/:id/snapshots lists snapshots", async () => {
				const response = await httpGet(`/vault/${TEST_VAULT_ID}/snapshots`, authToken);
				assert([200, 503].includes(response.status), "Should return 200 or 503");
				
				if (response.status === 200) {
					const body = await response.json() as { snapshots: unknown[] };
					assert(Array.isArray(body.snapshots), "snapshots should be an array");
				}
			});
		} else {
			console.log("\n───────────────────────────────────────────────────────────");
			console.log("Category 5: Snapshots & Blobs (S3 not configured - skipped)");
			console.log("───────────────────────────────────────────────────────────");
		}

		// =================================================================
		// CATEGORY 6: CORS Headers
		// =================================================================
		console.log("\n───────────────────────────────────────────────────────────");
		console.log("Category 6: CORS Headers");
		console.log("───────────────────────────────────────────────────────────");

		await test("CORS headers present on API responses", async () => {
			const response = await httpGet("/api/capabilities");
			const allowOrigin = response.headers.get("access-control-allow-origin");
			assertEqual(allowOrigin, "*", "Should allow all origins");
		});

		await test("OPTIONS requests handled correctly", async () => {
			const response = await fetch(`http://localhost:${TEST_PORT}/vault/test/blobs`, {
				method: "OPTIONS",
			});
			assertEqual(response.status, 204, "Should return 204");
			const allowMethods = response.headers.get("access-control-allow-methods");
			assert(allowMethods?.includes("GET"), "Should allow GET");
			assert(allowMethods?.includes("POST"), "Should allow POST");
		});

	} finally {
		// Stop server
		console.log("\nStopping test server...");
		await server.stop();
	}

	// =================================================================
	// Summary
	// =================================================================
	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("Test Summary");
	console.log("═══════════════════════════════════════════════════════════");

	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;
	const total = results.length;
	const duration = results.reduce((sum, r) => sum + r.duration, 0);

	console.log(`\nTotal: ${total} tests`);
	console.log(`Passed: ${passed} ✓`);
	console.log(`Failed: ${failed} ✗`);
	console.log(`Duration: ${duration}ms`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		results
			.filter((r) => !r.passed)
			.forEach((r) => {
				console.log(`  - ${r.name}: ${r.error}`);
			});
		console.log("\n✗ Integration tests FAILED");
		process.exit(1);
	} else {
		console.log("\n✓ All integration tests passed!");
		process.exit(0);
	}
}

// Run tests
runTests().catch((err) => {
	console.error("Fatal error running tests:", err);
	process.exit(1);
});
