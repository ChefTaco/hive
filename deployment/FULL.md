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
a Magnus node: [installing the agent](#installing-the-agent) adds one and approves its host key.

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

## Ardent Project Studio

[Ardent Project Studio](https://github.com/ChefTaco/ArdentStudio) (component `ardentstudio`) gives
Ardent agents shared team projects. HiveXUI shows its **Studio** section, a fullscreen page at
`/studio`, only when it is installed. A release offers it once its image is published
(`ghcr.io/cheftaco/ardent-studio`), and no profile selects it, so an installation without it, and
the upgrade of one, is unchanged. Interactive setup suggests it with the full profile when Magnus
and HiveMem are selected:

```text
Deploy Ardent Project Studio, team projects for Ardent agents (yes/no) [yes]:
```

An unattended configuration selects it as a component:

```json
"ardentstudio": {
  "host": "control",
  "envFile": "/opt/hive/config/ardentstudio.env",
  "configDirectory": "/opt/hive/config/ardentstudio"
}
```

It needs Magnus with at least one Ardent agent, and HiveMem, and runs on the console host with
Oathweave: its client secrets are generated there and never leave it. Magnus is the `magnus`
component or an [external Magnus](#external-magnus), and interactive setup offers Studio with
either. It needs a release whose
Oathweave supports browser-issued machine clients and whose Magnus links service identities
(role `ARDENT_SERVICE`). Fresh setup:

- registers the browser client `hivexui-ardentstudio` (audience `ardentstudio`, permissions
  `ardentstudio:projects:read|write`, `ardentstudio:templates:read|write`,
  `ardentstudio:review:write`, `ardentstudio:agents:admin`) and links the initial operator to a
  generated Studio account;
- declares two installation-owned Oathweave machine clients, because Oathweave binds one audience
  to each client: `ardentstudio-magnus` (audience `magnus`, permission `magnus:ardent`, tokens on
  the browser issuer) and `ardentstudio-hivemem` (audience `hivemem`, permissions
  `hivemem:workspaces:write` and `hivemem:memories:write`, tokens on the native issuer), each with
  a generated secret in `IAM_MACHINE_CLIENT_POLICIES` and `IAM_MACHINE_CLIENT_SECRETS`;
- links `ardentstudio-magnus` in Magnus's `MAGNUS_OATHWEAVE_IDENTITIES_JSON` with role
  `ARDENT_SERVICE`, and `ardentstudio-hivemem` in HiveMem's `HIVEMEM_OATHWEAVE_SERVICES_JSON` with
  the scopes `workspaces:write` and `memories:write`;
- writes `config/ardentstudio.env` and the internal certificate authority Studio uses to verify
  Oathweave, Magnus and HiveMem.

Studio calls Magnus and HiveMem directly on their HTTPS endpoints, as itself, never through the
browser routes. For work a person asked for it names that person in `x-acting-subject`; the
ingress removes that header from every browser request to Magnus. Studio listens on plain HTTP
port 8097 on the console host's private network. The ingress maps `/api/ardentstudio/*` to it with
the prefix kept, no cookies either way and unbuffered event streams; without Studio the path
answers 404. Its state is the `ardentstudio-data` volume (`data/ardentstudio`), backed up with the
rest of the installation ([BACKUPS.md](BACKUPS.md#ardent-project-studio)).

Adding Studio to an existing installation is not automated yet: configure the same clients, links
and environment by hand, then select the component.
[Adding an external Magnus and Studio to an existing installation](#adding-an-external-magnus-and-studio-to-an-existing-installation)
lists every entry; with Magnus as a component, add Studio's link to `MAGNUS_OATHWEAVE_IDENTITIES_JSON`
in `config/magnus.env` (and `config/magnus-gateway.env` with the gateway) instead of on an external
Magnus, and use `ARDENT_STUDIO_MAGNUS_URL=https://magnus:4000`. Studio's
README and `docs/OATHWEAVE.md` list its variables.

## External Magnus

An external Magnus is a Magnus control API that runs outside this installation: on another host,
managed and upgraded separately, with a publicly trusted certificate (for example from Let's
Encrypt, or a Tailscale certificate). The console's Magnus pages (fleet, Ardent, New Agent) use it
through the ingress `/api/magnus/*` routes with each person's Oathweave token, and Ardent Project
Studio can run on the console host without the `magnus` component. The installation configuration
names it at the top level:

```json
"external": {
  "magnus": { "url": "https://magnus.example.com:4000" }
}
```

The URL is HTTPS with a fully qualified DNS host name (not an IP address) and an optional port, and
nothing else: no path, query or credentials. It takes the place of the `magnus` component, so
`magnus`, `magnus-postgres`, `magnus-redis` and `magnus-gateway` are not selected, and the full
profile, which selects Magnus, is not used (choose core or custom). It needs the console, a release
that offers Magnus and a URL other than the console origin, and no `console.nativeListeners` entry for
`magnus`. It works on a fresh installation and on one moved with `migrate-native`. `hive.sh plan` shows it as `external`, and `hive.sh doctor` names it. Interactive setup asks
for it when Magnus is not selected:

```text
External Magnus HTTPS URL, managed outside this installation (blank for none):
```

Fresh setup with an external Magnus:

- registers the browser client `hivexui-magnus` (audience `magnus`, permissions `magnus:view`,
  `magnus:operate`, `magnus:admin`) exactly as for the component, and lists `magnus` in the console's
  `runtime.json` (`products.magnus` is `/api/magnus`, `identity.clients.magnus` is `hivexui-magnus`);
- routes the ingress Magnus routes to it: `config/ingress.env` gets
  `MAGNUS_ENDPOINT=https://magnus.example.com:4000`, `MAGNUS_TLS_NAME=magnus.example.com` and
  `MAGNUS_TRUST_FILE=/etc/ssl/certs/ca-certificates.crt`. The ingress verifies the external Magnus
  against its image's system trust store and on that host name, which it also sends as the TLS
  server name and the `Host` header; it never skips verification, and
  every product inside the installation is still verified against the suite authority only. The
  browser routes keep the same allowlist, and still remove `x-acting-subject`, machine credentials
  and cookies both ways;
- with Studio, writes `ARDENT_STUDIO_MAGNUS_URL=https://magnus.example.com:4000` into
  `config/ardentstudio.env` (Studio trusts public authorities as well as the suite authority in
  `NODE_EXTRA_CA_CERTS`) and declares the machine client `ardentstudio-magnus` on the browser issuer,
  as for the component;
- records Magnus in the Hive Registry as installed and `external`, with the URL and no host, version
  or image, so the console shows its section; `status` lists it under `externallyManaged`;
- writes `config/.initializer/external-magnus.env` on the Oathweave host (owner-only, recorded in the
  initialization receipt) and prints where it is. Hive cannot change another host's Magnus, so this
  file holds the entries to add there. None of them is a secret:

  ```text
  OATHWEAVE_ISSUER=https://console.example.com/api/oathweave
  OATHWEAVE_JWKS_URL=https://console.example.com/api/oathweave/oauth/jwks
  OATHWEAVE_USERINFO_URL=https://console.example.com/api/oathweave/oauth/userinfo
  MAGNUS_OATHWEAVE_IDENTITIES_JSON='[{"issuer":"https://console.example.com/api/oathweave","subject":"OPERATOR_SUBJECT","localUserId":"MAGNUS_ID","role":"ADMIN"},{"issuer":"https://console.example.com/api/oathweave","subject":"ardentstudio-magnus","localUserId":"ardentstudio","role":"ARDENT_SERVICE"}]'
  ```

  The issuer is Oathweave's browser issuer. The external Magnus reads the key set and userinfo
  through the console origin, which maps `/api/oathweave/*` to Oathweave's `/api/v1/*`, so it must
  reach the console and trust its certificate (add the console's authority to that Magnus's
  `NODE_EXTRA_CA_CERTS` if it is not publicly trusted). `OPERATOR_SUBJECT` is the initial
  operator's Oathweave ID (`config/.initializer/secrets/identity-id`) and `MAGNUS_ID` a generated
  Magnus account ID (`config/.initializer/secrets/magnus-id`). The second link, Studio's service
  identity, is there only with Studio. A Magnus trusts one Oathweave issuer and refuses
  `OATHWEAVE_ISSUER` together with `IAM_CORE_URL`; merge the links with any that Magnus already has.
  The JSON is single-quoted, which Docker Compose, systemd and dotenv files remove. Then restart
  that Magnus.

On a migration (`hive.sh migrate-native prepare` with `external` in the configuration), the
migration writes the same `ingress.env` entries and `runtime.json` entry, adds `hivexui-magnus` to
`IAM_BROWSER_CLIENT_POLICIES`, and creates that client and its permissions in `SUITE_ADMIN` with the
console's other clients. Its native listeners and reviewed links are unchanged: no native listener
serves Magnus, and Magnus's identity links live on the external Magnus. It writes no
`external-magnus.env`; build the entries as described for an existing installation below.

Not configured for an external Magnus: the Magnus host agent port (`console.nativeListeners`; agents
connect to the external Magnus directly), the web terminal gateway (`magnus-gateway`, which runs
beside its Magnus; the terminal routes answer 404), and Magnus's HiveMem service identity
`magnus-hivemem`, as for a Magnus on another host ([Magnus and HiveMem](#magnus-and-hivemem)):
configure the latter on that Magnus by hand, or Ardent New Agent answers
`HIVEMEM_ENROLLMENT_UNAVAILABLE`. Host preflight (`install`, `upgrade` and `doctor`) refuses a
console host whose `ingress.env`, `runtime.json` or Studio environment does not use the external
Magnus, and warns when the external Magnus does not answer `/api/v1/health` from the console host
with a certificate its system trust store accepts.

### Adding an external Magnus and Studio to an existing installation

This applies to an installation set up fresh or moved with `migrate-native`. `hive.sh upgrade` does
not regenerate product environments or `runtime.json` on an existing installation. With the new
configuration it writes:

- the Compose definition, which then runs Studio (`env_file` `config/ardentstudio.env`,
  `config/ardentstudio` at `/config`, data in `data/ardentstudio`, created owned by Studio's user)
  and no Magnus. Studio's store starts at its release's storage format. An installation set up before
  Studio existed has no Studio format in `data-formats.json`; a component the upgrade adds, with no
  recorded format and no data, has nothing to migrate, so the upgrade records the release's format,
  as a fresh install does. Data in `data/ardentstudio` without a recorded format still stops the
  upgrade with `Storage transition needs --allow-migrations`;
- the ingress `config/ingress/Caddyfile`, replaced by this release's whenever it differs (the
  previous one is kept as `Caddyfile.previous`); `MAGNUS_TRUST_FILE` needs this release's Caddyfile;
- the Hive Registry record, with Magnus as `external`.

Everything else is edited by hand, on the console host, which must also run Oathweave (Studio's
requirement), before the upgrade. The steps below use `/opt/hive` as the installation directory,
`https://console.example.com` as the console origin and `https://magnus.example.com:4000` as the
external Magnus; they match what fresh setup generates, entry for entry. Keep every file owner-only
(mode 0600, its current owner) except `runtime.json` (0644), and back up first
(`hive.sh backup`). Where a migrated installation differs, the step says so.

1. **Generate four values** of 64 hex characters, owner-only, as fresh setup names them:

   ```bash
   cd /opt/hive/config/.initializer/secrets   # a migrated installation: /opt/hive/config/.migration/secrets
   for name in magnus-id studio-id studio-magnus-client studio-hivemem-client; do
     (umask 077; [ -e "$name" ] || openssl rand -hex 32 > "$name")
   done
   ```

   `magnus-id` is the operator's Magnus account ID, `studio-id` the operator's Studio account ID,
   and the other two are the Studio clients' secrets. `OPERATOR_SUBJECT` below is the operator's
   Oathweave user ID: `identity-id` in the same directory on a fresh installation, and on a migrated
   one the operator's native account ID (`nativeMigration.adminAccount.subject`, or a subject granted
   `SUITE_ADMIN` in the reviewed links file). `USERNAME` is that account's username.
   `BROWSER_ISSUER` is `IAM_BROWSER_ISSUER` in `config/oathweave.env` (`https://console.example.com/api/oathweave`
   on a fresh installation, `nativeMigration.browserIssuer` on a migrated one).

2. **Oathweave** (`config/oathweave.env`). Merge these keys into the JSON objects already there,
   keeping every existing key (such as `emberpath-hivemem`):

   - `IAM_BROWSER_CLIENT_POLICIES`:
     `"hivexui-magnus":{"audience":"magnus","permissions":["magnus:view","magnus:operate","magnus:admin"]}`
     and `"hivexui-ardentstudio":{"audience":"ardentstudio","permissions":["ardentstudio:projects:read","ardentstudio:projects:write","ardentstudio:templates:read","ardentstudio:templates:write","ardentstudio:review:write","ardentstudio:agents:admin"]}`;
   - `IAM_MACHINE_CLIENT_POLICIES`:
     `"ardentstudio-magnus":{"audience":"magnus","permissions":["magnus:ardent"],"lifetimeSeconds":300,"rotationOwner":"hive-suite","issuer":"browser"}`
     and `"ardentstudio-hivemem":{"audience":"hivemem","permissions":["hivemem:workspaces:write","hivemem:memories:write"],"lifetimeSeconds":300,"rotationOwner":"hive-suite"}`;
   - `IAM_MACHINE_CLIENT_SECRETS`: `"ardentstudio-magnus":"STUDIO_MAGNUS_CLIENT"` and
     `"ardentstudio-hivemem":"STUDIO_HIVEMEM_CLIENT"`, the contents of `studio-magnus-client` and
     `studio-hivemem-client`.

   Leave `config/oathweave/suite-bootstrap.json` alone: Oathweave reads it only when it seeds an
   empty store.

3. **HiveMem** (`config/hivemem.env`). Append to the `HIVEMEM_OATHWEAVE_SERVICES_JSON` array (create
   it as `[...]` if absent)
   `{"issuer":"NATIVE_ISSUER","clientId":"ardentstudio-hivemem","localId":"ardentstudio","scopes":["workspaces:write","memories:write"]}`,
   where `NATIVE_ISSUER` is `JWT_ISSUER` from `config/oathweave.env`.

4. **Studio** (`config/ardentstudio.env`, new, owned by Studio's service user `1000:1000`):

   ```text
   NODE_ENV=production
   NODE_EXTRA_CA_CERTS=/config/authority.pem
   ARDENT_STUDIO_HOST=0.0.0.0
   ARDENT_STUDIO_PORT=8097
   ARDENT_STUDIO_DATA=/data
   OATHWEAVE_ISSUER=BROWSER_ISSUER
   OATHWEAVE_JWKS_URL=https://oathweave:4200/api/v1/oauth/jwks
   OATHWEAVE_USERINFO_URL=https://oathweave:4200/api/v1/oauth/userinfo
   ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON=[{"issuer":"BROWSER_ISSUER","subject":"OPERATOR_SUBJECT","localUserId":"STUDIO_ID","displayName":"USERNAME"}]
   ARDENT_STUDIO_OATHWEAVE_TOKEN_URL=https://oathweave:4200/api/v1/oauth/token
   ARDENT_STUDIO_MAGNUS_URL=https://magnus.example.com:4000
   ARDENT_STUDIO_MAGNUS_CLIENT_ID=ardentstudio-magnus
   ARDENT_STUDIO_MAGNUS_CLIENT_SECRET=STUDIO_MAGNUS_CLIENT
   ARDENT_STUDIO_MAGNUS_SCOPE=magnus:ardent
   ARDENT_STUDIO_HIVEMEM_URL=https://hivemem:18790
   ARDENT_STUDIO_HIVEMEM_CLIENT_ID=ardentstudio-hivemem
   ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET=STUDIO_HIVEMEM_CLIENT
   ARDENT_STUDIO_HIVEMEM_SCOPE='hivemem:workspaces:write hivemem:memories:write'
   ```

   `STUDIO_ID` is the contents of `studio-id`.

5. **Studio's trust** (`config/ardentstudio/authority.pem`): a copy of the authority the ingress
   verifies the products with, `config/ingress/backend-ca.pem`, in a directory of mode 0700, both
   owned by `1000:1000`.

6. **Ingress** (`config/ingress.env`). Replace any `MAGNUS_ENDPOINT` and `MAGNUS_TLS_NAME`, and add:

   ```text
   MAGNUS_ENDPOINT=https://magnus.example.com:4000
   MAGNUS_TLS_NAME=magnus.example.com
   MAGNUS_TRUST_FILE=/etc/ssl/certs/ca-certificates.crt
   ARDENTSTUDIO_ENDPOINT=http://ardentstudio:8097
   ```

7. **Console** (`config/runtime.json`). Add `"magnus":"/api/magnus"` and
   `"ardentstudio":"/api/ardentstudio"` to `products`, and `"magnus":"hivexui-magnus"` and
   `"ardentstudio":"hivexui-ardentstudio"` to `identity.clients`. HiveXUI mounts this one file, so
   rewrite it in place rather than replacing it:
   `jq '.products+={magnus:"/api/magnus",ardentstudio:"/api/ardentstudio"} | .identity.clients+={magnus:"hivexui-magnus",ardentstudio:"hivexui-ardentstudio"}' runtime.json > runtime.json.new && cat runtime.json.new > runtime.json && rm runtime.json.new`.

8. **The external Magnus.** Add the four entries shown above to its environment, with
   `BROWSER_ISSUER` for the issuer in all three places, `OATHWEAVE_JWKS_URL` and
   `OATHWEAVE_USERINFO_URL` on the console origin, `OPERATOR_SUBJECT`, and `MAGNUS_ID` the contents
   of `magnus-id`. Restart it.

9. **Record the edits** so `hive.sh tls-refresh` still accepts the generated files it checks (a
   migrated installation has no initialization receipt and skips this step):

   ```bash
   cd /opt/hive/config
   for file in oathweave.env hivemem.env ingress.env runtime.json; do
     jq --arg path "$PWD/$file" --arg sha "$(sha256sum "$file" | cut -d ' ' -f1)" \
       'if .files[$path] then .files[$path]=$sha else . end' .initializer/receipt.json > .initializer/receipt.json.new
     chmod 600 .initializer/receipt.json.new && mv .initializer/receipt.json.new .initializer/receipt.json
   done
   ```

10. **The installation configuration.** Add the `external` object and the `ardentstudio` component
    (the JSON in [Ardent Project Studio](#ardent-project-studio), with this host and its paths), then
    review the plan and upgrade:

    ```bash
    ./hive.sh plan --config installation.json --release VERSION
    ./hive.sh upgrade --config installation.json --release VERSION
    ```

    Preflight refuses the upgrade until steps 4, 6 and 7 are in place. Compose recreates Oathweave,
    HiveMem and the ingress, whose environments changed, and starts Studio.

11. **Oathweave's browser clients and grants.** Oathweave now runs with the two browser policies, but
    an existing store has no such clients, and `SUITE_ADMIN` holds none of their permissions:

    ```bash
    ./hive.sh console-clients add --config installation.json
    ```

    It runs one transaction inside the running Oathweave container, with no token: it creates
    `hivexui-magnus` and `hivexui-ardentstudio` as public, first-party clients with the
    `authorization_code` grant and the console's `/auth/callback`, exactly as fresh setup seeds them,
    and adds the nine permissions of their policies to the `SUITE_ADMIN` role, which fresh setup and
    `migrate-native` create for the operator. It refuses, and changes nothing, when the running
    Oathweave lacks either policy, when the store has no `SUITE_ADMIN`, when a client of that name
    exists with another type or callback, or when any other user, role, client or assignment would
    change. A repeat changes nothing. Sign out and in again so the console gets tokens for Magnus
    and Studio.

The external Magnus alone: generate only `magnus-id` (step 1), add only the `hivexui-magnus` policy (step 2), skip
steps 3 to 5, leave out `ARDENTSTUDIO_ENDPOINT` (step 6), Studio's runtime entries (step 7) and
Studio's link (step 8), add only the `external` object (step 10), and create only `hivexui-magnus`
with the three Magnus permissions (step 11, which does that by itself without Studio). This section covers an installation without the
`magnus` component; moving a Magnus that the installation runs to another host is not covered.

## Magnus and HiveMem

Magnus's Ardent New Agent and Enable HiveMem give every Ardent agent its own HiveMem identity.
Magnus asks HiveMem for each agent's credential as its own Oathweave service identity, so no
long-lived HiveMem admin token exists. When Magnus, HiveMem and Oathweave are selected and Magnus
runs on the Oathweave host, fresh setup:

- declares the machine client `magnus-hivemem` (audience `hivemem`, tokens on the native issuer)
  with the permissions `hivemem:admin:agents`, `hivemem:workspaces:write` and the scopes Magnus
  grants agents (`hivemem:memories:read|write`, `hivemem:sessions:read|write`), and a generated
  secret in `IAM_MACHINE_CLIENT_POLICIES` and `IAM_MACHINE_CLIENT_SECRETS`;
- links it in HiveMem's `HIVEMEM_OATHWEAVE_SERVICES_JSON` as the principal `magnus-ardent` (an
  ID of its own, apart from any agent) with the same scopes;
- writes `MAGNUS_ARDENT_HIVEMEM_URL`, `MAGNUS_ARDENT_HIVEMEM_TOKEN_URL`,
  `MAGNUS_ARDENT_HIVEMEM_CLIENT_ID`, `MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET`,
  `MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID=ardent-agents` and `MAGNUS_ARDENT_HIVEMEM_AGENT_URL` (the
  console's `/memory/` route, which agents on fleet nodes reach) into `config/magnus.env`.

Magnus creates the `ardent-agents` workspace on first use and owns it. The secret stays in the
Oathweave and Magnus environments. When Magnus runs on another host, setup says so and leaves this
out; configure it by hand with the entries above (Magnus's `docs/ARDENT.md` shows them) and a
secret of 64 hex characters. An existing installation is configured the same way: merge the policy,
secret and link into the existing values, add the Magnus entries, and restart Oathweave, HiveMem
and Magnus.

## Magnus and HiveSkills

Magnus's Ardent skill install puts HiveSkills catalog releases onto Ardent profiles. When HiveSkills
is selected, fresh setup writes `MAGNUS_ARDENT_HIVESKILLS_URL` into `config/magnus.env`: the
registry's internal HTTPS address (`https://hiveskills:4030`, or its endpoint in a distributed
installation). Magnus accepts only an HTTPS URL; it trusts the registry's certificate through the
suite authority in `NODE_EXTRA_CA_CERTS`, and sends no credential, because catalog reads are public
within the suite network. Magnus checks every archive against the catalog's SHA-256. Without
HiveSkills the entry is left out and skill install answers `HIVESKILLS_UNCONFIGURED`. On an
existing installation, add the entry by hand and restart Magnus.

## Magnus command reconciliation

An Ardent action whose outcome Magnus could not confirm holds its command until an ADMIN settles it
from the Ardent installations page. Settling an outcome the node agent itself records as unknown
needs `COMMAND_RECONCILIATION_SECRET`: one independent key of at least 32 characters, the same on
the Magnus server and every node agent. Fresh setup generates it into `config/magnus.env`, and
`hive.sh magnus-agent install` copies it into each agent's environment beside the node credentials
(see below). On an existing installation, add a new random value (for example
`openssl rand -hex 32`) to `config/magnus.env`, restart Magnus, and run
`hive.sh magnus-agent install` again for each host, or add the same line to each agent's
`/opt/magnus-agent/.env` and restart `magnus-agent`. Without it, that one decision answers
`RECONCILIATION_UNAVAILABLE`; everything else works.

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

### Installing the agent

One command installs the agent on the Magnus host, from the release checkout:

```bash
./hive.sh magnus-agent install --config FILE
```

It runs on the host through the same transport as every other `hive.sh` step: locally (asking
for your sudo password, as the agent is a root service), or over SSH with the host's
`sudoPasswordFile`. `--host ID` names another inventory host, and `--host deploy@node-1.example.com`
any fleet host, with `--ssh-config FILE` and `--sudo-password-file FILE` as that host needs. It:

1. checks the host: systemd, port 4100 free for the agent, and Node.js against the agent's
   `^24.22.1 || ^26.13.0`. Without a suitable Node.js it offers to install Node.js 24 from
   NodeSource's signed apt repository, after checking its key fingerprint
   `6F71F525282841EEDAF851B42F59B5F99B1BE0B4`; `--install-node` agrees unattended, and
   without consent it stops and prints the manual steps;
2. downloads exactly the agent version the release pins for its Magnus
   (`components.magnus.agentPackage`) and installs it only if the tarball matches the pinned
   npm integrity. The tarball must include a complete standalone `npm-shrinkwrap.json`, which
   pins every registry dependency and its integrity. The staged install uses `npm ci` with
   lifecycle scripts disabled and an explicit public npm registry, then runs the agent check
   before replacing a package. Older unlocked tarballs are refused; this controller requires a
   new locked Magnus agent artifact in a newly signed suite release;
3. prepares a dedicated non-root `hive-agent` account for native profiles, enables its user
   services at boot, and writes `ARDENT_OWNER_USER` in `/opt/magnus-agent/.env`. An explicitly
   configured owner and other native-runtime settings survive repairs and upgrades. The root-only
   environment also has `CONTROL_API_URL` from the console name and
   the agent port. The node credentials (`NODE_MANAGER_SECRET`, `RESULT_SIGNING_SECRET` and,
   when Magnus has one, `COMMAND_RECONCILIATION_SECRET`) come from the Magnus host's own configuration; for
   another host they stream through the controller on standard input only. They are never
   printed and never a command-line value;
4. runs the agent's `check`, then its own `install-service`, which sets up the versioned layout
   and unit that Magnus-driven upgrades use, and starts it;
5. waits up to two minutes for Magnus to accept the first heartbeat and reports the node ID;
6. with the web terminal gateway, reads the host's SSH host key fingerprint on the host and
   offers to approve it (`--trust` agrees unattended), so the terminal works at once.

The installer also stages the exact Ardent package pinned by the signed host agent's dependency
lock. It verifies the npm integrity and prepares the package manifest the node agent checks. The
public package files live beside the protected agent directory, readable by the native owner;
credentials stay root-only. In **Magnus > Ardent installations**, choose **Install package**, then
create a profile with **New Agent**, after the enrollment review below. Staging never installs or starts an Ardent runtime. A custom
`ARDENT_STAGED_PACKAGE` remains operator-managed. Removing the host agent retains its native owner
record, runtime artifacts and profiles, so a reinstall can recover the same ownership.

For full node capabilities on an installer-owned single-host installation, run:

```bash
./hive.sh magnus-agent enroll --config FILE
```

The guided installer offers this after the host agent, whether or not Studio is selected.
It prepares the host cron service, temporarily pauses the native owner's running Ardent profile
units, and prints a review of initializer provenance, ownership, retained history, process trees,
and the complete observed scheduler sources. Approval verifies all four live participants
(agent, API, gateway or declared-absent console, and scheduler), then completes node enrollment.
Commands and managed cron become available; a selected gateway provides restricted web terminals.
OS maintenance cron and timers remain outside Magnus and are left unchanged. The managed terminal
runs without sudo, with a read-only host filesystem and private temporary files. The node stops
its entire bounded process group before signing completion; terminal bytes are never recorded.

This also promotes an Ardent-only node created by the installer, preserving profiles and completed
Ardent command history. Unknown or unrelated command effects, foreign user cron, native schedulers,
incomplete source inventories and unsettled owners are held for independent review. The original
profile units resume on success, refusal or a repeated command after interruption; stopped units
are not newly enabled. `--yes` accepts the displayed bounded review unattended. If evidence changes,
review again. Repeating completed enrollment does not drain or restart the agent.

An intentionally limited installation can still use `magnus-agent prepare-ardent --config FILE`.
That empty-node path enables only Ardent actions and leaves full enrollment pending. It is no
longer the guided full-node default. Existing nodes outside installer provenance and distributed
installations use Magnus's independent workflow in
[command resource leases](https://github.com/ChefTaco/magnus/blob/main/docs/COMMAND_RESOURCE_LEASES.md).

Running it again repairs the installation, or upgrades the agent in place to the version a newer
release pins. `./hive.sh magnus-agent status --config FILE` prints one JSON document: the
installed version, the service state, Magnus's last heartbeat and the web terminal approval;
`remove` stops and removes the agent, and with `--trust` also revokes the approval. Magnus keeps
its record of the node.

The agent's listener certificate is the console certificate on the console host, renewed with it:
`console-certificate.sh renew` and its weekly timer restart the agent after a renewal; after a
manual `tls-refresh`, run `sudo systemctl restart magnus-agent`. On any other host, the agent
gets a `tailscale cert` for the host's MagicDNS name and renews it itself.

Magnus calls the agent back on port 4100 of its host name, so that name must resolve from the
Magnus container. See the
[agent README](https://github.com/ChefTaco/magnus/blob/HEAD/packages/agent/README.md) for every
agent setting.

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
