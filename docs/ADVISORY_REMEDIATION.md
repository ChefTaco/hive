# Runtime advisory remediation

The Hive 2.4.2 image review recorded 27 unique HIGH/CRITICAL advisory identifiers
without fixes in their installed Debian suites. These are OS packages, not npm
findings. An `npm audit --omit=dev` recheck of the nine affected application
repositories reported zero vulnerabilities. Replacing JavaScript libraries does
not remove vulnerable OS code.

## Runtime replacements

Use a minimal glibc runtime with patched, inventoried distribution packages for
Node services. `deployment/runtime/node.Dockerfile` pins the Wolfi base by digest
and Node 24.22.2 by package revision. It supplies OpenSSL 3 compatibility libraries
for native addons and the GNU `flock` command used for single-writer protection.
It retains package metadata. Production products copy only their built artifacts
and install their specific runtime tools; compilers and npm remain in build stages.

Wolfi uses glibc, so this change preserves the native-module ABI family. Alpine's
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

## PostgreSQL needs a separate migration proof

Do not point an existing PostgreSQL data directory at an untested replacement OS.
Changing glibc or ICU can change collation behavior even when the PostgreSQL major
and binary are unchanged. XML, LDAP, OpenSSL, locale and extension dependencies
also need their real compatible library interfaces, not just similarly named
packages. The initial replacement prototype is deliberately excluded from
`deployment/images.json` until this proof passes.

The acceptable paths are either a compatible, maintained PostgreSQL runtime with
explicit collation reconciliation before admission, or a staged logical migration
to a supported major. A major upgrade must export roles and databases, restore into
new storage, reindex and check constraints, preserve ownership and credentials,
verify application records and post-upgrade writes, and keep the original storage
for rollback. The installer must orchestrate that path; an operator should not
need manual SQL or a hidden volume replacement. Never refresh collation version
metadata without rebuilding affected indexes first. Do not downgrade PostgreSQL
to obtain a cleaner scanner result.

## Advisory disposition by dependency family

| Family | Advisory identifiers | Remediation |
|---|---|---|
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
