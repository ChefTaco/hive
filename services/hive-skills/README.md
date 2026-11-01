# @hivemagnus/hive-skills

`hive-skills` is the top-level Skills registry for Hermes Agents. It exposes a digest-verified HTTPS archive API, an OS-authenticated operator page, and a pull-side Hermes bridge. Hermes itself remains unmodified: each host gets a user systemd timer that syncs skill archives into `~/.hermes/skills/registry` and restarts the gateway only when content changes.

The registry is intentionally small and local-first. SQLite records skills, releases, sessions, audit events, and deployment targets; archives live under the configured data directory. The initial catalog entry is **HiveMem**, based on the existing HiveMem Hermes plugin/skill source supplied at seed time.

## Install from npm

Requires Linux, Node.js 24.22.1+ or 26.13.0+, TLS certificates, and `pamtester` for
OS-backed sign-in. SQLite is provided by Node; there are no native npm add-ons.
Agent deployment also needs Bash, OpenSSH, and permission to enable the target's user timer.

```bash
npm install --prefix /opt/hive-skills/runtime @hivemagnus/hive-skills@1.0.3
/opt/hive-skills/runtime/node_modules/.bin/hive-skills --env-file /opt/hive-skills/skills.env
```

Or run `npx @hivemagnus/hive-skills --env-file skills.env`. The CLI accepts `start`
(the default), `seed`, `--help` and `--version`. Environment-file paths may be absolute;
existing environment variables win. Without `--env-file`, the historical `./.env` lookup
is retained. Help/version do not initialize storage. A fresh install starts with an empty
catalog; startup never seeds or replaces existing records.

Configure these values in a private environment file (mode 0600):

```dotenv
NODE_ENV=production
HIVE_SKILLS_HOST=127.0.0.1
HIVE_SKILLS_PORT=4030
HIVE_SKILLS_PUBLIC_URL=https://hive.example.com:4030
HIVE_SKILLS_DATA_DIR=/opt/hive-skills/shared/data
HIVE_SKILLS_SESSION_SECRET=replace-with-at-least-32-random-characters
HIVE_SKILLS_ADMIN_USERS=admin
HIVE_SKILLS_PAM_SERVICE=login
HIVE_SKILLS_TLS_KEY_FILE=/opt/hive-skills/tls/server.key
HIVE_SKILLS_TLS_CERT_FILE=/opt/hive-skills/tls/server.crt
```

Generate the session secret with `openssl rand -hex 32`. Configure a bind address suitable
for the network where the registry is exposed and a certificate covering its public URL.
The service account needs write access to the data directory and read access to its TLS files.
Keep the session secret unchanged on upgrades to preserve active sessions.

The packaged deployment helper is selected automatically; set `HIVE_SKILLS_DEPLOY_SCRIPT` only
for an intentional override. The package also ships `scripts/hermes-sync.mjs`,
`scripts/archive-utils.mjs`, `scripts/deploy-hermes-agent.sh` and the bundled seed source.
They work independently of the process working directory.

