# Hive IAM Architecture

Hive IAM is the identity service for the Hive control plane. It runs as the strict TypeScript `hive-iam.service` under `/opt/hive-iam`, exposes HTTPS on port `4200`, stores operational data in SQLite, and uses local Redis for audit queues and rate-limit support.

## Components

| Component | Location | Purpose |
| --- | --- | --- |
| IAM Core API | `apps/iam-core` | Hono HTTPS API for auth, users, roles, service accounts, clients, sessions, system users, audit, OAuth/OIDC, and health. |
| IAM SDK | `packages/iam-sdk` | Node/Hono helpers for local JWT verification and RBAC middleware. |
| Deploy script | `scripts/deploy-iam-core.sh` | Builds, packages, uploads, migrates, seeds when needed, and restarts `hive-iam.service`. |
| Generated UI contracts | `../../packages/hive-contracts` from repo root | Zod/OpenAPI-derived request body schemas consumed by the Hive Router UI proxy. |

## Runtime

- Service: `hive-iam.service`
- Host path: `/opt/hive-iam`
- HTTPS port: `4200`
- Database: SQLite at the deployed `DATABASE_URL`
- Queue/cache: local `redis-server`
- JWT signing: atomic root-only RS256 keyring releases under `/var/lib/hive-iam-keyring`
- TLS: deployed certificate/key under `/opt/hive-iam/certs`
- Audit logs: local append-only files plus database-backed audit query APIs

Readiness is `GET /api/v1/health/ready`; dependency detail is `GET /api/v1/health/dependencies`. The deploy script installs/enables Redis if missing before restarting IAM.

## Router Integration

The unified Hive UI does not expose IAM access tokens to the browser. Browser requests call Router endpoints under `/api/iam/*`. Router strips browser credentials, uses the first-party `hive-router` OAuth client secret to request a short-lived client-credentials token from IAM, and forwards the API call to IAM with that server-side token.

The shared secret for this flow is stored in IAM env as `SEED_HIVE_ROUTER_CLIENT_SECRET` and in Router env as `HIVE_ROUTER_IAM_CLIENT_SECRET`. Current deploy behavior:

- A first install writes the seed value into `/opt/hive-iam/.env`.
- Existing hosts missing `SEED_HIVE_ROUTER_CLIENT_SECRET` fail deployment rather than silently replacing an unrecoverable credential. Recovery or rotation must use the audited IAM client lifecycle.
- Router deploy recovers the value from `HIVE_ROUTER_IAM_CLIENT_SECRET` or protected `/opt/hive-iam/.env` using sudo.
- `HIVE_ROUTER_IAM_PROXY_SCOPES` controls the permissions requested for `/api/iam/*`.

Routine seed is metadata-idempotent and preserves every existing confidential
client hash even when a seed secret is supplied. Credential rotation is an
authenticated `POST /api/v1/clients/:id/rotate-secret` operation and records a
`client.secret_rotated` audit event.

## Built-in Clients

The seed (`apps/iam-core/prisma/seed.ts`) creates these confidential clients. Existing Argon2 secret hashes are never replaced by a routine seed.

| Client ID | Created when | Grants | Notes |
| --- | --- | --- | --- |
| `hive` | always | authorization code, refresh, client credentials | Redirect URI from `SEED_HIVE_PUBLIC_URL`. |
| `hive-router` | always | authorization code, refresh, client credentials | Redirect URI from `SEED_HIVE_ROUTER_REDIRECT_URI`; proxy permissions are allowlisted in the token service. |
| `security-exporter` | `SEED_SECURITY_EXPORTER_CLIENT_SECRET` is set | client credentials | Audience `hive-router`; limited to `iam:audit:read` and `router:security-events:read`. |
| `example-portal` | `SEED_EXAMPLE_PORTAL_CLIENT_SECRET` is set | authorization code, refresh, client credentials | Example third-party OIDC client; audience `example-portal`, limited to `example-portal:read`. |

Additional machine clients can be given an audience, permission allowlist and token lifetime through `IAM_MACHINE_CLIENT_POLICIES` (JSON). The built-in client IDs above cannot be overridden there.

## API Areas

- `/api/v1/auth`
- `/api/v1/mfa/webauthn`
- `/api/v1/users`
- `/api/v1/roles`
- `/api/v1/groups`
- `/api/v1/service-accounts`
- `/api/v1/clients`
- `/api/v1/tokens`
- `/api/v1/sessions`
- `/api/v1/system-users`
- `/api/v1/devices`
- `/api/v1/password-policy`
- `/api/v1/audit`
- `/oauth/*`
- `/.well-known/openid-configuration`

Generated OpenAPI snapshots for IAM live at [`../../../docs/openapi/iam.openapi.json`](../../../docs/openapi/iam.openapi.json). Run `npm run generate:openapi` from the repo root after intentional route/schema changes.

## Development Commands

From `services/hive-iam`:

```bash
npm run typecheck
npm run build
npm test
```

From `services/hive-iam/apps/iam-core`:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
npm run reset:admin
```

From the repo root, prefer the consolidated gates before deploy:

```bash
npm run typecheck
npm run build
npm run test
npm run scan:secrets
```

## Deployment

Use the root deploy when updating a full Hive host:

```bash
npm run deploy
```

For IAM-only work:

```bash
npm run deploy:iam
```

The deploy script contains no literal secret defaults. On first install it takes `COOKIE_SECRET`, `IAM_AGENT_SECRET`, `SEED_ADMIN_PASSWORD`, `SEED_HIVE_CLIENT_SECRET` and `SEED_HIVE_ROUTER_CLIENT_SECRET` from the environment or generates them with `openssl rand`, writing them only to the root-protected target `.env`. It preserves an existing target `.env` unless a value is explicitly provisioned or a required Router client secret is missing. On first install it stores the initial admin credentials in a root-only file on the target rather than printing them in logs.

Privileged key-rotation helpers are allowlisted into
`/usr/local/libexec/hive-iam` with root ownership. The deployed application tree
is root-controlled; the runtime account can write only `prisma` and
`audit-logs`. Signing-key promotion changes one root-only release symlink and
rolls it back if IAM readiness or live JWKS validation fails.

To recover the built-in admin account on a deployed host:

```bash
cd /opt/hive-iam
IAM_RESET_PASSWORD=<known-password> npm run reset:admin
```
