# Hive

[Project site: UI previews and installation walkthroughs](https://hivemagnus.com/).

[![CI](https://github.com/ChefTaco/hive/actions/workflows/hive-ci.yml/badge.svg)](https://github.com/ChefTaco/hive/actions/workflows/hive-ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Hive is a self-hosted control plane for AI agents, installed as one suite.** `hive.sh`, the
suite controller in this repository, installs a set of independent products from a signed release
manifest that pins every container image by digest, and manages their whole lifecycle: plan,
install, status, doctor, backup, restore rehearsal, upgrade and rollback. It needs only Bash, jq,
openssl and Docker Compose on the controller; no Node.js runtime.

| Product | What it does |
|---|---|
| [**Oathweave**](https://github.com/ChefTaco/Oathweave) | OAuth 2.0 / OIDC identity: one sign-in and resource-scoped tokens for every product |
| [**Emberpath**](https://github.com/ChefTaco/Emberpath) | OpenAI-compatible model gateway with routing, failover, quotas and tracing |
| [**HiveMem**](https://github.com/ChefTaco/HiveMem) | Long-term memory API for agents, persisted to Qdrant |
| [**HiveSkills**](https://github.com/ChefTaco/HiveSkills) | Registry of versioned, checksummed skills for agents |
| [**HiveXUI**](https://github.com/ChefTaco/HiveXUI) | The web console for the whole suite, Magnus included |
| [**Magnus**](https://github.com/ChefTaco/magnus) | Fleet management for agent hosts, with an optional web terminal gateway |
| [**Cindertrace**](https://github.com/ChefTaco/cindertrace) | Security event collection and response |
| [**ChatterMost**](https://github.com/ChefTaco/ChatterMost) | Mattermost-compatible team chat for people and agents |
| [**Emberfold**](https://github.com/ChefTaco/emberfold) | Context engine HTTP service |
| [**Ardent Project Studio**](https://github.com/ChefTaco/ArdentStudio) | Team projects for Ardent agents: team assignment, the conversation room and deliverable review |
| [**Hive Registry**](services/hive-registry) | Mandatory per-installation install catalog and lookup API (not the skills registry) |
| **Hive Ingress** | The single HTTPS entry point, with explicit browser and native path mappings |

The `core` profile installs Oathweave, Emberpath, HiveMem, HiveSkills, HiveXUI, the ingress and the
Registry with their private Redis and Qdrant stores. The `full` profile adds Magnus, Cindertrace,
ChatterMost (each with its own private PostgreSQL) and Emberfold. The Magnus web terminal gateway is
offered by every release but never selected by a profile. Ardent Project Studio is offered from release
2.1.1 and is never selected by a profile either; interactive setup suggests it with the
full profile. Inference stays external.

## Install the suite

On a fresh Ubuntu 22.04/24.04 or Debian 12/13 host (amd64 or arm64), from a checkout of the
launcher:

```bash
git clone https://github.com/ChefTaco/hive.git && cd hive
./hive.sh --release latest
```

The guided local setup offers prerequisites, HTTPS, account preparation and full Magnus node
enrollment with consent. No logout is needed for new Docker group membership. Tailscale is
optional; an existing login can provide the HTTPS certificate, or you can bring your own.

[Install Hive on one host](deployment/QUICKSTART.md) walks through each step: the setup
questions and their answers, other certificate sources, the first sign-in, backups, upgrades,
certificate renewal, firewalls and managing the host from another machine.

`--release latest` resolves GitHub’s latest published, non-prerelease suite release once, prints
the exact version, and runs its tagged controller. To choose a version, use `./hive.sh --release
2.4.2` instead. The launcher retains release checkouts under
`${XDG_DATA_HOME:-$HOME/.local/share}/hive/releases/`; keep them for later commands and certificate
renewal timers. It leaves the original checkout and current working directory unchanged. After
setup, change to the printed release checkout for the lifecycle commands below; return to the
original launcher checkout when selecting a new release with `--release latest`.

For example, release 2.4.2 verifies `releases/2.4.2.json` against `releases/2.4.2.json.sig` with the publisher key
in `trust/publisher.pub` before installing product resources, and refuses a manifest pinned to a different
controller. The setup writes a protected installation file that the same commands accept
unattended. Use the exact version setup reported for repeatable planning and applying
(the following is an example for 2.4.2):

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 2.4.2
./hive.sh install --config ~/.config/hive/ID/installation.json --release 2.4.2 --non-interactive --yes
./hive.sh status  --config ~/.config/hive/ID/installation.json
./hive.sh doctor  --config ~/.config/hive/ID/installation.json
```

See the [deployment guide](deployment/README.md) for fresh setup, the [full profile](deployment/FULL.md),
[distributed](deployment/DISTRIBUTED.md) and [custom](deployment/CUSTOM.md) placements, existing
installations ([`hive.sh migrate-native`](deployment/MIGRATE_NATIVE.md)) and native agents. Suite
releases are listed on the [releases page](https://github.com/ChefTaco/hive/releases); how they are
built and signed is in [docs/RELEASING.md](docs/RELEASING.md).

## Legacy npm packages (1.x)

Before the suite, this repository shipped Router, IAM, HiveMem and Skills as npm packages with an
`npx` launcher. They are superseded by the products above (Hive Router by Emberpath, Hive IAM by
Oathweave, and so on), stay on npm, and still receive maintenance releases on the v1 line. Their
source remains under `services/` and `packages/`, and the sections below describe them.

On Linux or macOS with Node.js 24 or 26 and openssl (Docker is optional; it runs Qdrant and Redis
for you):

```bash
npx @hivemagnus/hive init     # choose services, install the servers, generate secrets and TLS
npx @hivemagnus/hive start    # run IAM, HiveMem and the Router; Ctrl-C stops them
```

Then open the console at `https://localhost:9443/` and sign in as `admin` with the password IAM
writes to `~/.hive/iam/initial-credentials.env` on its first start. Everything lives in `~/.hive`.
See the [launcher README](packages/hive) for options, upgrading and uninstalling.

Include the Skills registry with `npx @hivemagnus/hive init --services all`.
Skills uses your OS/PAM login independently of IAM; see the
[launcher Skills setup](packages/hive/README.md#include-hive-skills).

| Package | Description |
|---|---|
| [`@hivemagnus/hive`](packages/hive) | The `hive` launcher: installs, configures and runs the core servers plus optional Skills (`--services all`) (`npx @hivemagnus/hive init`) |
| [`@hivemagnus/hivemem-sdk`](services/hive-mem/sdks/typescript) | TypeScript client for the HiveMem REST API |
| [`@hivemagnus/hive-iam-sdk`](services/hive-iam/packages/iam-sdk) | JWT verification and auth middleware for Hono and Express services that trust Hive IAM |
| [`@hivemagnus/hivemem-server`](services/hive-mem/ts-core) | The HiveMem memory server (`npx @hivemagnus/hivemem-server --env-file hivemem.env`); `issue-token` mints access tokens |
| [`@hivemagnus/hive-router`](services/hive-router) | The Hive Router and the Hive console (`npx --allow-scripts=better-sqlite3 @hivemagnus/hive-router --env-file router.env`) |
| [`@hivemagnus/hive-iam-server`](services/hive-iam/apps/iam-core) | The Hive IAM server (`npx --allow-scripts=better-sqlite3,argon2 @hivemagnus/hive-iam-server --env-file iam.env`); also published as the Docker image `ghcr.io/cheftaco/hive-iam-server` |
| [`@hivemagnus/hive-skills`](services/hive-skills) | Optional HTTPS Skills registry (`npx @hivemagnus/hive-skills --env-file skills.env`), with the Hermes bridge and bundled seed source |

## Legacy services: local development

Requirements: Node.js 24 (`>=24.22.1`) or 26 (`>=26.13.0`); `.nvmrc` pins the development version. Docker with Compose is optional and only
needed to run Redis and Qdrant locally.

```bash
git clone https://github.com/ChefTaco/hive.git
cd hive
npm run bootstrap        # install every independently locked workspace
npm run dev:hive         # generate local secrets, start Redis/Qdrant, launch all services
```

`dev:hive` keeps all of its state in the ignored `.hive-dev/` directory. It generates IAM signing
keys and service secrets, migrates and seeds a local IAM database, and then starts these services:

| Service | URL |
|---|---|
| Hive console (Vite) | http://127.0.0.1:5173 |
| Router admin API | http://127.0.0.1:9443 |
| Router OpenAI-compatible API | http://127.0.0.1:8080 |
| IAM | http://127.0.0.1:4200 |
| HiveMem | http://127.0.0.1:18790 |

Use `npm run dev:hive -- --print-plan` to inspect the plan (secrets are redacted). Use `--no-deps` if
Redis and Qdrant are already running.

## Development

```bash
npm run typecheck      # all workspaces, including generated-contract checks
npm run build
npm test               # unit and integration tests for every workspace
npm run check:openapi  # verify docs/openapi snapshots match the code
npm run scan:secrets   # repository secret scanner (also runs in CI)
npm run doctor         # local environment checklist
```

Each service also has its own scripts. For example, `npm --prefix services/hive-router test` runs
only the router tests. See the README in each service directory for details.

For opt-in verification against a real model provider, run `npm run test:e2e:model`.
See [real-model end-to-end testing](docs/model-e2e.md) for environment configuration, streaming and
memory-recall checks, private reports, and automatic cleanup.

To test an entirely fresh public npm installation, including Skills, run
`npm run test:e2e:fresh` with `HIVE_E2E_PROVIDER_URL` and `HIVE_E2E_MODEL` set.
See [fresh npm full-stack testing](docs/fresh-npm-e2e.md) for exact release selection,
Docker prerequisites, Qwen/llama.cpp settings and automatic installation cleanup.

The OpenAPI specifications for all three HTTP APIs live in [`docs/openapi/`](docs/openapi). Run
`npm run generate:openapi` after an intentional route or schema change.

## Legacy architecture

The legacy npm services fit together like this. Suite products are independent services behind
the Hive Ingress; see [deployment/README.md](deployment/README.md).

```
            Agents / apps                     Operators (browser)
                 │                                    │
     OpenAI API  │  /v1/* memory          HTTPS       │
                 ▼                                    ▼
          ┌─────────────────────── Hive Router ───────────────────────┐
          │ model gateway · quotas · traces · unified console · proxy │
          └──────┬───────────────────────┬──────────────────────┬─────┘
                 │ server-side token     │ client credentials   │
                 ▼                       ▼                      ▼
             HiveMem ──── Qdrant      Hive IAM ── Redis    LLM providers
                                       (SQLite)        (OpenAI-compatible,
                                                        Ollama, vLLM, ...)
```

The browser holds only a Router session. Router calls IAM and HiveMem server-side with its own
scoped credentials, so neither an IAM nor a HiveMem token is ever exposed to the browser. See
[docs/HIVE_ARCHITECTURE.md](docs/HIVE_ARCHITECTURE.md) for details.

## Legacy systemd deployment

The legacy services deploy to Linux hosts as systemd services under `/opt`. The deploy scripts are driven entirely
by environment variables, which you keep in an ignored `.env` file:

```bash
cp services/hive-router/.env.example services/hive-router/.env   # repeat for each service

export HIVE_DEPLOY_HOST=hive                 # SSH host (or alias from ~/.ssh/config)
export HIVE_PUBLIC_FQDN=hive.example.com     # public name on the TLS certificate
export DEPLOY_USERNAME=deploy DEPLOY_SSH_KEY=~/.ssh/id_ed25519

npm run deploy -- --dry-run   # print the plan
npm run deploy
```

Services deploy in this order: Memory, IAM, Router, then Skills if you set
`HIVE_DEPLOY_SKILLS=true`. You can also deploy each service on its own with
`npm run deploy:memory`, `deploy:iam`, `deploy:router` or `deploy:skills`. The Router uses atomic
releases with health-checked activation and automatic rollback. Operational tools such as
`npm run doctor`, `audit:deployments` and `backup` read the hosts they manage from
`HIVE_HOSTS` (for example `HIVE_HOSTS=hive:hive.example.com:skills`).

Operational runbooks:

- [Migrate existing systemd installations to public npm packages](docs/npm-deployments.md)
- [Backup and recovery](docs/BACKUP_RECOVERY.md)
- [Secret rotation](docs/SECRET_ROTATION.md)
- [Memory process drill](docs/MEMORY_PROCESS_DRILL.md)
- [Router routing contract](docs/HIVEROUTER_ROUTING_CONTRACT.md)

## Security

On first install, the deploy scripts generate strong random secrets and never print them. A required
secret that is missing makes the deploy fail instead of falling back to a default. Please report
vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Upgrading

A suite installation upgrades to a newer signed release with `./hive.sh upgrade --config FILE
--release X.Y.Z` from that release's checkout, and returns with `./hive.sh rollback`; see
[deployment/README.md](deployment/README.md). The rest of this section covers the legacy npm
installations.

Existing systemd installations using public npm packages can use the environment-configured
`npm run deploy:npm -- --env-file .env.npm-deploy --to X.Y.Z --apply` command. It keeps
automation off and requires verified backups, preservation checks and live model streaming/recall
acceptance on each installation. Start with `--dry-run`; see the
[deployment command and recovery limits](docs/npm-deployments.md#reusable-release-command).

For a managed installation, run `npx @hivemagnus/hive@latest upgrade --dry-run`, then
`npx @hivemagnus/hive@latest upgrade`. The command upgrades the launcher and every enrolled server
from an exact release bundle, verifies datastore backups before migration, checks live health,
and records recovery instructions. Optional Skills is upgraded only when installed.

See [UPGRADING.md](UPGRADING.md) for adoption, rollback, automation switches, compatibility,
systemd/Compose management and image channels. Existing independent deployments keep their
operator-owned release process; never run fresh-install initialization over their data.

## License

[Apache License 2.0](LICENSE) © ChefTaco and contributors.