For an existing systemd installation, follow the
[npm migration runbook](../../docs/npm-deployments.md#optional-skills-registry).
Preserve that installation's environment, database, archives, release channels, target policies,
credentials and service account. Back up first; do not seed a production migration.

## Bring up the registry server

```bash
cp .env.example .env
# Set a real session secret and the certificate/key paths already managed by the server.
npm install
npm run build
HIVE_SKILLS_DEPLOY_HOST=hive.example.com HIVE_SKILLS_ENV_FILE="$PWD/.env" bash scripts/deploy-hive-skills.sh
```

The service listens on a dedicated TLS port (default `4030`) and does not mint certificates itself. It uses the server's existing certificate and key specified in `.env`.

`HIVE_SKILLS_SESSION_SECRET` (at least 32 characters) is required. Only a non-production instance bound to a loopback address falls back to an ephemeral random secret, with a warning; its sessions end on restart.

`scripts/deploy-hive-skills.sh` preserves `/opt/hive-skills/shared/.env`, installs the PAM policy and `hive-skills.service`, and activates a health-gated release. New hosts require their own env file; existing hosts retain their own state. `HIVE_SKILLS_ADMIN_USERS` lists the OS accounts allowed to administer the registry (there is no default); authentication is checked through PAM against the host OS account, and the registry stores only a server-side session hash—never an OS password.

## Seed HiveMem

The bundled `registry-sources/hivemem` skill is the initial registry entry and documents the existing HiveMem plugin/tools. Seed it after build:

```bash
npm run seed
```

For an npm install, run the same explicit operation with its CLI:

```bash
/opt/hive-skills/runtime/node_modules/.bin/hive-skills seed --env-file /opt/hive-skills/skills.env
```

The command validates and archives the bundled source as `hivemem` release `1.0.0` and promotes it to stable. Set `HIVEMEM_ARCHIVE` to seed a separately packaged replacement instead. Releases are immutable; later release and catalog CRUD operations are available to the OS-admin through the API.

## Hermes compatibility

Install the client bridge on an agent host using its own SSH key and explicit target settings:

```bash
HIVE_SKILLS_PUBLIC_URL=https://hive.example.com:4030 \
HIVE_SKILLS_TARGET_HOST=agent-host.example.com \
HIVE_SKILLS_TARGET_USER=deploy \
  scripts/deploy-hermes-agent.sh --target agent-1
```

That installs a `hive-skills-sync` systemd **user** service and timer for the target account. The timer pulls `/v1/agent/manifest` and downloads only changed archives with SHA-256 verification. It never edits Hermes core code. A registry admin can invoke the same deployment from the web page; the server queues a durable deployment job and records its completion status. No target OS password is stored in the network service environment.

Releases may declare `minHermesVersion` and `maxHermesVersion` when published.
The bridge detects the local `hermes --version`, supplies it to the manifest, and
checks the returned range again before installation. Set
`HIVE_SKILLS_HERMES_VERSION` in the target's private bridge environment only when
the Hermes wrapper cannot report its version. A bounded release is omitted when
the target version is missing or incompatible; unbounded existing releases remain
backward compatible. Compatibility is evaluated locally per installation; separate
registry installations do not synchronize Skills state.

## API overview

- `GET /healthz` – unauthenticated readiness
- `GET /v1/skills` / `GET /v1/skills/:slug` – public catalog
- `GET /v1/agent/manifest` – Hermes pull manifest
- `GET /v1/skills/:slug/releases/:version/archive[?channel=canary]` – archive payload, only for the release currently promoted on that channel (default `stable`)
- `POST /auth/login` – PAM-backed OS login
- `POST /admin/skills`, `PATCH /admin/skills/:slug`, `DELETE /admin/skills/:slug`
- `POST /admin/skills/:slug/releases`, `POST /admin/deployments/:target`

Every write and deployment action is audit logged with the authenticated OS username.

Skills is optional; each registry installation is independent.

Deployment targets can be seeded at startup with `HIVE_SKILLS_TARGETS`, a
comma-separated list of `name=user@host` entries (for example
`agent-1=deploy@agent-host.example.com`). Manage them afterwards with `GET /admin/targets` and `PUT /admin/targets/:name`
(`host`, `username`, `enabled`). Changing a target host/account or disabling it
revokes its pull enrollment. Enroll again to assign a channel and optional skill
list. Preserve `~/.config/hive-skills/bridge.env` on that target for its own
`HIVE_SKILLS_TARGET` and `HIVE_SKILLS_TARGET_TOKEN`; the installer reads this
optional file without replacing it. The manifest of a canary-enrolled target
points at channel-scoped archive URLs. Unpromoted, superseded and withdrawn
releases cannot be downloaded. Promoted archives remain public within the
registry's network boundary: target skill lists select distribution, they are
not an archive confidentiality boundary.

## Package verification

From the repository, after building, run `npm run check:skills-install`. It packs the package,
installs it into an empty temporary directory, and verifies CLI startup/seed, HTTPS, catalog,
manifest, archive digests, authorization boundaries, a real bridge pull, a repeated pull, and
persistence after restart. All data and the bridge profile are temporary; gateway restart is
replaced by a counter. No production registry, OS account or gateway is changed.

Run `npm run check:skills-install -- --registry` to repeat this against the exact published
version in `package.json`. CI also checks the package allowlist and npm 12 installation.
The package publishes from `.github/workflows/publish.yml` alongside the other packages;
configure its npm trusted publisher for that workflow and the `npm-publish` environment after
the initial authenticated publication.
