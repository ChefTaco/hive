# Console ingress candidate

The shell controller assembles ingress and the static console in the console
host's Compose project. The signed manifest identifies their `ingress` and
`static-ui` service kinds; installation JSON supplies the console host, explicit
bind address/port and public runtime file. See `examples/installation.schema.json`
and `examples/installation.json`. `console.compose.json` remains a standalone
reference fragment. No certified suite manifest has been published, and no
production entrypoint is switched by these candidate checks.

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
`/api/hiveskills`, `/api/cindertrace`, and `/api/chattermost`. Configure the same
prefixes in HiveXUI runtime JSON. The first three rewrite to `/api`, `/api/v1`,
and `/v1` respectively; Skills receives its native paths, Cindertrace `/api/v1`,
and chat its native `/api/v4` paths. The ingress preserves user Authorization,
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
native session preservation, streaming and WebSocket upgrades. It is not a product authorization or migrated
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
