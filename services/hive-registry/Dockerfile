# Hive Registry: the per-installation install catalog and lookup API.
# Build with services/hive-registry as the context. Runs under any non-root UID the
# release manifest selects, with a read-only root filesystem; only /data is written.
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npx tsc -p tsconfig.json \
 && rm -f dist/*.test.js \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /build/package.json /app/package.json
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/dist /app/dist
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
VOLUME ["/data"]
HEALTHCHECK --interval=5s --timeout=4s --start-period=5s --retries=24 CMD ["node", "/app/dist/cli.js", "health"]
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/dist/server.js"]
