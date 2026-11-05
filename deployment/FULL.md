# Fresh full-profile bootstrap

A signed full release may add Magnus, Cindertrace, ChatterMost and the optional
Emberfold HTTP service to the eight core components. Magnus and Cindertrace each
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
contains the installation namespace and same-origin product paths only. Magnus's
existing console remains a separate product interface pending its later merge.
Set optional `bootstrap.magnusConsoleOrigin` to expose its HTTPS link in HiveXUI;
fresh setup does not invent a Magnus console URL or reuse its credentials.

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
