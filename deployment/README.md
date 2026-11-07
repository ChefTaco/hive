# Console ingress candidate

> **New installation?** Start with [Install Hive on one host](QUICKSTART.md): prerequisites,
> console certificate, setup answers, first sign-in, backups and upgrades, step by step. This page
> is the reference for what the controller assembles.

The shell controller assembles ingress and the static console in the console
host's Compose project. The signed manifest identifies their `ingress` and
`static-ui` service kinds; installation JSON supplies the console host, explicit
bind address/port and public runtime file. See `examples/installation.schema.json`
and `examples/installation.json`. `console.compose.json` remains a standalone
reference fragment. The candidate checks below switch no production entrypoint.

## Published releases

Each suite release is a tag `vX.Y.Z` (2.0.0 and later) whose tree holds the signed manifest
`releases/X.Y.Z.json`, its detached Ed25519 signature `releases/X.Y.Z.json.sig` and the publisher
key `trust/publisher.pub`; the same three files are attached to its
[GitHub release](https://github.com/ChefTaco/hive/releases). The manifest pins every product,
datastore and initialization image by multi-architecture digest (linux/amd64 and linux/arm64),
lists the `core` and `full` profiles, the mandatory Hive Registry and the optional
`magnus-gateway`, and pins the controller source with `controllerSHA256`, so install it from a
checkout of the same tag:

```bash
git clone --branch v2.0.6 https://github.com/ChefTaco/hive.git && cd hive
./hive.sh --release 2.0.6
```

The signed services run as UID/GID 1000 (HiveXUI as 101), so run fresh setup as that account or as
a host administrator. `scripts/install-prerequisites.sh` installs what the controller and hosts need, and
`scripts/console-certificate.sh` gets, checks and renews the console certificate. To install from separately downloaded files, pass `--manifest`, `--signature`
and `--trust-key`; check the key's fingerprint against the one in the release notes first.
[docs/RELEASING.md](../docs/RELEASING.md) describes how a release is built, signed and verified.

### Suite images and their provenance

The Hive Registry, the ingress and the datastores are built from this repository by the
*Suite release* workflow from `deployment/images.json`, which names each image's exact version,
Dockerfile and upstream base digest. Every image is published for linux/amd64 and linux/arm64
with an SBOM, maximum provenance and a GitHub build attestation
(`gh attestation verify oci://ghcr.io/cheftaco/IMAGE@DIGEST --owner ChefTaco`). An image tag is
never rebuilt; a change takes a new version.

| Image | Built from | Changes from upstream |
|---|---|---|
| `hive-registry` | `services/hive-registry/Dockerfile` on `node:24.22.1-bookworm-slim` | npm, npx, corepack, yarn and apt removed |
| `hive-ingress` | `deployment/ingress.Dockerfile` | Caddy 2.11.7 compiled from its module with Go 1.26.10, `golang.org/x/net` v0.62.0 and go-jose v4.1.6 (`deployment/caddy/go.mod` and `go.sum`), on the official Caddy 2.11.7 Alpine image with curl removed and Alpine packages upgraded |
| `hive-postgres` 17.11-2, 18.6-2 | `deployment/datastores/postgres.Dockerfile` | gosu and apt removed. The suite runs PostgreSQL as its non-root service owner, so the entrypoint never reaches its root-only gosu step; initdb and data checksums are unchanged |
| `hive-redis` 8.2.10-1 | `deployment/datastores/redis.Dockerfile` | pending Debian security updates applied, apt removed |
| `hive-qdrant` 1.18.3-2 | `deployment/datastores/qdrant.Dockerfile` | pending Debian security updates applied, apt and the unused web dashboard (`/qdrant/static`) removed; the Qdrant binary and its storage format are upstream's |

To rebuild one locally, pass the base digest from `deployment/images.json`, for example
`docker build -f deployment/datastores/postgres.Dockerfile --build-arg
POSTGRES_IMAGE=postgres:17.11-trixie@sha256:... deployment/datastores`. Images that apply
pending distribution updates are pinned by the digest that was published, not reproduced
byte for byte.

Qdrant stays on 1.18.x so existing storage opens unchanged. A copy of 1.18.1-written production
storage opened with `hive-qdrant` 1.18.3-2 returned the same collections, point counts and exact
vector query results as upstream 1.18.1.

`scripts/release/scan-suite-images.sh releases/X.Y.Z.json` is the release gate: every pinned
image, on both architectures, has no CRITICAL or HIGH finding with a fix available. Accepted
exceptions are kept per image in `deployment/trivy/`, each scoped to one advisory and package:

- `hive-qdrant`: GHSA-36hh-v3qg-5jq4 (pyo3) and GHSA-4w2j-m93h-cj5j (quinn-proto) appear in
  Qdrant's bundled SBOM `/qdrant/qdrant.spdx.json`, which lists the whole Cargo workspace. Neither
  crate is linked into the binary: none of the 218 crate source paths embedded in the 1.18.3 binary
  is pyo3 or quinn-proto. The SBOM is kept unmodified.
- `hive-ingress`: CVE-2026-116587 in go-jose v3, which has no fixed release. It reaches Caddy only
  through the PKI app (`caddypki`), which the suite never enables (`admin off`, no ACME, static
  certificates).

Findings with no fix available upstream are listed in each release's notes.

Caddy and the static HiveXUI service run separately as non-root users, with read-only
root filesystems and no host control credentials. Prepare the protected ingress
environment and an owner-readable `/config` directory containing the Caddyfile,
`console.crt`, `console.key`, and `backend-ca.pem`. Prepare an empty ingress state
directory owned by UID/GID 1000. Runtime secrets and certificates remain outside Git.
Only Caddy receives the ingress private key. HiveXUI receives public runtime JSON.
HiveXUI cannot receive an environment file or backend configuration directory.
The renderer provides its writable nginx tmpfs directories and publishes only
ingress. Host preflight checks runtime configuration, disk capacity, SSH trust,
permissions, architecture, the listener, certificate hostname/expiry and matching
private key before deployment state is created. `ss` (iproute2), `df` and coreutils
are required on console hosts. Configure private backend/datastore network
memberships in the signed release; datastore ports remain unpublished.

Set `HIVE_CONSOLE_HOST` and each selected product's `*_ENDPOINT` and `*_TLS_NAME`.
Set `EMBERPATH_API_ENDPOINT` and `EMBERPATH_API_TLS_NAME` separately for the
native model API listener; `EMBERPATH_ENDPOINT` targets its browser administration
listener. An endpoint contains only HTTPS scheme, host and optional port. A TLS name matches
the upstream certificate. The CA bundle contains the exact approved roots. No
transport disables certificate verification. Unconfigured products fail closed.
Compose names can be used only for services on this host and a shared bridge;
remote placements need explicit verified HTTPS endpoints. Static HiveXUI is local
to ingress. Do not expose datastore ports.

Browser prefixes are `/api/emberpath`, `/api/oathweave`, `/api/hivemem`,
`/api/hiveskills`, `/api/cindertrace`, `/api/chattermost`, and `/api/magnus`.
The read-only [Hive Registry](#hive-registry) adds `/api/registry`.
Configure the same prefixes in HiveXUI runtime JSON. The first three rewrite to `/api`, `/api/v1`,
and `/v1` respectively; Skills receives its native paths, Cindertrace `/api/v1`,
and chat its native `/api/v4` paths. Magnus is the exception to prefix mapping:
only an explicit list of browser-facing routes rewrites to `/api/v1`, and everything
else answers 404 (see [FULL.md](FULL.md)). `/api/magnus/terminal/*` reaches the optional
fleet gateway instead of Magnus, for its exact routes, and answers 404 when no gateway is
selected ([Magnus web terminal](FULL.md#magnus-web-terminal)). The ingress preserves user Authorization,
Origin and native product sessions without injecting an administrator credential.
Oathweave's SSO and refresh cookies reach only Oathweave; other APIs cannot set
these identity cookies. Static assets receive no Authorization or Cookie header
and cannot set cookies. Browser bearer requests omit cookies except where the
native chat session is required, including attachments and WebSockets.

The native model `/v1`, memory `/memory/v1`, Mattermost `/api/v4` and signed
security `/api/v1/security-fusion` paths are explicit. Existing independent product
origins must remain available during migration. Verify all native URLs, streaming,
WebSockets and attachment paths before changing an installation's public ingress.

Use the preserved product release/recovery tooling until suite lifecycle adapters
and restore rehearsals pass. This fragment does not claim frontend workflow parity.

Build the ingress candidate with `docker build -f deployment/ingress.Dockerfile
-t hive-ingress:candidate deployment`. The derived image removes Caddy's
privileged-port file capability before running it with all capabilities dropped.
The readiness listener is container-local loopback only.

After building HiveXUI as `hivexui:candidate`, run
`node scripts/suite/ingress-roundtrip.mjs` for disposable transport acceptance.
It checks TLS certificate-name rejection, path mappings, identity-cookie isolation,
native session preservation, streaming and WebSocket upgrades, plus the Magnus route
allowlist, header stripping, and the fleet gateway's routes and browser headers. Set `HIVE_MAGNUS_ROUTE_INVENTORY` to Magnus's
`docs/console-api.md` to check every row of that inventory. It is not a product authorization or migrated
data test. Released deployment must use registry image digests rather than these
local candidate tags.

For the real browser-protocol/resource authorization check, build the extracted
Oathweave and Emberpath images as `oathweave:candidate` and `emberpath:candidate`,
then run `npm run test:suite:containers` from Hive as an unprivileged operator
with Docker access. This starts fresh product stores, generated test keys and
an isolated Redis network. It checks local-ID preservation, reader write denial,
native-token rejection and logout revocation on the actual receiving API. It
cleans up its containers and networks and never selects a live installation.
This bounded acceptance does not certify a fresh core/full installer or migration.

Inference is external: see [external provider configuration](INFERENCE.md).
No inference image, model volume, GPU matrix or model artifact belongs in a Hive release.

**Existing native installation?** Use [`hive.sh migrate-native`](MIGRATE_NATIVE.md): it keeps every native port, certificate, issuer, key and account. `adopt` takes over existing Compose stacks only.

## Fresh core setup

Run `./hive.sh` for terminal setup with a signed manifest and publisher key, or
prepare the same installation JSON for unattended use. The wizard selects actual
release components and dependencies, exact versions, protected certificate/key
references, an explicit HTTPS listener, optional external endpoints and opt-in
native agent profiles. It never asks for a password on the command line. Provider
authorization remains an explicit operator step. Inventory defaults to a protected
configuration directory outside the checkout.

The current fresh initializer supports a co-located core and its private Redis and
Qdrant stores. Configure `bootstrap` in installation JSON using the initial
operator labels and existing console TLS file references. `./hive.sh init` can
prepare and review configuration separately; `install` performs this step when
requested. Per-product secrets, initial identities and internal transport keys are
generated once into protected files. Retries check the exact inputs and file
digests. Existing data, configuration, model resources and Compose projects are
never silently adopted or overwritten.

A renewed console certificate goes in with `./hive.sh tls-refresh --config FILE`: it checks the
files at `bootstrap.certificateFile` and `privateKeyFile` like the initializer does, replaces the
ingress copies, records their digests in the initialization receipt so retries keep working, and
restarts only the ingress. An installation moved with `migrate-native` uses its own
`migrate-native tls-refresh`.

Only private backends and datastores run during first initialization. After
readiness, they stop and the normal release starts with automatic migrations and
upgrades disabled. Ingress, the console and agents wait for that boundary. Initial
Oathweave browser clients and resource grants come from its own bootstrap contract;
Emberpath and HiveMem retain explicit, independently allocated local account IDs.
Recovery delivery still needs the operator's trusted out-of-band delivery consumer.

`npm run test:suite:core -- --output NEW_PRIVATE_DIRECTORY` exercises actual pinned
images using a temporary loopback registry, generated accounts and empty stores.
Add `--interactive` to exercise the terminal installer. Both variants verify repeat
execution, four-product SSO, audience/revocation denial, a host-bound backup and an
isolated restore. Their local trust keys and images are developer fixtures; they
are not published release artifacts or migration approval. Separate fresh
[distributed core](DISTRIBUTED.md), [full](FULL.md) and [custom](CUSTOM.md) drivers
also pass interrupted execution, stable retry and isolated recovery across two
strict SSH inventories on one physical host. Full setup includes both an actual
terminal wizard and unattended installation, plus authenticated restored peers.
Separate physical machines and existing installations retain their own gates.

## When a command stops: transactions and recovery

`install`, `upgrade`, `rollback`, `backup`, `rehearse`, `restore` and `adopt` each open a
transaction on every host, recorded in the installation directory's `transaction.json` with the
plan it belongs to. While one is open, `status` and `doctor` report
`incomplete-transaction: HOST is in phase PHASE`, and a different plan is refused with
`A different transaction requires recovery`.

**Closed as aborted.** When a command fails in its read-only checks (staging, which verifies the
release and pulls images; the storage compatibility check; the native agent and external
endpoint preflight), nothing has been stopped, paused, initialized, staged or activated.
`hive.sh` closes the transaction as `aborted`, keeps its record in `transaction.json` and
`aborted-transaction.PLAN.json`, and says so. `doctor` treats it as closed. Fix the cause, then
run the same command or any other. Configuration a command provisions before its transaction
opens, such as the registry and memory credentials, is idempotent and stays.

**Repeat the same command.** In any other open phase (`prepared` after data initialization or
agent staging, `quiesced`, `backed-up`, `migrated`, `activating`, `ready`, `restoring` or
`recovery-required`), something on the host may have changed. Repeat exactly the same command,
from the same checkout with the same installation file and options, so it resumes its own plan;
a backup or rollback the message names is the other way back. A `migration-started` phase is
never replayed: the product's migration outcome is unknown and needs its own recovery.

**Start fresh** only when every host's phase is `complete` or `aborted`. Never edit
`transaction.json` by hand.

## Hive Registry

Every installation runs a Hive Registry: its install catalog and lookup API, a small
SQLite container on the console host. It is unrelated to HiveSkills, the skills
registry. It holds the products the signed release offers, what this installation
actually runs, the links an operator or client needs, and an append-only history.
Independent installations never share one. See the [API reference](../docs/hive-registry-api.md).

`hive.sh` is the normal writer. The signed manifest is the source: each component's
`catalog` block is generated from `scripts/suite/suite-catalog.json`. A configuration or a
release without the registry is refused. `upgrade` and `adopt` add it to an existing
installation without rewriting the configuration file. `upgrade`, `rollback` and `adopt`
also install the release's Caddyfile wherever the installed one differs, keeping the previous
file as `Caddyfile.pre-registry` when it had no registry route and as `Caddyfile.previous`
otherwise. Adoption restarts nothing, so its route starts with the next ingress restart.

```bash
./hive.sh registry list --config FILE           # also: installed, summary, history
./hive.sh registry get emberpath --config FILE  # also: connection ID
./hive.sh registry add ID --file ENTRY.json --config FILE  # also: update, remove
```

`add`, `update` and `remove` cover externally managed products only. Entries are private
unless they set `"public": true`, and any credential in one is refused. Lookups and writes
run over SSH through a client inside the container; the controller and host need no Node.

The installer generates separate read and write credentials once into owner-only files,
`config/hive-registry/read-token` and `write-token`. Hosts and internal endpoints need a
credential; see the API reference for what is public. The ingress passes only explicit GET
routes under `/api/registry/` and strips cookies, so writes never leave the private network.

The registry starts before the products it records and marks them `activating`. After
activation, the installer records `installed` only for products observed running their
exact signed image. If that record fails, services keep running, the command fails and
the transaction stays open, so the install cannot look finished with a wrong catalog.
Repeat the command to finish: writes are idempotent and add no duplicates. If the registry
cannot start, the operation holds. `status` reports `registry.state` and each drift by name
(`in-sync`, `drift`, `missing`, `unavailable` or `not-active`), and `doctor` fails on any drift.

Backups, restores and adoption treat its data like any product's: the stopped archive
includes the whole SQLite family. Rehearsals mount `/data` read-only and serve a private
copy that refuses writes. A rollback to a release from before the registry stops it and
keeps its data for the next upgrade.

## Relaxed authentication limits for testing

`./hive.sh install --relax-auth-limits` and `./hive.sh upgrade --relax-auth-limits`
render testing settings for each selected product: `RELAX_AUTH_LIMITS=true` for
Oathweave and Cindertrace, and `RATE_LIMIT_LOGIN_SOURCE_MAX=10000` with
`RATE_LIMIT_LOGIN_ACCOUNT_MAX=10000` for ChatterMost. Use `./hive.sh plan
--relax-auth-limits` to review it first. The choice is part of the plan digest, so
toggling it is a new reviewed plan that recreates only changed services, and an
upgrade without the flag restores normal limits. The plan and `./hive.sh status`
report the state as `authLimits`. Never use it on an internet-facing installation.

Native Magnus artifact staging, authenticated heartbeat and a read-only command
now have a separate disposable rehearsal. Native Ardent model/memory, Codex
Responses, Hermes streaming and its HiveMem plugin also have integrated core
recovery proof. Ardent Skills, scoped chat and embedded Emberfold, plus Hermes's
native Skills tools and Mattermost adapter, have a separate
[consumer drill](NATIVE_CONSUMERS.md). Actual Magnus
[user-service activation and restart](USER_SERVICES.md) also pass. Existing profiles
and provider authorization retain their own acceptance gates. See
[native agents](NATIVE_AGENTS.md) for protected configuration, preflight, explicit
acceptance and status.

Deployment plans include a controller source fingerprint. Signed manifests may
require it using `controllerSHA256`. A different controller cannot resume the same
plan silently. A deterministic controller archive and its digest are retained with
each activated or adopted release for recovery.
