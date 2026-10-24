# Build from the repository root so the local @hivemem/contracts package is available:
#   docker build -f services/hive-router/Dockerfile -t hive-router:local .
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS contracts

WORKDIR /repo/packages/hive-contracts

COPY packages/hive-contracts/package.json packages/hive-contracts/package-lock.json packages/hive-contracts/tsconfig.json ./
RUN npm ci --ignore-scripts
COPY packages/hive-contracts/src ./src
COPY packages/hive-contracts/tests ./tests
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder

COPY --from=contracts /repo/packages/hive-contracts /repo/packages/hive-contracts
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
COPY --from=contracts /repo/packages/hive-contracts /repo/packages/hive-contracts
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
