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

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /build/package.json /app/package.json
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/dist /app/dist
# The registry runs only node: remove the package managers and apt, whose bundled
# dependencies carry known vulnerabilities. dpkg and its package database stay.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && dpkg --purge --force-remove-protected --force-remove-essential apt libapt-pkg6.0 \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/log/apt \
 && mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
VOLUME ["/data"]
HEALTHCHECK --interval=5s --timeout=4s --start-period=5s --retries=24 CMD ["node", "/app/dist/cli.js", "health"]
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/dist/server.js"]
