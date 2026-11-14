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
| [**Embermend**](https://github.com/ChefTaco/Embermend) | Optional security assessment, recommendations and authorized remediation through compatible Magnus; [setup](deployment/EMBERMEND.md) |
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
enrollment with consent. When it adds you to the `docker` group, it continues in a shell that
already has the new membership, so no logout is needed. Tailscale is
optional; an existing login can provide the HTTPS certificate, or you can bring your own.

[Install Hive on one host](deployment/QUICKSTART.md) walks through each step: the setup
questions and their answers, other certificate sources, the first sign-in, backups, upgrades,
certificate renewal, firewalls and managing the host from another machine.

`--release latest` resolves GitHub’s latest published, non-prerelease suite release once, prints
the exact version, and runs its tagged controller. To choose a version, use `./hive.sh --release
3.8.1` instead. The launcher retains release checkouts under
`${XDG_DATA_HOME:-$HOME/.local/share}/hive/releases/`; keep them for later commands and certificate
renewal timers. It leaves the original checkout and current working directory unchanged. After
setup, change to the printed release checkout for the lifecycle commands below; return to the
original launcher checkout when selecting a new release with `--release latest`.

For example, release 3.8.1 verifies `releases/3.8.1.json` against `releases/3.8.1.json.sig` with the publisher key
in `trust/publisher.pub` before installing product resources, and refuses a manifest pinned to a different
controller. The setup writes a protected installation file that the same commands accept
unattended. Use the exact version setup reported for repeatable planning and applying
(the following is an example for 3.8.1):

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.8.1
./hive.sh install --config ~/.config/hive/ID/installation.json --release 3.8.1 --non-interactive --yes
./hive.sh status  --config ~/.config/hive/ID/installation.json
./hive.sh doctor  --config ~/.config/hive/ID/installation.json
```

Install and upgrade end with the steps that still need a person, such as the Magnus host agent or
the certificate renewal timer. The Hive Registry records them as the
[setup checklist](deployment/FULL.md#setup-checklist), HiveXUI shows them to administrators,
`status` lists the pending ones, `post-upgrade` marks those it completes, and
`./hive.sh setup done ID` or `./hive.sh setup skip ID` settles one by hand.

See the [deployment guide](deployment/README.md) for fresh setup, the [full profile](deployment/FULL.md),
[distributed](deployment/DISTRIBUTED.md) and [custom](deployment/CUSTOM.md) placements, existing
installations ([`hive.sh migrate-native`](deployment/MIGRATE_NATIVE.md)) and native agents. Suite
releases are listed on the [releases page](https://github.com/ChefTaco/hive/releases); how they are
built and signed is in [docs/RELEASING.md](docs/RELEASING.md).

## The retired npm packages

Before the suite, this repository published Router, IAM, HiveMem and Skills as npm packages
(`@hivemagnus/hive`, `hive-router`, `hive-iam-server`, `hivemem-server`, `hive-skills` and
`hive-iam-sdk`) with an `npx` launcher. That 1.x line is retired: 1.2.2 was its last release, and
its source is no longer in this repository (it remains at the
[`v1.2.2` tag](https://github.com/ChefTaco/hive/tree/v1.2.2)). The products now live in their own
repositories, listed above. `@hivemagnus/hivemem-sdk` is maintained in the
[HiveMem repository](https://github.com/ChefTaco/HiveMem). To move an existing native installation
onto the suite, see [UPGRADING.md](UPGRADING.md#retired-npm-1x-installations).

## Development

The controller is Bash; its tests and the Hive Registry need Node.js 24 (`>=24.22.3`) or 26
(`>=26.13.1`), Python 3 and jq. `.nvmrc` pins the development version.

```bash
npm run bootstrap      # install the Hive Registry dependencies and the git hooks
npm run typecheck
npm test               # controller, install-script, release-document and Registry tests
npm run scan:secrets   # repository secret scanner (also runs in CI)
npm run check:private  # private-data check (also runs in CI)
```

`npm run test:suite` runs only the controller tests. The `test:suite:*` scripts run the slower
container round trips, such as `npm run test:suite:core`; they need Docker.
See [docs/HIVE_ARCHITECTURE.md](docs/HIVE_ARCHITECTURE.md) for how the controller, the signed
releases, the Registry and the ingress fit together.

## Security

On first install, the controller generates each product's secrets once into protected files and
never prints them. Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Upgrading

A suite installation upgrades to a newer signed release with `./hive.sh upgrade --config FILE
--release X.Y.Z`; the launcher selects its verified controller. Upgrades from 2.x to 3.6.0 with existing
PostgreSQL stores also require `--allow-migrations`: the installer takes a verified backup,
rehearses on a copy and rebuilds indexes before activation. Upgrades from a release before 3.4.0
of an installation with Emberpath or HiveSkills require `--allow-migrations` too: both products
changed their data format in 3.4.0, and the installer runs each product's own migration on the
rehearsal copy and then on the stopped live store. Upgrades to 3.6.0 of an installation with
Embermend require it as well, for Embermend's own database migration; an upgrade from 3.5.0 to
3.6.0 without Embermend changes no data format and needs no flag. Code-only rollback across that
collation change is refused; recovery uses the original-state backup and write reconciliation.
See [the upgrade procedure](deployment/QUICKSTART.md#8-upgrade),
[deployment/README.md](deployment/README.md) and [UPGRADING.md](UPGRADING.md). Existing native
installations move onto the suite with [`hive.sh migrate-native`](deployment/MIGRATE_NATIVE.md);
never run fresh-install initialization over their data.

## License

[Apache License 2.0](LICENSE) © ChefTaco and contributors.
