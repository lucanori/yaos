# YAOS Self-Hosted Server Tests

This directory contains tests for the YAOS self-hosted server (Bun/Postgres/S3 stack).

## Test Files

### `validate.ts`
Static validation tests that don't require a running database.

```bash
bun run validate
```

Tests include:
- Server instantiation
- Token hashing
- Config storage type definitions
- S3 storage type definitions
- YWebSocketServer instantiation
- Room type definitions
- Snapshot module exports
- ChunkedDocStore module exports
- WebSocket protocol structures

### `integration.ts`
Full integration tests requiring PostgreSQL and optionally S3.

```bash
# Basic usage (requires PostgreSQL)
bun run test:integration

# Or from repository root
bun run test:integration:server:selfhosted
```

## Prerequisites

### PostgreSQL

The integration tests require a running PostgreSQL instance:

```bash
# Using Docker
docker run -d \
  --name yaos-postgres \
  -e POSTGRES_USER=yaos \
  -e POSTGRES_PASSWORD=yaos \
  -e POSTGRES_DB=yaos_test \
  -p 5432:5432 \
  postgres:15

# Set environment variable
export DATABASE_URL="postgresql://yaos:yaos@localhost:5432/yaos_test"
```

### S3-Compatible Storage (Optional)

For blob and snapshot tests, configure S3:

```bash
export S3_ENDPOINT=https://s3.amazonaws.com
export S3_REGION=us-east-1
export S3_BUCKET=yaos-test
export S3_ACCESS_KEY_ID=your-key
export S3_SECRET_ACCESS_KEY=your-secret
```

If S3 is not configured, blob/snapshot tests will be skipped.

### Environment Token (Optional)

For testing env-based authentication:

```bash
export SYNC_TOKEN="your-secure-random-token-here"
```

If not set, tests will use the claim flow.

## Test Categories

### 1. Capabilities Endpoint
- Unclaimed state response
- Claimed state response
- Server version and features

### 2. Authentication
- Claim flow (if no env token)
- Env token authentication (if configured)
- Unauthorized request handling
- Double claim rejection

### 3. WebSocket Sync
- Connection establishment
- Authorization enforcement
- Document sync between clients
- Multiple concurrent clients

### 4. HTTP Routes
- Setup page HTML
- Debug endpoints
- CORS headers

### 5. Snapshots & Blobs (if S3 configured)
- Snapshot creation
- Snapshot listing
- Blob upload/download

## Running Tests

### Quick Validation (No Database Required)

```bash
cd server
bun run validate
```

### Full Integration Test

```bash
# Start PostgreSQL first
docker run -d --name yaos-postgres \
  -e POSTGRES_USER=yaos \
  -e POSTGRES_PASSWORD=yaos \
  -e POSTGRES_DB=yaos_test \
  -p 5432:5432 \
  postgres:15

# Run tests
export DATABASE_URL="postgresql://yaos:yaos@localhost:5432/yaos_test"
cd server
bun run test:integration
```

### With S3 Testing

```bash
export DATABASE_URL="postgresql://yaos:yaos@localhost:5432/yaos_test"
export S3_ENDPOINT="https://..."
export S3_BUCKET="yaos-test"
export S3_ACCESS_KEY_ID="..."
export S3_SECRET_ACCESS_KEY="..."

cd server
bun run test:integration
```

### With Environment Token

```bash
export DATABASE_URL="postgresql://yaos:yaos@localhost:5432/yaos_test"
export SYNC_TOKEN="my-test-token-32-chars-minimum-length"

cd server
bun run test:integration
```

## Test Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `YAOS_TEST_PORT` | 9999 | Port for test server |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `SYNC_TOKEN` | - | Pre-configured auth token |
| `S3_ENDPOINT` | - | S3 endpoint URL |
| `S3_REGION` | us-east-1 | S3 region |
| `S3_BUCKET` | yaos-test | S3 bucket name |
| `S3_ACCESS_KEY_ID` | - | S3 access key |
| `S3_SECRET_ACCESS_KEY` | - | S3 secret key |

## Expected Output

### Validation Tests

```
=== YAOS Self-Hosted Server Validation ===

✓ Server instantiation
✓ Token hashing function
✓ Config storage type definitions
...

=== Test Summary ===
Passed: 12/12
Failed: 0/12

✓ All validation tests passed!
```

### Integration Tests

```
═══════════════════════════════════════════════════════════
YAOS Self-Hosted Server - Integration Tests
═══════════════════════════════════════════════════════════

Test Configuration:
  Port: 9999
  Database: postgresql://***:***@localhost:5432/yaos_test
  S3 Storage: disabled
  Auth Mode: claim flow

Starting test server...
Server started

───────────────────────────────────────────────────────────
Category 1: Capabilities Endpoint
───────────────────────────────────────────────────────────
  ✓ GET /api/capabilities returns unclaimed state (45ms)
...

═══════════════════════════════════════════════════════════
Test Summary
═══════════════════════════════════════════════════════════

Total: 15 tests
Passed: 15 ✓
Failed: 0 ✗
Duration: 2450ms

✓ All integration tests passed!
```
