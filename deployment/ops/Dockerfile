FROM oven/bun:1.3.12-alpine@sha256:26d8996560ca94eab9ce48afc0c7443825553c9a851f40ae574d47d20906826d

WORKDIR /app

COPY server/package.json /app/package.json
COPY server/bun.lock /app/bun.lock
COPY server/tsconfig.json /app/tsconfig.json

RUN bun install --frozen-lockfile

COPY server/src /app/src
COPY --chmod=0755 deployment/ops/bin/start-server.sh /app/bin/start-server.sh

USER bun

ENTRYPOINT ["/app/bin/start-server.sh"]
