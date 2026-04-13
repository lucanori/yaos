#!/bin/sh
set -eu

bun run src/db/migrate.ts
exec bun run src/main.ts
