# Fresh full-profile bootstrap

A signed full release may add Magnus, Cindertrace, ChatterMost and the optional
Emberfold HTTP service to the nine core components, which include the mandatory
[Hive Registry](README.md#hive-registry). Magnus and Cindertrace each
own a private PostgreSQL database and Redis instance; ChatterMost owns a separate
PostgreSQL database. Datastore listeners stay on product-local private networks. ChatterMost's owned
container wrapper expects the local database DNS alias `postgres`; the signed
service assigns that alias only inside its isolated chat datastore network.
Native host agents are opt-in selections with independent pinned artifacts; the
full profile does not install an agent merely because Magnus is selected.

Fresh initialization requires a reviewed `initialization` contract for each
PostgreSQL application. It names an immutable image digest, an apply `command`
and an exact `verificationCommand`; optional `entrypoint` and `workingDirectory`
are part of the signed contract. Examples are Magnus's `migrate` and
`verify-initialization`, which checks its transactional base-seed marker as well
as exact packaged migrations, Cindertrace's migration CLI and `--verify-current`,
and ChatterMost's separate migrator image with `migrate` and `validate-current`.
Hive never infers application schemas from a sibling checkout. The signed service
contract may request private runtime directories in `service.tmpfs` beneath `/run`
or `/var/run`; Hive forces the configured non-root owner and mode `0700`. A
PostgreSQL image using its standard socket directory declares
`["/var/run/postgresql"]`, while its persistent `PGDATA` stays under `/data`. No
host directory is mounted for these runtime paths.

Hive starts only private datastores, journals a migration claim before execution,
and verifies completion before starting applications. An interrupted claim runs
only the product verifier on retry. Failed or incomplete verification holds all
writers for product-owned recovery; Hive never silently repeats a migration with
an unknown outcome. Automatic application migrations and automatic upgrades stay
disabled after initialization.

The fresh Oathweave account receives explicit issuer/subject links to the new
product account IDs. Each product keeps its own native credentials, signing keys,
sessions and datastore passwords. Cindertrace prepares its password hash with the
exact product image's protected, idempotent CLI. ChatterMost preserves its native
API, session cookie and password login for Mattermost clients. Fresh configuration
never adopts an existing account or links identities by matching email.

Distributed configuration adds verified HTTPS `productEndpoints` for selected
Magnus, Cindertrace and ChatterMost services, alongside the four core endpoints.
The optional Emberfold HTTP service stays on the console host's Compose network.
Its API token remains in its protected backend environment. Browser configuration
contains the installation namespace and same-origin product paths only.

HiveXUI is the Magnus console. It reaches the fleet API at `/api/magnus` with a
short-lived Oathweave resource token (audience `magnus`), and fresh setup links the
initial operator to Magnus as an explicit ADMIN. The ingress allows only the
browser-facing rows of Magnus's `docs/console-api.md`, answers 404 for everything
else, and forwards no machine credential, so `x-api-secret` and `x-node-token` never
reach Magnus through it. Agents and services keep using the Magnus endpoint directly.
The ingress also maps `GET /api/magnus/docs/openapi.json` to Magnus's public
`/api/docs/openapi.json`, the one browser route outside `/api/v1`. The former
`bootstrap.magnusConsoleOrigin` setting is refused with a clear message; remove it.

## Magnus web terminal

The browser terminal gives a person a shell on a fleet node, so it is off in every
fresh installation. No release profile can select it. Turning it on takes two
explicit choices in the installation configuration, and the plan reports both under
`magnusTerminal`:

```json
{
  "components": {
    "magnus-gateway": {
      "host": "control",
      "envFile": "/opt/hive/config/magnus-gateway.env",
      "configDirectory": "/opt/hive/config/magnus-gateway"
    }
  },
  "bootstrap": {
    "magnusGateway": {
      "sshUsername": "deploy",
      "sshPrivateKeyFile": "/opt/credentials/fleet-gateway-key",
      "grantTerminalToInitialOperator": true
    }
  }
}
```

1. **Selecting `magnus-gateway`** deploys one non-root, read-only replica of the fleet
   gateway on Magnus's host, on port 4310. The key file must already exist on that host,
   owner-only and unencrypted. Hive copies it into the gateway's read-only `/config` and
   never creates a fleet key. Use a dedicated restricted account on each node. Hive
   generates `FLEET_GATEWAY_API_TOKEN` and `RESOURCE_ENROLLMENT_DASHBOARD_SECRET` once,
   gives Magnus the token's digest, the same drain secret and the gateway's URL, and
   records the gateway in the Hive Registry.
2. **`grantTerminalToInitialOperator: true`** adds `magnus:terminal` to the `hivexui-magnus`
   browser client. Oathweave gives its initial administrator every permission a browser
   client lists, and a browser token never carries more than the list, so this flag is what
   grants the terminal. Without it no token in this installation can carry the permission.

A terminal needs all of this: the gateway, an `ADMIN` link, `magnus:terminal`, and identity
verification within the last five minutes. The interactive setup asks the same questions and
defaults each to no. Both choices are read when the installation is first initialized.
Enabling the terminal on an existing installation has no command yet: its configuration is
fingerprinted, and a changed plan is refused rather than applied over it. Installations
initialized before this option list `magnus:terminal` in their client and role, which has no
effect until a gateway exists.

Without a gateway, Magnus is configured with `RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT=absent`,
so a node with no console work can still pass a resource drain. `DASHBOARD_PUBLIC_ORIGIN` only
builds links in notifications: the console does not answer drain challenges, and the gateway does.

In a distributed configuration the gateway needs a `bootstrap.productEndpoints["magnus-gateway"]`
entry like any other product, on Magnus's host. Bind it where only the console host's ingress and
Magnus can reach it. Its `/internal` route is for Magnus and has no route through the ingress.

### Approving a node

The gateway never learns a host key from a connection, and a node with no approval refuses
every terminal. For each node, read the fingerprint on the node itself, over a path you
already trust, and approve that value:

```bash
# On the node:
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub

# Optional: see what the network path presents. Compare it; never approve it on its own.
./hive.sh magnus-trust scan --config FILE --node-id NODE_ID --host node-1.example.com

# Approve. The gateway connects and confirms the node presents this fingerprint.
./hive.sh magnus-trust add --config FILE --node-id NODE_ID --host node-1.example.com \
  --fingerprint SHA256:... --approved-by alice --approval-ref change-1234
```

`--host` must be the node's inventory hostname or address. `list`, `rotate`, `extra` and `remove`
reach the same CLI; see the gateway's
[README](https://github.com/ChefTaco/magnus/blob/HEAD/services/fleet-gateway/README.md#trusting-a-host-key).
Approvals live in the gateway's data directory, so they survive restarts and are part of backups,
as the key in its configuration directory is. Restrict those backups accordingly.

Dispatch, ingestion, retention and notification integrations in fresh Cindertrace
configuration start disabled until the operator reviews their product-owned
settings. Migration rehearsals additionally enforce each product's isolated
read-only mode. Restored Magnus does not consume queued work or contact agents;
restored ChatterMost normally refuses logins and WebSocket upgrades. The separate
coordinated authentication copy below explicitly enables its volatile, read-only
authentication mode. PostgreSQL clusters
created for the full-profile fixture enable data checksums, which the exact
pinned datastore image verifies offline before candidate startup. Existing
clusters without checksums need a separately reviewed product recovery adapter;
Hive does not enable checksums or alter their data automatically.

All inference services, hosted APIs, model files, model storage, containers and
hardware provisioning remain external. Full installation creates none of them.

## Developer rehearsal

`npm run test:suite:full -- --output NEW_PRIVATE_DIRECTORY --template-release
REVIEWED_CORE_FIXTURE_MANIFEST` exercises actual candidate images and two strictly
pinned SSH inventories on one physical developer host. Optional `--browser-review`
pauses before revocation and backups, creates a protected disposable browser
credential file, and waits for a protected `browser-completion.json` containing
`{"result":"passed"}`. Keep credentials and evidence outside Git.
Add `--release-live-networks` on a host short of Docker address pools: a rehearsal needs a
second set of private networks, so this takes the disposable stack down first.
Add `--magnus-gateway` to opt the fixture in to the web terminal and prove it end to end: a real
Oathweave token through the ingress to the real gateway and a disposable sshd node. It waits out the
five-minute verification window. Without the flag the run proves that the terminal is off.

A passing disposable run is not production cutover approval, physical multi-host
certification, ARM64 certification, or proof that every existing installation's
account recovery and data migration gates have passed. Preserve each independent
installation's state and rehearse its own backups before a separately approved
maintenance window.

The developer full-suite driver also makes a second, separate disposable copy of
each isolated restore for coordinated authentication checks. After its browser
review completes, it stops the original fixture writers before reusing the exact
console origin. The original restored configuration and data remain separately
fingerprinted. Application peers share one internal-only transport bridge across
the two inventory projects; datastore networks stay private. Original issuers,
signing keys, account IDs, passwords and client registrations are retained.
Transport overrides verify the preserved CA and certificate hostname. The derived
ingress permits reads and authentication only. ChatterMost additionally uses its
explicit volatile-authentication rehearsal mode and a read-only PostgreSQL source.

This proof exercises six resource audiences, native chat sign-in, retained post
and attachment reads, authenticated WebSocket ping, wrong-audience rejection and
online revocation while tokens are still live. It verifies unchanged durable chat
records and unchanged original restore bytes. It uses synthetic accounts from the
fresh fixture; it does not satisfy an existing installation's account-recovery or
current-password gate. Both inventory projects run on one physical development
host and do not constitute separate-machine transport certification. The driver
never selects production installations or activates restored state.

Add `--interactive` to the developer driver for a real terminal wizard and Apply
confirmation followed by the actual full installation. This path records its
protected transcript and repeats the generated configuration unattended. It uses
`control` and `identity` inventory IDs and a fixture-only SSH/SFTP client
configuration; it never edits the operator's SSH files. The unattended path
separately injects migration and host-activation interruptions before resuming.
For authenticated peer restores, a loopback-only raw TCP relay forwards TLS bytes
to the isolated ingress. It does not terminate TLS or add credentials; backend
containers retain internal-only networks and certificate verification.
