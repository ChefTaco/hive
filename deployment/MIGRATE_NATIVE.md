# Migrating a native installation onto the suite

`hive.sh migrate-native` moves one existing native installation (Router, IAM, HiveMem and,
where installed, Skills as systemd services) onto the Docker suite on the same host and the
same ports. Clients keep their URLs, certificates, tokens and credentials. Each installation
is independent: run this once per host, with its own configuration. Data, links and tokens
are never shared between installations.

Nothing here touches inference services or model files.

## What stays, and what changes

| Stays | How |
| --- | --- |
| Native issuer, signing keys and verification keys | Copied byte for byte; `JWT_ISSUER` is unchanged |
| Users, password hashes, roles, client registrations | Rows are compared before and after. Additions are listed below |
| Migration history, audit rows and audit files | Copied. Product migrations only add to the history |
| Memory vectors | Restored through Qdrant's own snapshots; counts and content digests are compared |
| Machine-client policies and kept client names | `IAM_MACHINE_CLIENT_POLICIES` and `HIVE_ROUTER_*` are copied byte for byte |
| Redis records | Restored with their absolute expiry, never extended |
| The previous runtime, units and data | Kept. Native files are only read, except the markers listed under "Cutover" |

Added to the copy, and only to the copy: the `SUITE_ADMIN` role with no members unless a
reviewed grant names one, and the `hivexui-*` public browser clients. Product migrations also
add their own schema changes.

Changes people will notice:

