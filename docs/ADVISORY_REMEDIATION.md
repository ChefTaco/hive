# Runtime advisory remediation

The Hive 2.4.2 image review recorded 27 unique HIGH/CRITICAL advisory identifiers
without fixes in their installed Debian suites. The original scanner findings are OS packages. At that review, an `npm audit --omit=dev`
recheck of the nine affected application repositories reported zero vulnerabilities.
Independent checks additionally found affected SQLite embedded inside Node 24
and the latest better-sqlite3 package. Neither npm audit nor the image scanner
reported those bundled copies. A clean scan alone is insufficient acceptance.

## Hive 3.0.3 disposition

The [signed release manifest](../releases/3.0.3.json) pins 18 distinct images.
All were checked on linux/amd64 and linux/arm64 with the full HIGH/CRITICAL policy,
including findings without a published fix. None of the original 27 advisory
identifiers, nor either newly reported libxslt identifier below, remains in the unfiltered reports. The gated reports contain zero
HIGH/CRITICAL findings; the two existing Qdrant workspace-SBOM exceptions below
remain scoped and were not expanded. Application SQLite was executed separately
because image and npm scanners did not identify the affected embedded copies.

The 3.0.1 controller corrects multi-store migration enumeration, large SSH program
transport and guarded retry after an unchanged failed isolated rehearsal. Its tag
did not publish a release: the final scan identified CVE-2026-9947 and
CVE-2026-87636 in the unchanged HiveXUI 0.2.5 image's libxslt 1.1.43-r3.
Alpine's [security database](https://secdb.alpinelinux.org/v3.24/main.json) and
[package source](https://gitlab.alpinelinux.org/alpine/aports/-/raw/3.24-stable/main/libxslt/APKBUILD)
record the backports in 1.1.43-r4. Hive 3.0.2 retains the corrected controller and
other reviewed product pins and selects HiveXUI 0.2.6 with that minimum revision.
Existing full installations should use 3.0.2 or later; see
[upgrade and recovery guidance](../UPGRADING.md).

Hive 3.0.3 retains the patched datastore runtime and migration controller. It
updates Magnus to 2.3.7 so managed Ardent can apply the patched whole package
while preserving an earlier verified package checkpoint. No additional
storage format or dependency exception is introduced.

## Runtime replacements

Use a minimal glibc runtime with patched, inventoried distribution packages for
Node services. `deployment/runtime/node.Dockerfile` pins the Wolfi base by digest
and the official Node 26.13.1 image by digest. The patched Node binary is copied
from that image because the distribution package can lag upstream security fixes;
no Debian userspace or build tooling is copied. The runtime explicitly installs
`libatomic`, which the upstream binary requires. It supplies OpenSSL 3 compatibility libraries
for native addons and the GNU `flock` command used for single-writer protection.
It retains package metadata. Production products copy only their built artifacts
and install their specific runtime tools; compilers and npm remain in build stages.

Wolfi uses glibc, preserving the C library family. Node 26 changes the Node
module ABI; addons must be rebuilt for that major or use stable Node-API prebuilts.
The base build and runtime acceptance check execute Node's embedded SQLite and
refuse versions older than 3.54.0, independently of scanner coverage. Alpine's
musl Node builds require different native artifacts and have weaker upstream Node
architecture support. They are not interchangeable with existing glibc builds.
Native addons still require execution tests on amd64 and arm64; a version command
or vulnerability scan is not sufficient compatibility proof.

Qdrant keeps the exact upstream binary, configuration, recovery entrypoint and
unmodified SBOM while replacing its Debian userspace with patched glibc libraries.
The unused dashboard stays absent. The two existing pyo3/quinn-proto exceptions
remain narrowly scoped to the upstream workspace SBOM; they do not waive linked
vulnerable crates. Redis uses the same upstream Redis version on official Alpine,
with the unused root-only gosu helper removed. Preserve non-root ownership and
prove old-image data can be opened by the candidate before rollout.

## Embedded SQLite: replace the npm driver

Updating better-sqlite3 to its latest reviewed release, 13.0.3, still carried
SQLite 3.53.4. The application packages instead pin
[`@photostructure/sqlite` 3.3.1](https://github.com/photostructure/node-sqlite),
which embeds SQLite 3.54.1 and supplies Node-API binaries. Its amalgamation source
hash was compared with the [upstream SQLite release](https://www.sqlite.org/changes.html),
and registry signatures and available publisher attestations were verified.
Startup checks the actual embedded version rather than trusting package metadata.

Ardent 3.0 and Studio 0.2 expose a new low-level database boundary; integrations
using driver-specific methods must update. Their HTTP/CLI contracts and database
schemas remain compatible. Emberpath and Oathweave use an attributed Apache-2.0
Prisma adapter for the replacement driver, preserving query conversion, constraint
errors and transaction ownership. Active application and recovery connections use
the same SQLite engine within a process. HiveSkills retains released migration
bytes and adapts only the connection boundary; HiveMem's packaged recovery engine
also uses the patched driver.

Acceptance executes native FTS5, failed transaction admission, rollback, prior-file
retention, read-only and required-existing-file refusal, committed WAL backup,
integrity checks, owner-only backup modes and overwrite refusal. Supported Linux
x64/arm64 installations work with dependency scripts disabled and need no database
compiler or binary download. Magnus's context bundle includes both native binaries
inside the protected candidate tree, within existing payload limits; its real
old-runtime adoption and rollback checks remain offline.

The shared Node 26 image separately requires embedded SQLite 3.54.0 or newer and
ships only the supported 64-bit amd64/arm64 platforms. Application driver guards
require 3.54.1 regardless of the supported host Node version.

ChatterMost 0.4.4 and Magnus 2.3.6 adapt local HTTPS/WebSocket and terminal gateway
readiness probes to Node 26: IP certificate identities are verified without sending an IP address as
TLS SNI. Trusted CA and wrong-name refusal tests cover both transports.

## PostgreSQL needs a separate migration proof

Do not point an existing PostgreSQL data directory at an untested replacement OS.
Changing glibc or ICU can change collation behavior even when the PostgreSQL major
and binary are unchanged. XML, LDAP, OpenSSL, locale and extension dependencies
also need their real compatible library interfaces, not just similarly named
packages. The first compatibility prototype used libxml2 2.13.9 without current backports,
despite a clean scan. It was rejected. The replacement builds PostgreSQL 17.11
and 18.6 from checksum-verified upstream source against libxml2 2.15.4 and ICU
79.1. It preserves XML, XSLT, LDAP, GSSAPI, PAM, TLS and bundled core extensions.
LLVM JIT is omitted from these images; ordinary SQL and core extensions remain available.
Workloads depending on JIT acceleration require separate performance validation.
Compilers, headers and Perl stay in the build stage. Existing legacy procedural
language extensions require a separately reviewed migration and are refused.

`hive-pg-reconcile` runs offline through a private Unix socket, with the original
HBA and credentials. It rebuilds indexes before refreshing collation metadata,
checks every connectable database and then writes a durable runtime receipt.
Ordinary startup refuses existing data without the matching receipt. Failure
leaves no receipt, does not weaken authentication and stops the temporary server.

Hive 3.0.0 selects these pinned datastores through the reviewed `runtime-2026-11`
profile. Each affected component declares its new storage format and explicit
migration from the prior format. Existing stores require `--allow-migrations`;
the installer rehearses on a copy and takes its verified pre-change backup.
Code-only rollback to the old collation runtime is refused; recovery uses the
rehearsed original-state restore. Individual product selections remain supported.

The acceptable paths are either a compatible, maintained PostgreSQL runtime with
explicit collation reconciliation before admission, or a staged logical migration
to a supported major. A major upgrade must export roles and databases, restore into
new storage, reindex and check constraints, preserve ownership and credentials,
verify application records and post-upgrade writes, and keep the original storage
for rollback. The installer must orchestrate that path; an operator should not
need manual SQL or a hidden volume replacement. Never refresh collation version
metadata without rebuilding affected indexes first. Do not downgrade PostgreSQL
to obtain a cleaner scanner result.

The distribution's zlib version sorts below 1.4, so a numeric floor alone would
incorrectly reject it. Its pinned source commit
`767c4c947852e143f582c85f14cf573411df1b35` descends from the upstream fix
`df84af25dc1942490e1d1c899a07619152a46148` for CVE-2026-76844 and
CVE-2026-85091. Preserve source provenance when accepting such backports;
package names and scanner silence are insufficient.

## Advisory disposition by dependency family

| Family | Advisory identifiers | Remediation |
|---|---|---|
| libxslt | CVE-2026-9947, CVE-2026-87636 | Require Alpine 1.1.43-r4 or newer in HiveXUI 0.2.6; verify vendor backports and execute/scan both native images before publication. |
| OpenLDAP | CVE-2023-2953 | Replace old client libraries with maintained compatible libraries; execute database backup clients. |
| zlib | CVE-2023-45853, CVE-2026-76844, CVE-2026-85091 | Use patched runtime libraries. Debian notes the first finding concerns MiniZip code absent from older zlib binary packages; retain that distinction in evidence. |
| ncurses | CVE-2025-69720 | Remove unused terminal utilities; use patched libraries for tools that need them. |
| SQLite | CVE-2026-119373, CVE-2026-119374, CVE-2026-119379 | Remove unused system SQLite or use a patched package; separately execute bundled native application SQLite. |
| systemd | CVE-2026-16742 | Remove unused systemd userspace; retain only required maintained libraries. |
| GnuPG | CVE-2026-24882 | Remove build/key-import utilities from runtime. |
| gzip | CVE-2026-41992 | Use patched gzip when runtime/recovery tooling needs it. |
| util-linux | CVE-2026-53613, CVE-2026-53615, CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 | Install patched flock alone when sufficient; do not retain mount/login tooling by default. |
| ACL | CVE-2026-54369 | Remove unused ACL tools/libraries or use patched packages; test ownership and recovery behavior. |
| libxml2 | CVE-2026-6653, CVE-2026-74860, CVE-2026-86138, CVE-2026-86139, CVE-2026-86140, CVE-2026-86142, CVE-2026-86143, CVE-2026-86144 | Use compatible patched libraries or a tested PostgreSQL migration; preserve XML behavior. |
| Perl Archive::Tar | CVE-2026-9538 | Remove unused Perl runtime; preserve explicitly supported PostgreSQL extensions or migrate them deliberately. |

## Gates and rollout

`scan-suite-images.sh` retains the full unfiltered report under `raw/`, including
unfixed findings and scoped exceptions. `HIVE_IMAGE_SECURITY_MODE=all` rejects
HIGH/CRITICAL findings regardless of fix availability; `fixable` preserves the
historical release policy. Unknown policy names and scanner failures fail closed.
New suite image publication uses the stricter policy on both architectures.
Never delete package inventory or extend ignore files to make a candidate pass.

Run `scripts/release/check-runtime-images.mjs --node IMAGE --redis IMAGE --qdrant IMAGE`
for non-root read-only runtime, actual writer-lock exclusion/release, graceful
shutdown and persisted datastore restart. Supply `--redis-from OLD_IMAGE` and
`--qdrant-from OLD_IMAGE` to exercise existing-format data across the image change.
These checks supplement full suite ownership, backup, failure-recovery, restore,
product initialization and browser tests; they do not replace them.

The PostgreSQL image publication workflow also runs
`scripts/release/check-postgres-runtime.py` for each major on both architectures.
It exercises fresh non-root initialization, admission refusal before migration,
authentication failure, repeated reconciliation, quoted database names, retained
and new records, XML/pg_trgm queries, logical backup and physical restore.

Publish new immutable runtime and product images only after their owning checks
pass. Build a new signed installer manifest; never rewrite 2.4.2 or its pinned
images. Rehearse recovery before activation and verify original data, credentials,
node commands, schedules, terminal cleanup and each product's key browser flow.
Independent product installation paths receive the same hardened runtime changes.

Sources: [Debian zlib tracking](https://security-tracker.debian.org/tracker/source-package/zlib),
[Debian ACL tracking](https://security-tracker.debian.org/tracker/CVE-2026-54369),
[Debian Perl tracking](https://security-tracker.debian.org/tracker/CVE-2026-9538),
[Wolfi architecture](https://www.chainguard.dev/supply-chain-security-101/wolfi-overview),
[Node image architecture support](https://github.com/nodejs/docker-node#musl-builds-for-alpine).

## November Node and Hono security updates

Node 26.13.1 fixes upstream TLS and HTTP/2 advisories; supported Node 24
installations require 24.22.3. These are runtime minimums, including native agent
enrollment, build tools and recovery helpers. Preserve historical signed releases;
a new suite release must pin rebuilt dependent images before deployment.
Individual CVE reachability still depends on TLS termination, HTTP/2 use, mTLS,
SNI and deployment configuration; these compatibility checks do not establish
that every upstream exploit path is exposed by every product.

Hono 4.13.18 addresses GHSA-39q9-qp46-w8xg by coalescing tiny transfer chunks
into a bounded buffer. A payload-byte limit alone did not prevent the previous
per-chunk memory amplification. Regression checks exercise the installed Hono
copies with one-byte chunks, exact-limit and over-limit bodies.

Sources: [Node security release](https://github.com/nodejs/node/releases/tag/v26.13.1),
[Hono advisory](https://github.com/honojs/hono/security/advisories/GHSA-39q9-qp46-w8xg).
