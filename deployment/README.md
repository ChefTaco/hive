# Console ingress candidate

This independently testable deployment fragment is not a certified suite release.
Merge it into the Compose project on the console host after configuring its
selected products and network memberships. The shell renderer does not yet
assemble or activate this fragment. No production entrypoint is switched by it.

Caddy and the static HiveXUI service run separately as non-root users, with read-only
root filesystems and no host control credentials. Prepare the protected ingress
environment and an owner-readable `/config` directory containing the Caddyfile,
`console.crt`, `console.key`, and `backend-ca.pem`. Prepare an empty ingress state
directory owned by UID/GID 1000. Runtime secrets and certificates remain outside Git.
Only Caddy receives the ingress private key. HiveXUI receives public runtime JSON.

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
Origin and cookie headers without injecting an administrator credential.

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
It checks TLS certificate-name rejection, path mappings, unchanged user headers,
streaming and WebSocket upgrades. It is not a product authorization or migrated
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
