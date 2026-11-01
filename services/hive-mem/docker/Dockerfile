# Build with the docker/ context, or use the canonical docker/server.Dockerfile.
# Public runtime images install the same exact npm artifacts as the launcher.
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder
ARG HIVE_PACKAGE=@hivemagnus/hivemem-server
ARG HIVE_VERSION=1.2.0
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /build-context/
RUN node -e 'const fs=require("fs");if(!/^@hivemagnus\/(hive-router|hive-iam-server|hivemem-server|hive-skills)$/.test(process.env.HIVE_PACKAGE)||!/^\d+\.\d+\.\d+$/.test(process.env.HIVE_VERSION))throw Error("invalid package/version");fs.writeFileSync("package.json",JSON.stringify({private:true,allowScripts:{"better-sqlite3":true,argon2:true,"msgpackr-extract":false}}))' \
 && if find /build-context -maxdepth 1 -name '*.tgz' | read -r _; then prefix="$(printf '%s' "$HIVE_PACKAGE" | sed 's/^@//;s,/,-,')"; npm install --ignore-scripts --omit=dev --no-fund --no-audit "/build-context/$prefix-$HIVE_VERSION.tgz"; else npm install --ignore-scripts --omit=dev --save-exact --no-fund --no-audit "$HIVE_PACKAGE@$HIVE_VERSION"; fi \
 && npm rebuild better-sqlite3 argon2 --ignore-scripts=false \
 && node -e 'const p=require(process.env.HIVE_PACKAGE+"/package.json");if(p.version!==process.env.HIVE_VERSION)throw Error("package/image version mismatch")'

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG HIVE_PACKAGE=@hivemagnus/hivemem-server
ARG HIVE_VERSION=1.2.0
LABEL org.opencontainers.image.version=$HIVE_VERSION io.hivemagnus.package=$HIVE_PACKAGE
ENV NODE_ENV=production HIVE_PACKAGE=$HIVE_PACKAGE HIVE_AUTO_MIGRATE=true HIVE_UPDATE_CHECK=false HIVE_AUTO_UPGRADE=false HIVE_HOME=/data
ENV HOST=0.0.0.0 HIVEMEM_TS_CORE_HOST=0.0.0.0 HIVE_SKILLS_HOST=0.0.0.0
RUN apt-get update -qq && apt-get install -y --no-install-recommends util-linux pamtester ca-certificates openssl && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=builder /app /app
COPY entrypoint.mjs health.mjs /app/
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=5s --timeout=4s --start-period=60s --retries=36 CMD ["node", "/app/health.mjs"]
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
