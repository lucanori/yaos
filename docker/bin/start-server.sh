#!/bin/sh
set -eu

bun run db:migrate
exec bun run start
