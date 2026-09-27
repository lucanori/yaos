FROM oven/bun:1.3.13-alpine

WORKDIR /app/server

COPY server/package.json ./package.json
COPY server/bun.lock ./bun.lock
COPY server/tsconfig.json ./tsconfig.json

RUN bun install --frozen-lockfile --production

COPY server/src ./src
COPY --chmod=0755 docker/bin/start-server.sh /app/docker/bin/start-server.sh

USER bun

ENTRYPOINT ["/app/docker/bin/start-server.sh"]
