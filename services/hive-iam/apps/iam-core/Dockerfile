# Hive IAM server image: runs the same `hive-iam-server` entry point as the
# npm package. Build from this directory:
#   docker build -t hive-iam-server:local .
# Data (SQLite database, signing keys, audit logs) lives in the /data volume.

# ─── Stage 1: Toolchain ───────────────────────────────────────────────────────
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS toolchain

# Toolchain for native modules (argon2, better-sqlite3) when no prebuilt
# binary matches; openssl for the Prisma CLI used during the build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM toolchain AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma/ ./prisma/
RUN npm ci --workspaces=false

COPY prisma.config.ts tsconfig.json tsconfig.seed.json ./
COPY scripts/finalize-seed-build.mjs ./scripts/
COPY src/ ./src/
# prebuild generates the Prisma client; build compiles the server, the CLI
# and the seed, then bundles the generated client into dist/.
RUN npm run build

# ─── Stage 3: Runtime dependencies ────────────────────────────────────────────
# A clean production install from the lockfile. --omit=optional also drops
# the Prisma CLI, which the lockfile marks dev-or-optional (an optional peer of
# @prisma/client); the only other optional package is msgpackr's native
# accelerator, which has a pure-JS fallback.
FROM toolchain AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --workspaces=false && npm cache clean --force

# ─── Stage 4: Runtime ─────────────────────────────────────────────────────────
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS production

ENV NODE_ENV=production \
    HIVE_HOME=/data \
    HOST=0.0.0.0 \
    PORT=4200

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma/migrations ./prisma/migrations
COPY --from=builder /app/prisma/schema.prisma ./prisma/schema.prisma
COPY README.md LICENSE ./

# The application tree stays root-owned; only /data is writable by the
# unprivileged `node` user (uid 1000).
RUN ln -s /app/dist/cli.js /usr/local/bin/hive-iam-server \
    && mkdir -p /data/iam \
    && chown -R node:node /data \
    && chmod 700 /data /data/iam

USER node
VOLUME ["/data"]
EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const tls=Boolean(process.env.TLS_CERT_PATH);require(tls?'node:https':'node:http').get({host:'127.0.0.1',port:process.env.PORT||4200,path:'/api/v1/health/ready',rejectUnauthorized:false,timeout:4000},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# Applies pending migrations and, on an empty database, creates the initial
# admin account before listening. Secrets come from the environment.
ENTRYPOINT ["hive-iam-server"]
CMD ["start"]
