# Hive Architecture

Hive is the suite controller of the Hive:Magnus product line. This repository holds no product
code. It holds the controller that installs the products, the signed releases that say exactly
what to install, and the few images the suite builds for itself.

```
              Agents, apps and native clients                Browser
                          │                                     │
                          ▼                                     ▼
   ┌──────────────────────────── Hive Ingress (HTTPS) ─────────────────────────────┐
   │   explicit browser and native path mappings · native ports · credential rules  │
   └───┬──────────┬───────────┬────────────┬────────────┬────────────┬─────────────┘
       ▼          ▼           ▼            ▼            ▼            ▼
   Oathweave  Emberpath    HiveMem     HiveSkills    HiveXUI   Hive Registry   (+ Magnus,
     │                        │                    (static UI)    (SQLite)       Cindertrace,
   Redis                   Qdrant                                                ChatterMost,
                                                                                 Emberfold, ...)
          each product's datastore is private to that product's Compose network
```

## The controller

`hive.sh` and `scripts/suite/*` are the controller. It runs with Bash, jq, openssl and Docker
Compose; the controller host needs no Node.js. One command set covers the whole lifecycle: `init`,
`plan`, `install`, `status`, `doctor`, `upgrade`, `rollback`, `backup`, `rehearse`, `restore`,
`adopt` and `migrate-native`, plus focused commands such as `tls-refresh`, `registry` and
`magnus-agent`.

- **Installation file.** Interactive setup writes a protected installation JSON (see
  `examples/installation.schema.json`). The same file drives unattended commands. It names the
  release, the selected profile or components, the hosts and their placement, the HTTPS listener
  and the certificate files.
- **Hosts.** Each host has its own Compose project, ownership UUID, transaction journal and
  backups. Remote hosts are reached over SSH; the host scripts run there. An installation can live
  on one host or be [distributed](../deployment/DISTRIBUTED.md) over several, with each datastore on
  its owning product's host.
- **Transactions.** Every mutating command opens a transaction on every host, records its phase
  and resumes its own plan when repeated. A different plan is refused while one is open. See
  [when a command stops](../deployment/README.md#when-a-command-stops-transactions-and-recovery).
- **Backups and rehearsals.** Backups are host-bound archives: online by default, or stopped. An
  upgrade takes a verified backup and rehearses data changes on an isolated copy before it
  activates anything. `rehearse` restores an archive into an isolated copy without touching the
  live installation.
- **Separate installations.** Independent installations never share databases, accounts,
  credentials, the Registry or recovery files.

## Signed releases

A suite release is `releases/X.Y.Z.json`, its detached Ed25519 signature
`releases/X.Y.Z.json.sig`, and the publisher key `trust/publisher.pub`. The manifest pins every
product, datastore and initialization image by multi-architecture digest. It lists the `core`
and `full` profiles and the optional components, and carries each product's service contract and
catalog entry, generated from `scripts/suite/release-contracts.mjs` and
`scripts/suite/suite-catalog.json`.

The manifest also pins the controller with `controllerSHA256`: the digest of the files that
`hive_runtime_files` in `scripts/suite/controller.sh` lists. A controller refuses a manifest
pinned to different controller source. `./hive.sh --release VERSION` therefore checks out the
release's own tag (`scripts/suite/release-launcher.sh`), verifies the checkout, the signature and
the controller digest, and only then runs that controller. Retained release checkouts live under
`${XDG_DATA_HOME:-$HOME/.local/share}/hive/releases/`.

How a release is built, signed and checked is in [RELEASING.md](RELEASING.md).

## Products

Each product is released from its own repository as a multi-architecture image, and the suite
pins it by digest:

| Product | Role |
|---|---|
| Oathweave | OAuth 2.0 / OIDC identity, sign-in and resource-scoped tokens for every product |
| Emberpath | OpenAI-compatible model gateway with routing, failover, quotas and tracing |
| HiveMem | Long-term memory API for agents, persisted to Qdrant |
| HiveSkills | Registry of versioned, checksummed skills for agents |
| HiveXUI | The browser UI for the whole suite, Magnus included |
| Magnus | Fleet management for agent hosts, with an optional web terminal gateway |
| Cindertrace | Security event collection and response |
| ChatterMost | Mattermost-compatible team chat for people and agents |
| Emberfold | Context engine HTTP service |
| Ardent Project Studio | Team projects for Ardent agents |

The `core` profile installs Oathweave, Emberpath, HiveMem, HiveSkills, HiveXUI, the ingress and
the Registry with their private Redis and Qdrant stores. The `full` profile adds Magnus,
Cindertrace, ChatterMost (each with its own PostgreSQL) and Emberfold. Optional components, such
as the Magnus web terminal gateway and Ardent Project Studio, are never selected by a profile.
Inference is external: no model or inference image belongs in a release.

HiveXUI is the only UI of the suite. It is a static application served next to the ingress on
the console host, and it signs in through Oathweave.

## Images built here

`deployment/images.json` lists the images this repository builds and publishes through the
*Suite release* workflow, each at its own exact version with provenance, an SBOM and an
attestation:

| Image | Source |
|---|---|
| `hive-registry` | `services/hive-registry` |
| `hive-ingress` | `deployment/ingress.Dockerfile` (Caddy, with `deployment/Caddyfile`) |
| `hive-postgres`, `hive-redis`, `hive-qdrant` | `deployment/datastores/` |
| `hive-node-runtime` | `deployment/runtime/node.Dockerfile`, the hardened Node.js base of the Registry |

## Hive Registry

Every installation runs its own Hive Registry (`services/hive-registry`): the install catalog and
lookup API of that installation. It is unrelated to HiveSkills. `hive.sh` is its normal writer. It
records the products the signed release offers, what the installation runs, external products
and an append-only history. The ingress exposes only explicit read routes under
`/api/registry/`. See the [API reference](hive-registry-api.md).

## Hive Ingress

The ingress is the single HTTPS entry point of an installation. It maps explicit browser paths to
HiveXUI and the product APIs, and native paths and ports to the products their clients expect,
stripping credentials a route must not forward. A [native migration](../deployment/MIGRATE_NATIVE.md)
keeps every former native port and certificate on the ingress, so existing clients keep their URLs.

## Native agents and hosts

Magnus host agents, Hermes and Ardent profiles, and native clients run on hosts outside Compose.
The controller enrolls them with explicit consent: see
[native agents](../deployment/NATIVE_AGENTS.md) and [native consumers](../deployment/NATIVE_CONSUMERS.md).
