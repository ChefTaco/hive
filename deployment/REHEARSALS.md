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

## Unknown passwords: a separate authentication fork

A saved seed password is not evidence of a current operator password. If the
current password is unknown, expired or requires unavailable MFA, keep the
existing-account authentication gate pending. Do not reset an existing password,
replace its hash, promote an existing user, disable MFA or relax the password
policy to make a rehearsal pass.

An explicitly authorized temporary-account review is a separate, operator-managed
procedure, not an automatic fallback of `test:suite:native`:

1. Complete the original archive/restore integrity checks first. Preserve the
   original archives, copied preservation baseline and original signing/session
   key files unchanged. Make another independent copy for authentication testing;
   never mount the original database or a live installation into this fork.
2. Give the fork a distinct runtime identity: new signing keys, a separate HTTPS
   native/browser issuer and new product session secrets, issuers and audiences.
   Configure every participating product to trust only this fork's identity and
   endpoints. Do not retain production signing keys as previous verification keys
   or fall back to production discovery, userinfo or JWKS. Use separate runtime
   configuration and key files instead of overwriting preserved originals. Keep
   data-encryption material needed to read restored data protected and unchanged;
   changing runtime trust is not a rotation of archived encryption keys.
3. Create a clearly named temporary account, such as `rehearsal-review`, only in
   this copied data. Use the existing password policy and grant a new temporary
   role only the permissions needed for the selected review. For each exercised
   product, create a separate temporary local account and an explicit link from
   the fork issuer and temporary Oathweave subject. Do not bind that subject to an
   existing administrator, infer ownership from email, or modify reviewed links
   belonging to existing accounts. Retain all original users, password hashes,
   memberships and ownership records.
4. Keep credentials and links in protected operator files and memory. Keep
   dispatchers, collectors, retention, integrations, agents and outbound access
   disabled unless a separately selected disposable fixture requires an exact
   internal endpoint. Temporary accounts and fork-signed credentials must not
   authenticate to production. Never import the fork back into an installation.
5. Record temporary-account browser results separately from existing-account
   authentication, real ownership and migration acceptance. After review, stop
   only the owned rehearsal services and retain protected evidence. The temporary
   flow never closes an existing-administrator ownership or authentication gate.

The baseline harness preserves native issuer and key bytes for recovery proof.
The additional authentication fork deliberately uses distinct runtime trust. Do
not report these as the same check, and do not weaken the preservation check to
accommodate temporary credentials.

When a forwarded browser uses a different visible origin, add only that exact
HTTPS origin to the fork's explicit `CORS_ORIGIN` allowlist. Preserve the browser's
original `Origin` header. Do not use wildcards, rewrite `Origin` to an allowed
value, disable certificate verification or derive the configured issuer from
forwarded headers. Keep canonical issuer, authorization and discovery URLs
explicit; document the separate browser transport origin in protected evidence.

## Central authorization and optional standalone security sign-in

HiveXUI provides `/auth/authorize` for explicitly registered Oathweave public
clients. It accepts standard Authorization Code with PKCE S256 parameters, reuses
SSO, password/MFA and consent, and returns the backend-issued code only after
checking state, configured issuer and the exact registered HTTPS callback.
Unknown/repeated parameters, unsafe callbacks and declined consent remain local
errors. In-flight and completed requests are deduplicated; logout or session
invalidation prevents a late redirect. The requesting application's backend keeps
its verifier and exchanges the code. HiveXUI does not exchange that external
client's code or persist its credentials.

Oathweave's optional client-scoped discovery requires explicit public metadata:

```dotenv
IAM_BROWSER_ISSUER=https://identity.example.com
IAM_BROWSER_AUTHORIZATION_URL=https://identity.example.com/auth/authorize
IAM_BROWSER_API_BASE_URL=https://identity.example.com/api/oathweave
```

Both endpoint URLs must use HTTPS on the issuer's exact origin, without credentials,
query parameters or fragments. The browser discovery request is:

```text
https://identity.example.com/api/oathweave/oauth/.well-known/openid-configuration?client_id=hivexui-security-console
```

The selected ID must appear in `IAM_BROWSER_CLIENT_POLICIES` and exist as an active
public database client with the required permission ceiling and exact callback.
Browser metadata uses configured URLs, not forwarding headers, and includes no
credentials, cookies or redirects. Missing browser metadata configuration fails
closed. Discovery without `client_id` retains its existing native behavior.

The retained standalone Cindertrace console can optionally use this central flow.
Its public-client callback remains
`https://security.example.com/api/auth/hive/callback`. Configure only the selected
rehearsal copy when exercising it. The console uses these non-secret references:

```dotenv
CINDERTRACE_API_BROWSER_AUTH=true
CINDERTRACE_API_URL=https://security-api.example.com
DASHBOARD_PUBLIC_ORIGIN=https://security.example.com
HIVE_OAUTH_ISSUER=https://identity.example.com
HIVE_OAUTH_DISCOVERY_URL=https://identity.example.com/api/oathweave/oauth/.well-known/openid-configuration?client_id=hivexui-security-console
HIVE_OAUTH_CLIENT_ID=hivexui-security-console
HIVE_OAUTH_API_AUDIENCE=cindertrace
```

The API independently requires `CINDERTRACE_BROWSER_AUTH_ENABLED=true`, its
verified `OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL` and `OATHWEAVE_USERINFO_URL`, and
explicit `CINDERTRACE_OATHWEAVE_IDENTITIES_JSON` links to product-local accounts.
Keep session configuration protected; `HIVE_OAUTH_CLIENT_SECRET` must be absent for
this public PKCE client. See the selected Cindertrace revision's
[standalone console runbook](https://github.com/ChefTaco/cindertrace/blob/main/docs/OATHWEAVE_CONSOLE.md)
for its API-owned session, permission, revocation and verified backchannel contract.

This documents available integration and an isolated review procedure. It does
not assert that an existing production Cindertrace deployment was configured or
that its existing administrator authenticated. Production configuration, account
ownership and cutover retain their separate review and acceptance gates.

A cutover additionally requires a fresh host-bound backup, authenticated browser
and real agent/provider/memory workflow acceptance, all product parity gates,
reviewed links, a maintenance window, one active writer/dispatcher, compatible
rollback or rehearsed recovery, and reconciliation of subsequent writes. Preserve
legacy entrypoints until these requirements pass.
