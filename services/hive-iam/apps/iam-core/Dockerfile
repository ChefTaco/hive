# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder

# argon2 and better-sqlite3 require native build toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY prisma/ ./prisma/
RUN npm ci

# Generate Prisma client before compiling TypeScript
RUN npx prisma generate

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# ─── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS production

# openssl required by argon2 at runtime; libstdc++ for native addons
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./

# Copy all node_modules from builder (includes native modules + prisma CLI)
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled application
COPY --from=builder /app/dist ./dist

# Copy prisma schema and migrations (needed for migrate deploy)
COPY --from=builder /app/prisma ./prisma

# JWT key files are expected to be mounted via volume or env at runtime.
# To bake them in during CI, uncomment and adjust the path:
# COPY keys/ ./keys/

EXPOSE 4200

# Run pending migrations, then start the server
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/index.js"]