- **Sign-in.** The native consoles used host (PAM) accounts. Containers have no PAM, so the
  console signs in through Oathweave. See [First sign-in](#first-sign-in).
- **Old console sessions** end. Agents and machine clients are not affected.
- **Direct Redis and Qdrant access** ends: the suite's stores are private. Anything reaching
  native port 6333 sees the stopped native store.
- **Certificate renewal** that restarted a native unit stops working. See
  [Certificates](#certificates).

## The native ports

The ingress listens on every native port and presents the exact certificate the native service
presented there, whatever TLS name the client sends. Requests pass through unchanged, including
streaming. Products keep private certificates from a new internal authority, so they reach each
other under their own names. The native authority's key is not copied into the suite.

| Port | Native service | Now reaches | Certificate |
| --- | --- | --- | --- |
| 443 | Router console and admin | Ingress: HiveXUI, `/api/<product>/*` and the native paths below | Router's |
| 4020 | Router model API | `emberpath:4020` | Router's |
| 4200 | IAM | `oathweave:4200` | IAM's, from its private CA |
| 18443, or `HIVEMEM_WEB_PORT` | HiveMem | `hivemem:18790` | HiveMem's |
| 4030 | Skills, where installed | `hiveskills:4030` | Skills' |

On port 443 a migrated installation keeps what the native Router served:

| Path | Reaches |
| --- | --- |
| `/v1/*`, `/dashboard` | **HiveMem**, as the native Router proxied them. A fresh suite sends `/v1/*` to the model API; a migrated one must not |
| `/health`, `/health/*`, `/api/*` not owned by a suite product | Emberpath's admin plane, including `/api/security/events` |

Ports owned by other services on the host are left alone. `plan` lists what it found. Add a
port to `console.nativeListeners` only if `plan` shows a native Hive service on it.

## Configuration

One owner-only JSON file per installation. Paths and names below are placeholders.

```json
{
  "schema": 1, "installation": "primary", "release": "1.0.0", "profile": "custom",
  "origin": "https://hive.example.com",
  "hosts": { "control": { "target": "deploy@hive.example.com", "directory": "/opt/hive-suite",
                          "sudoPasswordFile": "/secure/primary-sudo-password" } },
  "components": { "...": "hive-registry, oathweave, oathweave-redis, emberpath, hivemem, hivemem-qdrant, hivexui, ingress, and hiveskills where installed" },
  "agents": [], "inference": [],
  "console": {
    "host": "control", "bindAddress": "0.0.0.0", "httpsPort": 443,
    "runtimeFile": "/opt/hive-suite/config/runtime.json",
    "nativeListeners": [ {"port": 4020, "component": "emberpath"}, {"port": 4200, "component": "oathweave"},
                         {"port": 18443, "component": "hivemem"}, {"port": 4030, "component": "hiveskills"} ],
    "networkSubnet": "10.200.0.0/24"
  },
  "nativeMigration": {
    "schema": 1,
    "expectedHost": "hive", "machineIdSHA256": "<sha256 of /etc/machine-id>",
    "source": { "root": "/", "serviceManager": "systemd", "qdrantContainer": "<native qdrant container>" },
    "browserIssuer": "https://hive.example.com/api/oathweave",
    "reviewedLinksFile": "/secure/primary-links.json",
    "adminAccount": { "subject": "<oathweave user id>", "username": "admin", "tokenFile": "/secure/primary-reset-token" },
    "dataAliases": { "hiveskills": "/opt/hive-skills/shared/data" },
    "imageRegistry": { "server": "ghcr.io", "username": "<user>", "passwordFile": "/root/ghcr-token" }
  }
}
```

- `sudoPasswordFile`, on the controller, and `imageRegistry.passwordFile`, on the host, must be
  owner-only. Neither value ever reaches a command line. The image credential is removed from the
  host when `prepare` finishes.
- `networkSubnet` must not overlap anything on the host. The identity service trusts forwarded
  client addresses only from this subnet, so audit records keep the real client address.
- `dataAliases.hiveskills` keeps stored archive paths valid without rewriting a row.

### Reviewed links

The file holds explicit, approved entries only. `plan` lists the accounts on each side and what is
still missing. Nothing is ever matched by email, username or display name. A subject that does not
exist in this installation, or a local account that does not exist in the product, is refused.

```json
{ "schema": 1, "installation": "primary",
  "links": [ {"product": "emberpath", "subject": "<oathweave user id>", "localId": "<local id>", "approved": true} ],
  "grants": [ {"subject": "<oathweave user id>", "role": "SUITE_ADMIN", "approved": true} ] }
```

`hivemem` links name an agent ID. `hiveskills` links name an account in `HIVE_SKILLS_ADMIN_USERS`.
A grant is needed because roles created before the suite carry no product permissions.

## Phases

Each command is `hive.sh migrate-native <phase> --config FILE --manifest RELEASE --trust-key KEY`.
Every step leaves a receipt in `<directory>/migration/steps`, and repeating a command continues.

| Phase | What it does | Native services |
| --- | --- | --- |
| `plan` | Checks the installation binding, lists units, ports, certificates, sizes, accounts and missing decisions. Writes nothing | Running |
| `prepare` | Renders configuration, stages images, copies data online, applies product migrations to the copy, boots it with no ports, compares records, removes the copy | Running |
| `cutover` | See below | Stopped |
| `verify` | Checks the running suite while clients use it; see [Verification](#verification) | Stopped |
| `status` | Lists the receipts | Any |
| `rollback` | See below | Started |
| `issue-admin-token` | Issues a new reset token for the configured administrator | Stopped |
| `tls-refresh` | Reloads native certificates; see below | Stopped |
| `refresh-memory-token` | Copies a renewed `HIVE_ROUTER_MEMORY_PROXY_TOKEN` from the native Router environment into the suite Emberpath and recreates it | Stopped |

Run `prepare` close to the maintenance window, then `cutover` without changing the configuration:
the plan digest binds them. A configuration or link change requires `prepare` again.

### Cutover

1. Writes `/etc/hive/native-retired-to-suite`, adds a `ConditionPathExists` drop-in to each native
   unit and disables them, and disables the identity certificate timer. A reboot, timer or fleet
   restart therefore cannot start a native service. Unit files stay as they were.
2. Stops Router, Skills, IAM and Memory, in that order, and records the hashes of the native databases.
3. Takes the final copy with every writer stopped, restores vectors and Redis records, then stops
   the native Qdrant container.
4. Applies product migrations to the copy, adds the browser clients and reviewed grants.
5. Checks preservation on the copy, before the suite starts: see [Verification](#verification).
6. Starts the suite on the native ports, records it in the Hive Registry.
7. Runs the serving checks while clients reconnect.
8. Issues the administrator reset token.

If either check fails, the installation rolls back automatically. With `--hold-on-failure`, a
preservation failure leaves the suite unstarted and a serving failure leaves it running, for
inspection; then run `rollback`.

### Verification

Clients reconnect as soon as the suite publishes the native ports, and their requests change data
legitimately: an Emberpath API key records when it was last used, memories are written, the memory
worker runs its pending jobs, tokens are issued and audited. So verification has two phases.

**Preservation** runs on the migrated copy right after the product migrations, with only its Redis
and Qdrant running. No product, memory worker or published port exists yet, so nothing but the
migration has touched the data, and it is compared exactly with the copy taken when the native
services stopped:

- every row of every table of Oathweave, Emberpath and HiveSkills: no existing row may change or
  disappear (the migrations only add rows, such as the browser clients and the `SUITE_ADMIN` grant);
- every account, username and password hash;
- the signing and verification keys, byte for byte, and the issuer;
- every vector point: counts and content;
- every Redis record under the identity namespace, by value, except those whose own expiry passed.

The result is `<directory>/migration/preserved.json`, bound to the plan and to the capture receipt.

**Serving checks** run once the suite serves, and accept client writes:

- the preservation receipt is valid for this plan and this capture;
- every native port answers and presents its exact native certificate;
- a native machine client obtains a token signed by the native key, with the native issuer;
- the native memory credential works on the memory port and on the console port;
- the signing keys and the issuer are still the native ones, and the native stores still have the
  exact bytes recorded at the stop, which rollback requires;
- during cutover only, the credentials stay exact: account password hashes, and the existing rows
  of Oathweave `clients`, `roles` and `user_role_assignments` and of Emberpath `ClientApiKey`. A
  client using its API key may change only `ClientApiKey.lastUsedAt` and `updatedAt`. This list
  is `LIVE_COLUMNS` in `scripts/suite/migrate-native-data.mjs`.

The result is `<directory>/migration/verification.json`.

`verify`, run later against the live suite, repeats the serving checks without the credential
comparison, because by then the owner may have reset the administrator password or rotated a key.
It never compares live rows or vectors with the capture: preservation already proved those, before
any client could change them. Its result is `<directory>/migration/live-verification.json`.

### Rollback

Stops the suite, then checks that the native databases still have the exact bytes recorded at step 2,
and refuses to start anything if they do not. It reopens the units and starts Qdrant, Memory, IAM,
Router and Skills in that order.

**Writes made after cutover are not copied back.** They stay in `<directory>/attempts/<time>/data`,
and `rollback-receipt.json` reports what differs: rows per table and vector counts. Reconcile from
there by hand. This includes a password set after cutover: the native service keeps its previous
state. Tokens issued by the suite remain valid until they expire, because the signing keys are the
same. A later `prepare` and `cutover` start from the native stores again.

### Certificates

`tls-refresh` copies the current native certificates into the ingress and restarts it. Native
renewal is otherwise unchanged except for the identity leaf, which the disabled timer used to renew:
when that leaf has under seven days left, `tls-refresh` issues a new one from the native CA with the
same names and key, kept with the suite configuration. **Schedule `tls-refresh` at least weekly.**
Renew any certificate near expiry before `cutover`.

### Memory proxy token

Cutover copies the Router's `HIVE_ROUTER_MEMORY_PROXY_TOKEN` into `<directory>/config/emberpath.env`.
When something renews it in the native file `/opt/hive-router/shared/.env`, run
`refresh-memory-token`: it copies the current value, keeps the file owner-only, recreates Emberpath
and never prints the value. It does nothing when the suite already has that value.

## First sign-in

Roles and passwords carry over, so an administrator whose password had expired stays expired. The
owner sets a new password once, per installation, with a one-use token:

1. Cutover writes the token to `adminAccount.tokenFile` on the controller, mode 0600. It expires
   after 24 hours (`adminAccount.tokenTtlSeconds`). The identity store holds only its SHA-256, and
   only for the one account named in the configuration. `issue-admin-token` issues a new one and
   cancels the old one; it refuses to overwrite an existing token file.
2. On the host, on a terminal:

   ```bash
   sudo /opt/hive-suite/bin/hive-set-admin-password
   ```

   or, from the controller, `hive.sh migrate-native set-admin-password --config FILE`. It prompts for
   the token and the new password without echo. A protected file can replace the token prompt:
   `--token-file FILE`. Neither secret can be given as an argument. They leave the script only on
   standard input of the request to the identity service, so they appear in no command line,
   environment, log or history.
3. Sign in to the console at the installation's origin, then delete the token file.

The identity service enforces the rest. The password policy and history apply; a refused password
leaves the token unused. The route allows ten attempts per address in five minutes. A used,
expired or wrong token is refused. A success revokes the account's sessions, clears any lockout and
records `auth.password_reset_completed`; issuing records `auth.password_reset_issued`. Neither holds
a secret. No other account changes.

**MFA is left exactly as it is.** The reset does not disable or enrol anything, so an account with
MFA still needs its second factor. Enrol a passkey under Account security after first sign-in.

A console section works only when the account has a reviewed link and a grant for that product;
otherwise that section reports it needs a link. `plan` lists what is missing.

## Rehearsing

`scripts/suite/native-migration-rehearsal.mjs --config PRIVATE_JSON` runs the real native packages
and this controller on a restored copy, on a local Docker target with no outbound network. `backup-hive.sh
--online` takes the source archive without stopping a service; it is not a coordinated recovery point.
The default backup stops the native services while it captures state.
