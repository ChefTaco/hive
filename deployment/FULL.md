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

### Preparing nodes and the gateway key

The gateway signs in to each node as one restricted account, with one key. Create both before
running setup; Hive refuses a key file it cannot read or that others can read. On a single host,
the node is the host itself. As the account that runs `hive.sh` (UID 1000):

```bash
# On each node: a dedicated account with no sudo rights.
sudo useradd --create-home --shell /bin/bash --comment "Hive web terminal" hive-terminal

# On the Magnus host: the gateway key, owned by you and owner-only. Hive copies it.
sudo install -d -m 0700 -o "$USER" -g "$USER" /etc/hive/fleet
ssh-keygen -q -t ed25519 -N "" -C hive-fleet-gateway -f /etc/hive/fleet/gateway-key

# On each node: authorize that key for the terminal account only.
sudo install -d -m 0700 -o hive-terminal -g hive-terminal /home/hive-terminal/.ssh
sudo install -m 0600 -o hive-terminal -g hive-terminal /etc/hive/fleet/gateway-key.pub \
  /home/hive-terminal/.ssh/authorized_keys
```

Then answer `yes` to *Deploy the Magnus web terminal gateway*, `hive-terminal` to *Restricted
SSH account on fleet nodes*, `/etc/hive/fleet/gateway-key` to the key question, and `yes` to
grant the terminal to the initial operator if that account should use it. A terminal also needs
a Magnus node: see [Magnus host agents](#magnus-host-agents), then approve the node below.

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
settings. Ingestion starts with the first collector: see
[sending security events to Cindertrace](#sending-security-events-to-cindertrace). Migration rehearsals additionally enforce each product's isolated
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

## Magnus host agents

A host joins the fleet by running the Magnus agent, which calls Magnus's agent API. On a fresh
single-host installation Magnus listens only on the suite's private network, so setup offers to
publish that API on its own port:

```text
Port for Magnus host agents, for example 4000 (blank for none): 4000
```

The default is none. The port is published on the console bind address, with the console
certificate, so `tls-refresh` renews it too. The installation file records it as
`"console": {"nativeListeners": [{"port": 4000, "component": "magnus"}]}`, and the plan shows it
as `console.magnusAgentPort`. It is offered on fresh installations only for now; a distributed
Magnus has its own HTTPS endpoint, and adding the port to an existing installation is a follow-up.

The port is not the console. The ingress serves only the routes the agent and its Hermes sync
call (`GET /`, the heartbeat, log ingest, resource-lease, managed cron occurrence and Hermes
registry client routes) and answers 404 to everything else, including every operator, browser
and system route. Only the agent credentials (`x-node-token`, `x-log-token`,
`x-hermes-registry-token`), `Content-Type` and `Accept` reach Magnus: no `Authorization`, cookie
or `x-api-secret` passes, and `X-Forwarded-For` is the client's address. Bind the console to an
address that only your hosts can reach, or limit the port with your network's firewall: ports
Docker publishes bypass ufw.

This release pins no native agent artifact, so the agent is installed from npm, at the same
version as the suite's Magnus (listed in the release notes; 2.1.1 in 2.0.3), with Node.js 24.
On each host, as root:

```bash
npm install --prefix /opt/magnus-agent @hivemagnus/magnus-agent@2.1.1
install -d -m 0700 /opt/magnus-agent/certs
install -m 0644 /etc/hive/tls/console.crt /opt/magnus-agent/certs/agent.crt   # the host's certificate
install -m 0600 /etc/hive/tls/console.key /opt/magnus-agent/certs/agent.key
```

Write `/opt/magnus-agent/.env` (mode 0600). `NODE_MANAGER_SECRET` and `RESULT_SIGNING_SECRET`
are the suite Magnus's own, from `/opt/hive/config/magnus.env`; copy them without printing them:

```bash
{ printf 'CONTROL_API_URL=https://hive.example.com:4000\nHOST_FQDN=node-1.example.com\n'
  grep -E '^(NODE_MANAGER_SECRET|RESULT_SIGNING_SECRET)=' /opt/hive/config/magnus.env
  printf 'TLS_CERT_PATH=/opt/magnus-agent/certs/agent.crt\nTLS_KEY_PATH=/opt/magnus-agent/certs/agent.key\nNODE_ENV=production\n'
} | sudo install -m 0600 /dev/stdin /opt/magnus-agent/.env
```

Then check it and start the example unit from the package:

```bash
cd /opt/magnus-agent && node node_modules/@hivemagnus/magnus-agent/dist/index.js check
cp node_modules/@hivemagnus/magnus-agent/deploy/magnus-agent.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now magnus-agent
```

The first heartbeat registers the node; it appears under **Magnus > Nodes** within a minute.
Magnus calls the agent back on port 4100 of `HOST_FQDN`, so that name must resolve from the
Magnus container and present the agent's certificate. See the
[agent README](https://github.com/ChefTaco/magnus/blob/HEAD/packages/agent/README.md) for the
unprivileged mode and every setting.

## Sending security events to Cindertrace

A fresh Cindertrace ingests nothing until a collector exists. Each collector signs its events
with its own credential and may send only the sources it is allowed. Create one with `hive.sh`,
from the release checkout:

```bash
./hive.sh cindertrace-collector add edge --sources tailscale --config FILE
```

The credential is generated on the Cindertrace host into
`config/.credentials/cindertrace-collectors/edge` (mode 0600) and is never printed or passed
as an argument. The command turns ingestion on, records the change for later `install`,
`upgrade` and backup runs, and recreates only Cindertrace. `list` shows each collector, its
sources and credential file; `remove ID` revokes one, and removing the last turns ingestion
off. Sources are `unifi_dns`, `unifi_ids`, `netflow`, `wazuh`, `tailscale`, `magnus`, `hive`
and `chattermost`. Collectors survive upgrades: they live in the installation, not the release.

Collectors send to `https://hive.example.com/api/v1/security-fusion/ingest/events` through the
console origin. Cindertrace's own collector, `node services/security-collector/dist/index.js`
in the Cindertrace image the release pins, reads `CINDERTRACE_API_URL=https://hive.example.com`,
`SECURITY_FUSION_COLLECTOR_ID=edge` and `SECURITY_FUSION_INGEST_SECRET` from that file, plus its
source settings, such as `TAILSCALE_LOCAL_ENABLED=true`; see Cindertrace's
[integrations](https://github.com/ChefTaco/cindertrace/blob/HEAD/docs/INTEGRATIONS.md).

Any client can send a batch the same way. The signature is HMAC-SHA256, keyed with the
credential, over `COLLECTOR_ID.TIMESTAMP.NONCE.BODY`. A test event from the Cindertrace host:

```bash
secret=/opt/hive/config/.credentials/cindertrace-collectors/edge
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z) id=test-$(date +%s) nonce=$(openssl rand -hex 16)
body=$(jq -cn --arg now "$now" --arg id "$id" '{schemaVersion:"1.0",collectorId:"edge",sentAt:$now,
  events:[{schemaVersion:"1.0",eventId:$id,source:"tailscale",sourceEventId:$id,kind:"device.login",
  observedAt:$now,severity:"medium",confidence:0.9,summary:"Test event",entities:[],attributes:{},evidence:[]}]}')
signature=$(printf '%s' "edge.$now.$nonce.$body" | openssl dgst -sha256 -hmac "$(cat "$secret")" -r | cut -d ' ' -f1)
curl -sS -H 'Content-Type: application/json' -H "x-security-collector-id: edge" \
  -H "x-security-timestamp: $now" -H "x-security-nonce: $nonce" -H "x-security-signature: $signature" \
  --data "$body" https://hive.example.com/api/v1/security-fusion/ingest/events
```

It answers `202` with the stored count, and the event appears under **Cindertrace > Events**.
A batch with a bad signature is refused with `401` and leaves no trace. A batch that is signed
but refused, for example `403` for a source the collector may not send or `400` for an invalid
event, marks the collector's *Cursor health* as `ERROR` under **Cindertrace > Sources**. The
mark records only that last refusal: the collector's next accepted batch sets it back to
`HEALTHY`.

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
