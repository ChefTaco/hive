# Hive

[![CI](https://github.com/ChefTaco/hive/actions/workflows/hive-ci.yml/badge.svg)](https://github.com/ChefTaco/hive/actions/workflows/hive-ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Hive is a self-hosted control plane for AI agents.** It gives a fleet of agents a shared identity
provider, long-term memory, and a model gateway, and manages all three from one web console.

| Component | What it does |
|---|---|
| [**Hive Router**](services/hive-router) | OpenAI-compatible model gateway with provider discovery, adaptive and objective-based routing, streaming-aware failover, per-key quotas, and tracing. It also serves the unified Hive console. |
| [**Hive IAM**](services/hive-iam) | OAuth 2.0 / OIDC identity service for users, service accounts, and agents. It issues signed JWTs, supports scoped client credentials, keeps an audit log, and runs with a hardened systemd sandbox. |
| [**HiveMem**](services/hive-mem) | Long-term memory API for agents, persisted to Qdrant. It supports semantic and filtered search, a knowledge graph, temporal (as-of) queries, consolidation and reasoning jobs, webhooks, and peer conclusions. |
| [**Hive Skills**](services/hive-skills) | Optional HTTPS registry that distributes versioned, checksummed skills to [Hermes Agent](https://github.com/NousResearch/hermes-agent) installations. |

Everything is strict TypeScript on Node.js 24 or 26. The only exception is the HiveMem plugin for Hermes Agent, which is written in Python.

## Packages on npm

| Package | Description |
|---|---|
| [`@hivemagnus/hivemem-sdk`](services/hive-mem/sdks/typescript) | TypeScript client for the HiveMem REST API |
| [`@hivemagnus/hive-iam-sdk`](services/hive-iam/packages/iam-sdk) | JWT verification and auth middleware for Hono and Express services that trust Hive IAM |
| [`@hivemagnus/hivemem-server`](services/hive-mem/ts-core) | The HiveMem memory server (`npx @hivemagnus/hivemem-server --env-file hivemem.env`) |
| [`@hivemagnus/hive-router`](services/hive-router) | The Hive Router and the Hive console (`npx @hivemagnus/hive-router --env-file router.env`) |
| [`@hivemagnus/hive-iam-server`](services/hive-iam/apps/iam-core) | The Hive IAM server (`npx @hivemagnus/hive-iam-server --env-file iam.env`); also available as a Docker image |

## Quick start (local development)

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

The OpenAPI specifications for all three HTTP APIs live in [`docs/openapi/`](docs/openapi). Run
`npm run generate:openapi` after an intentional route or schema change.

## Architecture

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

## Deployment

Hive deploys to Linux hosts as systemd services under `/opt`. The deploy scripts are driven entirely
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

## License

[Apache License 2.0](LICENSE) © ChefTaco and contributors.
