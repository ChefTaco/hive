# Isolated recovery acceptance

No passing result authorizes a production cutover. Keep independent installations,
original archives, signing keys, credentials and native client registrations separate.
Use a fresh output directory for each attempt; failed evidence is retained.

The Bash controller's `rehearse --archive ID` command operates on installer-owned
suite backups. `npm run test:suite:lifecycle` exercises that format with disposable
SQLite data and exact migrations, including interrupted/uncertain outcomes. It does
not import native legacy installations or certify interactive core/full installs.

## Existing native installations

Prefer direct application export from a native schema-version-2 archive: provide
its original SHA256 and reviewed external-path exclusions. The harness verifies
ownership and member safety before exporting application state, without extracting
model assets. Older, already-materialized recovery roots remain accepted for
compatibility; model paths are excluded from candidate copies. Preserve original
archives and existing legacy recovery evidence even when they contain historical
model assets. Never use this tooling to overwrite a running installation.

The developer acceptance command `npm run test:suite:native -- --config PRIVATE_JSON`
runs independently extracted candidates against **new copies** of the archived
application stores. This Node test harness is separate from the Bash installer;
Node is not a controller runtime dependency. The operator needs Docker access and
must be unprivileged. Its private configuration has this shape:

```json
{
  "output": "/opt/rehearsals/candidate-001",
  "allowMigrations": true,
  "verifyExistingCredentials": false,
  "images": {
    "utility": "example.com/recovery-node@sha256:<reviewed-digest>",
    "redis": "example.com/redis@sha256:<reviewed-digest>",
    "qdrant": "example.com/qdrant@sha256:<reviewed-digest>",
    "oathweave": "oathweave:candidate",
    "emberpath": "emberpath:candidate",
    "hivemem": "hivemem:candidate",
    "hiveskills": "hiveskills:candidate"
  },
  "installations": [{
    "id": "installation-one",
    "expectedHost": "installation-one",
    "archive": "/opt/backups/installation-one-state.tar.gz",
    "archiveSHA256": "<reviewed-original-archive-sha256>",
    "externalPaths": ["state/var/opt/hivemem/models"]
  }]
}
```

Use actual reviewed image digests; candidate tags are resolved and recorded as
immutable local image identities before the run. These local candidates are not
published or certified suite releases. The utility image must provide Node with
its built-in SQLite module. The configured output parent must belong to the
operator and have mode 0700; configuration and reports have mode 0600.

Review `externalPaths` against each archive's inventory. These recovery-relative
paths are excluded from candidate exports. Model assets outside reviewed exclusions
hold the run. Original archives and legacy recovery copies remain unchanged; the
harness does not move or delete models. No inference service or model download is
part of this rehearsal. External provider database configurations are preserved,
while outbound network isolation prevents their use by restored applications.

The harness verifies durable restored-file hashes (SQLite shared-memory indexes
are transient), restores all Qdrant snapshots into a fresh private datastore,
restores Redis records without extending absolute expiry, and plans migrations
before applying them to copies. `allowMigrations` permits clone-only execution of
the exact product migration plan. Original database rows, signing-key bytes and
Qdrant vector/payload digests must survive candidate startup. The generated
Emberpath OpenAPI cache is recorded separately from durable configuration.

Candidate applications run non-root with read-only root filesystems, dropped
capabilities and internal-only networks. They receive only their own copied stores
and temporary rehearsal transport certificates. Native issuer values, authentication
secrets and signing keys are retained. HiveSkills' existing archive paths are
preserved through container mounts to its own copied archive directory. Memory
and skill workers are disabled **before** interrupted-job recovery, so queued and
running outcomes are retained. No host agent, collector, external inference service
or production dispatcher is launched. The harness cleans up only its own named
containers/networks, retaining copied data, migration plans, logs and receipts.

Optionally enable `verifyExistingCredentials` to check saved native credentials on
copies after data-preservation checks. Credentials and tokens remain in protected
files or helper-process memory; password resets and wildcard-token creation are
never used. Missing/expired credentials and MFA challenges remain explicit gaps.
These requests can create ordinary test sessions/audit events in candidate data.
They do not establish browser SSO, passkey or real agent acceptance.

An optional installation `browser` object enables an operator-reviewed loopback-only
HTTPS browser check. Include `port`, the reviewed Oathweave `subject` and product
`localId`, `credentialReference: {"file": "/opt/private/credentials.env",
"passwordKey": "TEST_PASSWORD"}`, and `reviewSeconds` (0–300). Also provide
`hivexui` and `ingress` candidate images. The referenced file must be operator-owned
and mode 0600. No password value belongs in the configuration or command line.
The temporary credential handoff is removed when the check finishes.

This check preserves existing password expiry and MFA requirements. An expired
password records `blocked-password-expired`, leaves authenticated acceptance false,
and permits inspection of the sign-in error only. It never resets a password,
changes the password policy, or promotes a role. With an accepted current credential,
the check registers an isolated public browser client through the authorized API,
then checks PKCE, the reviewed existing product ID, read-only access, denied mutation,
code replay and session revocation. A separate real-browser review is still required;
protocol success alone cannot mark browser acceptance complete. The temporary ingress
exposes only a loopback port; backend networks remain private with workers disabled.

A cutover additionally requires a fresh host-bound backup, authenticated browser
and real agent/provider/memory workflow acceptance, all product parity gates,
reviewed links, a maintenance window, one active writer/dispatcher, compatible
rollback or rehearsed recovery, and reconciliation of subsequent writes. Preserve
legacy entrypoints until these requirements pass.
