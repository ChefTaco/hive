# Existing product data rehearsals

Fresh fixtures prove application workflows. They do not prove recovery of an
existing installation. Rehearse each actual installation independently with its
own database, signing/encryption/session keys, deployment inventory and file data.
Never merge stores, identities or account IDs between installations. Existing chat
agent, role and test identities retain their original native accounts unless an
explicit reviewed issuer/subject link authorizes a particular association.

Use only the existing private deployment inventory and pinned transport. Confirm
the active installation manager, Compose project, image IDs, datastore major and
mounts before reading anything. Do not guess hosts or reuse unrelated credentials.
Keep evidence outside Git in an operator-owned mode-700 directory; snapshots,
source inspection, credentials, logs and manifests use mode 600. Do not print
runtime environment files or include private paths or IDs in public reports.

An online capture can stream PostgreSQL `pg_dump --format=custom --no-owner
--no-acl` from the existing datastore and read file/configuration archives from the
active installation without stopping it. Do not call a manager's backup command
when it stops services or writes source recovery state. Preserve all native
configuration, signing/session/credential secrets, TLS files, migration history,
audit data, attachments, archives and profiles. Where Redis owns authentication,
revocation or throttling state, export its keys and exact absolute expiry deadlines
with read-only operations; restore only into a separate owned clone, without
extending expiry. This export is confidential recovery material.

Hash every artifact. Record file manifests immediately before and after the
capture, plus a second read of configuration/keys, to detect changes. A PostgreSQL
dump gives a transactionally consistent database snapshot. Even when the file
manifests match, an online database/file export cannot prove a coordinated recovery
point under concurrent writes. A maintenance-window backup with one active
writer/dispatcher and a rehearsed reconciliation procedure remains a cutover gate.
Do not label an online export a clean-shutdown or activation-safe manager backup.

The reusable developer driver accepts an explicitly reviewed local capture bundle:

```bash
node scripts/suite/existing-products-roundtrip.mjs \
  --bundle /protected/source-capture --output /protected/new-rehearsal \
  --products cinder,chat \
  --cinder-image sha256:EXACT_LOCAL_CANDIDATE_ID \
  --chat-image sha256:EXACT_LOCAL_CANDIDATE_ID \
  --chat-migrator-image sha256:EXACT_LOCAL_CANDIDATE_ID
```

Replace each image placeholder with an already built local SHA-256 image ID.
Select one product to rehearse it alone. The driver never contacts source services;
it reads protected local snapshots and starts uniquely named disposable resources.
It rejects modified files, unprotected inputs, unpinned datastore images, root
application users, executable environment overrides, unsafe archives and duplicate
members before extraction. Review the capture bundle's provenance independently;
its checksums provide integrity, not publisher authentication.

The capture manifest, `capture-result.json`, has schema 1, `onlineSnapshot: true`,
`filesStable` observations and an `artifacts` object mapping each basename to its
SHA-256. Required names for each selected product are `<product>-database.dump`,
`<product>-state.tar.gz`, `<product>-configuration.tar.gz` and
`<product>-source-inspect.json`, with product `cinder` or `chat`. Cinder also
requires `cinder-tls-0.tar.gz`. Include hashes for any additional protected key,
Redis and configuration inventories. Source inspection is captured Docker inspect
JSON: Cinder maps `api`, `console` and `postgres`; Chat maps `containers.app` and
`containers.postgres` alongside its installation inventory. These files contain
infrastructure details and credentials and must remain private.

The driver restores into independent internal Docker networks without published
ports or source mounts. It preserves the source datastore major and explicit
unprivileged application UID. It applies only product-owned migrations to the
clone and invokes the owning current-migration verifier. It compares every
preexisting table's row count and canonical row digest, then compares all file
bytes. Application containers use read-only filesystems, dropped capabilities and
`HIVE_REHEARSAL=true`. Cinder collection, retention, writes, notifications and
response dispatch are disabled. Chat uses authenticated rehearsal with volatile
authentication state; captured sessions cannot authorize the clone. No dispatchers,
collectors, host agents or inference services are launched.

For Chat, preserved protected native administrator credentials and an existing
agent credential are tested only inside the clone. When login succeeds, the old
user ID must remain exact; an existing attachment is downloaded and checked when
available. Failed existing credentials remain a pending gate, never a reason to
reset a password or manufacture a session. The source API and its native clients
are untouched. Cinder's native audit verifier runs against restored data; an empty
audit or deletion-receipt chain must be reported as empty, not as proof of a
nonempty signed history. Existing response approvals and unknown operations stay
held; the driver never consumes an approval or dispatches an action.

Finally, readiness must pass, unauthenticated reads and mutations must fail, and
all durable database/file digests must remain unchanged after candidate startup
and read-only authentication checks. The driver removes only its own disposable
containers, networks and volumes and retains private evidence. Its proof covers
the actual captured data and physical platform used. It does not authorize
production cutover, validate missing user credentials, certify physical GPU
hardware or replace authenticated browser/agent acceptance against the selected
identity authority. External inference dependencies remain operator-owned and
are neither captured nor installed by Hive.
