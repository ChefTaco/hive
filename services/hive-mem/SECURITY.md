# HiveMem Security

HiveMem is a standalone memory service. Treat its API, Qdrant storage, webhook integrations, embedding model, and agent tokens as sensitive infrastructure.

## Reporting a vulnerability

Please **do not** open public GitHub issues for security reports. Instead, report the issue privately through GitHub private vulnerability reporting: <https://github.com/ChefTaco/hive/security/advisories/new>. Include reproduction steps and the affected version/commit.

We aim to acknowledge new reports within a few business days and to coordinate disclosure once a fix is available.

## Supported versions

Active development happens on the default branch. Security fixes are applied to the default branch and the latest release only; downstream operators are expected to track the default branch or a recent tag.

## Threat model snapshot

HiveMem is designed for trusted multi-agent systems behind an authenticated boundary. The defaults assume:

- The API is reachable only by agents/operators that hold a valid JWT.
- Qdrant is reachable only from the HiveMem process.
- Webhook destinations are external HTTPS endpoints, not internal services.

If your deployment violates any of these assumptions (for example, exposing Qdrant on a shared network), review the relevant configuration toggles below before going to production.

## Tokens and secrets

- `HIVEMEM_JWT_SECRET` must be at least 32 characters and is enforced at startup. Treat it like a master credential: keep it out of version control, rotate it as an operational secret, and prefer environment-injection over committed files.
- Agent and admin JWTs are bearer credentials. The token returned by `POST /v1/agents/register` is shown **once**; record it in the consuming project's secret store (for example, a file under `~/.hivemem/credentials/`).
- `HIVEMEM_ADMIN_TOKEN` is a script/deployment convenience for passing an admin JWT to tooling. It is not an alternate server-side auth path; rotating `HIVEMEM_JWT_SECRET` invalidates every existing token.
- Reasoning provider API keys (`HIVEMEM_REASONING_API_KEY` and any optional model-endpoint credentials) are server-side only. They must never be exposed to SDK, dashboard, or browser clients.
- Per-agent rate limiting on write routes is governed by `HIVEMEM_RATE_LIMIT_WRITES_PER_MIN` (default `1000`).

## Authentication

- Every `/v1` route except health endpoints (`GET /v1/health`, `/v1/health/live`, `/v1/health/ready`, `/v1/health/dependencies`) and `POST /v1/auth/login` requires `Authorization: Bearer <jwt>`. The `Bearer` prefix is strictly validated per RFC 6750.
- Agent identity is always read from the JWT `sub` claim. The server ignores `agent_id` supplied in request bodies for ownership decisions.
- `POST /v1/auth/login` validates an existing JWT and returns principal metadata. Operator username/password login belongs to Hive Router's OS/PAM auth path in the unified Hive UI, not to the production HiveMem TypeScript core.
- JWTs must carry `iss`, `aud`, `sub`, `iat`, `exp`, `jti`, and `token_type=access`, and may not exceed 30 days. `POST /v1/auth/tokens` is admin-only and issues agent-role tokens without wildcard/admin scopes.
- `/v1/auth/revoke` persists revoked `jti` values in the protected file configured by `HIVEMEM_REVOCATION_FILE`. Tokens minted by `/v1/auth/refresh` carry their ancestors' `jti` values, so revoking a token also revokes its refreshed descendants. Rotating `HIVEMEM_JWT_SECRET` remains the emergency all-token invalidation path.
- `/metrics` requires an admin JWT or the `HIVEMEM_METRICS_TOKEN` scrape token. `HIVEMEM_METRICS_ALLOW_LOOPBACK=true` exempts loopback clients only.

## Content sanitization and audit

- `HIVEMEM_SANITIZE_CONTENT=true` runs lightweight checks for shell-injection, XSS, and prompt-injection patterns before writes; warnings are stored on the memory.
- `HIVEMEM_AUDIT_LOG_ENABLED=true` appends every write to a JSONL audit log. The default path is `/var/log/hivemem/audit.jsonl`. Store audit logs on protected disks, rotate them, and avoid logging bearer tokens or webhook secrets.

## Webhook destinations

Webhook URLs are validated to reduce SSRF and secret-leak risk.

Default policy:

- HTTPS is required.
- Loopback, link-local, private, reserved, multicast, documentation, and other non-public IP ranges are rejected.
- Local hostnames such as `localhost`, `.localhost`, `.local`, and `.localdomain` are rejected.
- URLs with embedded credentials are rejected.
- TLS certificate verification is enabled for outbound webhook deliveries.

Trusted internal deployments can opt into exceptions with server-side settings:

| Variable | Default | Use |
| --- | --- | --- |
| `HIVEMEM_WEBHOOK_ALLOW_HTTP` | `false` | Allow non-TLS destinations for trusted development/internal networks only. |
| `HIVEMEM_WEBHOOK_ALLOW_PRIVATE_IPS` | `false` | Allow private/non-public IP destinations globally. Prefer `HIVEMEM_WEBHOOK_ALLOWED_HOSTS`. |
| `HIVEMEM_WEBHOOK_ALLOWED_HOSTS` | empty | Comma-separated exact hosts or `*.example.internal` wildcards that bypass private-host rejection. |
| `HIVEMEM_WEBHOOK_VERIFY_TLS` | `true` | Verify TLS certificates for outbound webhook deliveries. |

Prefer narrow host allowlists over broad private-IP allowance. Endpoint secrets, when configured, sign delivery bodies with `X-HiveMem-Signature: sha256=<hmac>`; verify the signature before trusting any payload.

## Qdrant exposure

Qdrant must stay bound to localhost by default. The Docker Compose service uses `HIVEMEM_QDRANT_BIND_HOST=127.0.0.1`. Set it to `0.0.0.0` only on trusted/internal hosts where remote integration tests require it. External clients should always talk to HiveMem, not Qdrant directly.

## Transport security

- The production systemd unit terminates TLS in the TypeScript core using the certificate/key under `/opt/hivemem/certs/`. The supplied `scripts/deploy_server.sh` generates a self-signed certificate for development/internal use; in a full Hive deployment, public traffic is usually terminated by Hive Router on port `443` with a certificate you provide (for example from your private network provider or a public CA).
- CORS is restricted to `HIVEMEM_CORS_ORIGINS` (default `http://localhost:18790`). Add additional dashboard/SDK origins explicitly.
- Standard security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, `Referrer-Policy`) are set on every response.

## Dashboard

The `/dashboard` route is gated by an `HttpOnly`, `Secure`, `SameSite=Strict`, path-scoped cookie with a 24-hour max age. Tokens supplied via `?token=` are stripped from the URL by a 303 redirect after login. Prefer the `/v1` REST API for automation rather than scraping dashboard routes.

## Docker and the service user

- The API container runs as a non-root user (`hivemem`).
- The systemd unit source (`docker/hivemem-ts.service`, installed as `hivemem.service`) restricts the service with `ProtectSystem=strict` and a narrow `ReadWritePaths` list covering `/opt/hivemem`, `/var/opt/hivemem`, and `/var/log/hivemem`.

## Backups and restore

- `POST /v1/backup` and `POST /v1/restore` are admin-only.
- The restore endpoint validates the snapshot date format and canonicalizes filesystem paths to prevent traversal. Keep backup destinations on operator-only storage and apply `chmod 600` to any admin-token files referenced by automation.
