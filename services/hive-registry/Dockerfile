ARG NODE_RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.0-1@sha256:48948514bce59a27f8ee2a3eabaea0a04cbfa87e087297a52f8501c0d465c84f
# Hive Registry: the per-installation install catalog and lookup API.
# Build with services/hive-registry as the context. Runs under any non-root UID the
# release manifest selects, with a read-only root filesystem; only /data is written.
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS builder
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npx tsc -p tsconfig.json \
 && rm -f dist/*.test.js \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_RUNTIME_IMAGE}
USER root
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
