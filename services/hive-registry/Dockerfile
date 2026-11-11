ARG NODE_RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.1-1@sha256:7671ab0a702c273c37a84d089ba6fe821c6d85cbeab888e7e43522a057da5e6d
# Hive Registry: the per-installation install catalog and lookup API.
# Build with services/hive-registry as the context. Runs under any non-root UID the
# release manifest selects, with a read-only root filesystem; only /data is written.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS builder
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
