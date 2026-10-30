# @hivemagnus/hive-iam-server

Hive IAM is a self-hosted identity and access management server: OAuth 2.0 and
OpenID Connect, RS256-signed JWTs with a JWKS endpoint, role-based access
control, MFA (TOTP and WebAuthn/FIDO2), service accounts, sessions, and an
append-only audit trail. It is the identity service of the
[Hive](https://github.com/ChefTaco/hive) control plane, and it also runs on its
own.

> **Running the whole Hive stack?** The `@hivemagnus/hive` launcher installs,
> configures and runs Hive Router, Hive IAM and HiveMem together, including
> secrets and Redis. Use this package directly when you want IAM on its own or
> manage each service yourself.

## Features

- RS256 access tokens, rotating refresh tokens, JWKS and OIDC discovery
- OAuth 2.0 Authorization Code + PKCE and Client Credentials flows
- Users, roles, groups, service accounts and per-client permission allowlists
- TOTP and WebAuthn/FIDO2 multi-factor authentication, step-up and device trust
- Argon2id password hashing, password policy and breach checks
- Append-only daily JSONL audit files plus queryable audit APIs
- Liveness and readiness endpoints; SQLite storage, no external database

## Requirements

- Node.js 24 (`>=24.22.1`) or 26 (`>=26.13.0`) on Linux or macOS
- Redis 7 or later (queues, rate limiting, WebAuthn ceremonies)
- npm must be allowed to run the install scripts of `better-sqlite3` and
  `argon2`. `better-sqlite3` downloads a prebuilt binary during install, and
  either one builds from source (needs `python3`, `make` and a C++ compiler)
  when no binary matches your platform. npm 12 blocks dependency install
  scripts unless you allow them: pass `--allow-scripts=better-sqlite3,argon2`
  to `npx` or `npm install -g`, or, in your own project, add
  `"allowScripts": { "better-sqlite3": true, "argon2": true }` to its
  `package.json` (npm rejects the flag there). Without it, the install succeeds
  but the server cannot open its database. The `@hivemagnus/hive` launcher sets
  this up for you.

No Prisma CLI, database server or post-install step is needed; the database
schema is created and upgraded automatically on start.

## Quick start

```bash
# 1. Redis (loopback only)
docker run -d --name hive-redis -p 127.0.0.1:6379:6379 redis:7.4.7-alpine

# 2. Secrets
cat > iam.env <<EOF
COOKIE_SECRET=$(openssl rand -hex 32)
IAM_AGENT_SECRET=$(openssl rand -hex 32)
SEED_ADMIN_PASSWORD=$(openssl rand -base64 24)
EOF
chmod 600 iam.env

# 3. Check, then start
npx --allow-scripts=better-sqlite3,argon2 @hivemagnus/hive-iam-server check --env-file iam.env
npx --allow-scripts=better-sqlite3,argon2 @hivemagnus/hive-iam-server --env-file iam.env

# 4. In another terminal
curl http://127.0.0.1:4200/api/v1/health/ready
curl http://127.0.0.1:4200/api/v1/oauth/.well-known/openid-configuration
```

Install it permanently with
`npm install -g --allow-scripts=better-sqlite3,argon2 @hivemagnus/hive-iam-server` and run
`hive-iam-server --env-file iam.env`.

On the first start the server:

1. creates its data directory, `${HIVE_HOME:-~/.hive}/iam` (mode 0700), holding
   `iam.db` (SQLite), `keys/` and `audit-logs/`;
2. generates a 4096-bit RS256 signing key pair in `keys/` unless you configured
   `JWT_PRIVATE_KEY_PATH` and `JWT_PUBLIC_KEY_PATH`;
3. applies the database migrations;
4. creates the built-in roles, the initial `SUPER_ADMIN` account and the
   built-in `hive` and `hive-router` OIDC clients.

Later starts apply any pending migrations from a newer release, after copying
the database to `iam.db.pre-migrate-<timestamp>.bak`.

## First admin account

The initial administrator is created on the first start, when the database has
no users:

| Variable | Default | Notes |
| --- | --- | --- |
| `SEED_ADMIN_USERNAME` | `admin` | Log in with the username or the email |
| `SEED_ADMIN_EMAIL` | `admin@iam.local` | |
| `SEED_ADMIN_PASSWORD` | generated | At least 16 characters |

If `SEED_ADMIN_PASSWORD` (or `SEED_HIVE_CLIENT_SECRET` /
`SEED_HIVE_ROUTER_CLIENT_SECRET`) is unset, a random value is generated and
written to `initial-credentials.env` (mode 0600) next to the database. Values
are never printed to the log. Store them, change the password after the first
login, then delete the file. These variables are ignored once the account and
clients exist; changing them later changes nothing.

Log in through the API:

```bash
curl -X POST http://127.0.0.1:4200/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<SEED_ADMIN_PASSWORD>"}'
```

Lost the password? Run
`IAM_RESET_PASSWORD='<new password>' hive-iam-server reset-admin --env-file iam.env`.

## Configuration

Configuration comes from environment variables, optionally loaded from
`--env-file <path>` (variables already set in the environment win). An empty
value (`NAME=`) counts as unset. Relative paths resolve against the current
directory; prefer absolute paths.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `COOKIE_SECRET` | yes | | Session cookie secret, 32+ characters |
| `IAM_AGENT_SECRET` | yes | | Agent audit-ingest secret, 16+ characters |
| `PORT` | | `4200` | Listen port |
| `HOST` | | `127.0.0.1` | Listen address; `0.0.0.0` for remote access |
| `REDIS_URL` | | `redis://localhost:6379` | `redis://:PASSWORD@host:6379` for an authenticated Redis |
| `JWT_ISSUER` | | `hive-iam` | Token issuer; Hive Router expects `hive-iam` |
| `CORS_ORIGIN` | | `https://localhost` | Comma-separated browser origins, usually the Hive console URL |
| `SEED_HIVE_PUBLIC_URL` | | | Public Hive console URL, e.g. `https://hive.example.com`; sets the built-in clients' redirect URIs on first start |
| `SEED_HIVE_ROUTER_CLIENT_SECRET` | | generated | `hive-router` client secret; give Hive Router the same value as `HIVE_ROUTER_IAM_CLIENT_SECRET` |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | | | Serve HTTPS with these PEM files |
| `HIVE_HOME` | | `~/.hive` | Hive base directory |
| `IAM_DATA_DIR` | | `$HIVE_HOME/iam` | IAM data directory |
| `DATABASE_URL` | | `file:$IAM_DATA_DIR/iam.db` | SQLite database file |
| `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` | | `$IAM_DATA_DIR/keys/iam-*.pem` | RS256 signing key pair |
| `AUDIT_LOG_DIR` | | `$IAM_DATA_DIR/audit-logs` | Daily JSONL audit files |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_ORIGIN` | | `localhost` / `https://localhost` | WebAuthn relying party, e.g. `hive.example.com` / `https://hive.example.com` |
| `TRUSTED_PROXY_IPS` | | | Socket peers allowed to send `X-Forwarded-For` (your reverse proxy) |

`hive-iam-server env-schema` prints the full list as JSON. Further options
(token lifetimes, rate limits, previous signing keys for rotation,
`IAM_MACHINE_CLIENT_POLICIES`) are described in
[`.env.example`](https://github.com/ChefTaco/hive/blob/main/services/hive-iam/apps/iam-core/.env.example).

A missing or invalid setting, or an unreachable Redis, stops the server with a
single line naming the variable or dependency and the fix, and exit code 1.

## TLS

Without `TLS_CERT_PATH` and `TLS_KEY_PATH` the server speaks plain HTTP. That is
fine on loopback or behind a TLS-terminating reverse proxy (set
`TRUSTED_PROXY_IPS` to the proxy's address). To serve HTTPS directly, point both
variables at PEM files; `check` verifies that they exist, match, and have not
expired, and `start` refuses to fall back to HTTP when they are configured but
unusable.

```bash
TLS_CERT_PATH=/etc/hive-iam/tls/server.crt
TLS_KEY_PATH=/etc/hive-iam/tls/server.key
HOST=0.0.0.0
```

## Commands

```text
hive-iam-server [start]   Start the server (default); applies pending migrations first
hive-iam-server migrate   Apply migrations and the first-start bootstrap, then exit
hive-iam-server check     Validate config, TLS, data directory, signing keys and Redis
hive-iam-server env-schema  Print the environment variables as JSON
hive-iam-server reset-admin Reset the admin password from IAM_RESET_PASSWORD
Options: --env-file <path> (repeatable), --no-migrate, --help, --version
```

`check` writes nothing and starts no listeners; it exits 0 when everything is
usable and 1 otherwise, so it works as a pre-start gate. `start --no-migrate`
refuses to start while migrations are pending, for operators who migrate as a
separate step.

## Docker

The [`Dockerfile`](https://github.com/ChefTaco/hive/blob/main/services/hive-iam/apps/iam-core/Dockerfile)
builds an image that runs the same `hive-iam-server` entry point as an
unprivileged user, keeps all state in the `/data` volume, listens on
`0.0.0.0:4200` inside the container and has a readiness health check.

```bash
docker build -t hive-iam-server:local services/hive-iam/apps/iam-core
docker run -d --name hive-iam -p 127.0.0.1:4200:4200 -v hive-iam-data:/data \
  --env-file iam.env -e REDIS_URL=redis://:PASSWORD@redis-host:6379 \
  hive-iam-server:local
```

[`docker/compose.yml`](https://github.com/ChefTaco/hive/blob/main/services/hive-iam/apps/iam-core/docker/compose.yml)
runs IAM with a password-protected Redis, named volumes and loopback-only
ports. Copy `docker/.env.example` to `docker/.env`, fill in the required
secrets, then `docker compose up -d --build` in that directory. Compose refuses
to start while a required secret is missing.

## Health

- `GET /api/v1/health/live`: process liveness, no dependencies
- `GET /api/v1/health/ready`: SQLite and Redis readiness (503 when degraded)
- `GET /api/v1/health/dependencies`: per-dependency detail

## API areas

`/api/v1/auth`, `/api/v1/mfa/webauthn`, `/api/v1/users`, `/api/v1/roles`,
`/api/v1/groups`, `/api/v1/service-accounts`, `/api/v1/clients`,
`/api/v1/tokens`, `/api/v1/sessions`, `/api/v1/system-users`,
`/api/v1/devices`, `/api/v1/password-policy`, `/api/v1/audit`,
`/api/v1/oauth/*` (including `/.well-known/openid-configuration` and `/jwks`).
The OpenAPI document is served at `/api/docs/openapi.json`, with Swagger UI at
`/api/docs`.

Services that trust Hive IAM tokens can verify them locally with
[`@hivemagnus/hive-iam-sdk`](https://www.npmjs.com/package/@hivemagnus/hive-iam-sdk).

## Development

From a clone of the repository:

```bash
cd services/hive-iam
npm ci
bash scripts/generate-keys.sh
cd apps/iam-core
cp .env.example .env        # then replace every change_me value
npm run db:migrate
npm run db:seed
npm run dev
```

```bash
npm run typecheck
npm test
npm run build      # also compiles the CLI (dist/cli.js) and the seed (dist/prisma)
npm run db:generate  # after changing prisma/schema.prisma
```

## Production deploy (repository maintainers)

The repository's own systemd deploy does not use the CLI. From the workspace
root:

```bash
bash scripts/deploy-iam-core.sh
```

It installs to `/opt/hive-iam`, runs `node dist/index.js` under the `hive-iam`
unit with an explicit `.env`, migrates with `prisma migrate deploy` and seeds
through `scripts/run-db-release-gate.sh`. In the consolidated Hive deploy, use
the root `npm run deploy` whenever possible so Memory, IAM, and Router are
updated in order. IAM deploys preserve existing secrets and bootstrap
`SEED_HIVE_ROUTER_CLIENT_SECRET` only on first install. An existing host with no
recoverable Router secret fails deployment instead of silently replacing the
credential hash.

The seed itself never invents a confidential-client credential and never
rotates an existing Argon2 hash; first-install values come from the deploy
script (or, for npm installs, from the CLI's first-start bootstrap described
above). Rotate an existing client only with authenticated
`POST /api/v1/clients/:id/rotate-secret`; this produces a
`client.secret_rotated` audit event and requires a replacement secret of at
least 32 characters.

## License

Apache-2.0. See [LICENSE](LICENSE).
