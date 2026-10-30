# Build from the repository root:
#   docker build -f services/hive-router/Dockerfile -t hive-router:local .
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder

WORKDIR /repo/services/hive-router

COPY services/hive-router/package.json services/hive-router/package-lock.json ./
COPY services/hive-router/prisma ./prisma
COPY services/hive-router/prisma.config.ts services/hive-router/tsconfig.json services/hive-router/tsconfig.build.json ./
RUN npm ci --ignore-scripts
RUN npx prisma generate --config prisma.config.ts

COPY services/hive-router/ui ./ui
COPY services/hive-router/scripts ./scripts
COPY services/hive-router/src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS production

ENV NODE_ENV=production
# Keep this image's historical defaults. The npm package defaults differ
# (API_PORT 4020, PUBLIC_API_URL from the port, data under $HIVE_HOME/router).
ENV API_PORT=443 \
    ADMIN_PORT=9443 \
    PUBLIC_API_URL=https://localhost:443 \
    PUBLIC_ADMIN_URL=https://localhost:9443 \
    DATA_DIR=/repo/services/hive-router/data \
    DATABASE_URL=file:/repo/services/hive-router/data/router.db \
    TRACE_DIR=/repo/services/hive-router/data/traces
WORKDIR /repo/services/hive-router

COPY --from=builder /repo/services/hive-router/node_modules ./node_modules
COPY --from=builder /repo/services/hive-router/dist ./dist
COPY --from=builder /repo/services/hive-router/ui/dist ./ui/dist
COPY services/hive-router/package.json ./
COPY services/hive-router/prisma ./prisma
COPY services/hive-router/prisma.config.ts ./

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 4020 9443

CMD ["node", "dist/src/index.js"]
