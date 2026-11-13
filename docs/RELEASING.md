# Releasing the Hive suite

A suite release is a signed manifest that pins the exact images `hive.sh` installs. Suite versions
start at 2.0.0 and use tags `vX.Y.Z`. The `v1.Y.Z` tags belong to the retired npm 1.x line; a
suite release publishes nothing to npm.

## What a release contains

| File | Meaning |
|---|---|
| `releases/X.Y.Z.inputs.json` | The product image tags and versions of this release, and the service owner |
| `releases/X.Y.Z.json` | The manifest: every component, network, datastore, storage format, initialization contract and catalog entry, images pinned by digest, and `controllerSHA256` |
| `releases/X.Y.Z.json.sig` | Detached Ed25519 signature of the manifest bytes |
| `trust/publisher.pub` | The publisher's public key |

The service contracts come from `scripts/suite/release-contracts.mjs` and the catalog from
`scripts/suite/suite-catalog.json`. A catalog entry's `capabilities` name the first product version
that serves each one (`since`); a manifest carries a capability only for a component pinned at that
version or newer, so set `since` when the product release that serves it is published. Suite 3.5.0 is the first release to
carry one (`events.v1` from Magnus 2.8.0, Cindertrace 0.5.0, HiveSkills 1.6.0 and Embermend 0.2.0).
In the same way, `hive_audit_collection_releases` in `scripts/suite/audit-collection.sh` names the
first version of Cindertrace, HiveMem, HiveSkills, Ardent Project Studio and Embermend that collects
or serves the suite audit export; `null` configures nothing for that product. Set each one in the
release that first pins it. That file is a controller runtime file, so this changes the controller
digest. The developer proofs build their manifests from the same code,
so a release ships the contracts they exercised. `controllerSHA256` is the digest of the controller
runtime files (`hive_runtime_files` in `scripts/suite/controller.sh`); `hive.sh` refuses the manifest
when run from any other controller source, so install from a checkout of the release tag.
For the same reason `build-suite-manifest.mjs --version X.Y.Z --check` reproduces an older
release's bytes only from the controller source of that release's tag.

## Steps

1. **Release the products.** Each product repository publishes its own multi-architecture image
   from its own version tag. Record the exact tags in `releases/X.Y.Z.inputs.json`. The input file
   lists the platforms each image must provide. Releases that adopt the patched datastore
   runtime set `"datastoreProfile": "runtime-2026-11-pg1712"`. This selects the reviewed Redis,
   Qdrant and PostgreSQL tags in `release-contracts.mjs`; older inputs retain their
   historical pins. PostgreSQL receives a new storage format and the explicit offline
   collation migration, so adoption requires the normal backup and rehearsal workflow.
   `DATASTORE_PROFILE_LAST_RELEASE` names the last suite release that may select each superseded
   profile; a later release that names one is refused, so a new datastore profile is adopted by the
   next release.
   A product version that changes its own data format needs an entry in `PRODUCT_FORMATS` in
   `scripts/suite/release-contracts.mjs` before its first suite release. The builder then
   declares the storage transition and the product's `migrate` command for every release
   pinning that version or newer, so the upgrade requires `--allow-migrations` and the
   controller rehearses and runs the migration. Emberpath 2.2.0 and HiveSkills 1.5.0 are the
   first such versions.
   A product with a signed `initialization` (Magnus, Cindertrace, Embermend) needs no entry for a
   new database migration: the upgrade runs its exact verifier on the restored copy and, when
   that finds the migration pending, requires `--allow-migrations` and runs the product's
   `migrate` command. Embermend 0.3.0 in suite 3.6.0 is the first such migration.
   Optional products (`OPTIONAL_PRODUCTS` in `scripts/suite/release-contracts.mjs`) are offered
   only when the inputs name their image and no profile selects them. Ardent Project Studio is
   one: after its first image is published, add
   `"ardentstudio": {"image": "ghcr.io/cheftaco/ardent-studio:X.Y.Z", "version": "X.Y.Z", ...}`,
   with a Magnus that links service identities and an Oathweave with browser-issued machine
   clients.
2. **Publish the suite images.** The Hive Registry, the ingress and the hardened datastores are built
   from this repository; `deployment/images.json` gives each one's version and base.
   Merge the release candidate to `main`, then run *Actions > Suite release > Run workflow* on
   `main` with `image` set to `all` (or one `NAME:VERSION`) and `dry_run` off. It builds and executes
   both architectures on matching native runners, reuses the validated build caches, then publishes each image with provenance, an SBOM and an attestation. An
   existing tag is never rebuilt: a changed image takes a new version in `deployment/images.json`.
   The registry and ingress tags named in the inputs file, and the datastore digests in
   `scripts/suite/release-contracts.mjs`, must match what was published.
3. **Build the manifest.** With every controller runtime change committed:

   ```bash
   node scripts/release/build-suite-manifest.mjs --version X.Y.Z
   ```

   It resolves every tag to its index digest, checks the platforms and writes `releases/X.Y.Z.json`.
   Images that are not public yet need `docker login ghcr.io` first.
4. **Sign it** offline, on the machine that holds the publisher key:

   ```bash
   openssl pkeyutl -sign -inkey PUBLISHER_KEY -rawin -in releases/X.Y.Z.json -out releases/X.Y.Z.json.sig
   ```

5. **Check it** exactly as an installer will:

   ```bash
   scripts/release/check-suite-release.sh X.Y.Z --registry
   ```

   This verifies the signature, rebuilds the manifest from its pinned digests and compares the bytes,
   runs `hive.sh plan` (the controller's own `hive_manifest` checks) for the core and full
   profiles, and with `--registry` resolves every pinned digest.
   Then run the image gate, `HIVE_IMAGE_SECURITY_MODE=all scripts/release/scan-suite-images.sh releases/X.Y.Z.json`. It requires
   that no pinned image, on either architecture, has a CRITICAL or HIGH finding, including
   unfixed findings, when `HIVE_IMAGE_SECURITY_MODE=all` is set. New tagged releases enforce
   this full policy automatically. Exceptions go in `deployment/trivy/IMAGE.trivyignore.yaml`, one advisory per entry
   with its justification. Keep the unfiltered reports and document every accepted scoped exception.
6. **Commit and tag.** Commit the manifest, the signature and any documentation, and let CI pass
   on `main`. Then push the tag `vX.Y.Z`. The *Suite release* workflow checks the tagged tree again
   and checks every pinned digest against the published tag named in the inputs file. Then it publishes the GitHub
   release with the manifest, the signature and the publisher key attached.
7. **Make new packages public.** A first push to GitHub Container Registry creates a private
   package. Set every new package to public before announcing the release.

## The publisher key

The key is an Ed25519 key in PEM form, created with `openssl genpkey -algorithm ED25519`. Its public
half is `openssl pkey -in KEY -pubout`. The private key never enters a repository, a CI secret or a
release; signing happens offline and CI only verifies. Each release's notes give the key's
fingerprint, the SHA-256 of the DER public key:

```bash
openssl pkey -pubin -in trust/publisher.pub -outform DER | sha256sum
```

A rotated key is published as a new `trust/publisher.pub` in a new release. Older manifests remain
verifiable with the key in their own tag.

## First Embermend datastore registration recovery

Suite 3.2.0 can initialize a newly selected Embermend PostgreSQL store before
recording its storage format. Later configuration changes correctly refuse that
unversioned data. Suite 3.2.2 explicitly selects
`storageRecovery: "embermend-postgres-runtime2-unversioned"` in its signed inputs.
The ordinary backed-up, rehearsed upgrade with `--allow-migrations` verifies the
existing PostgreSQL 18 major, exact runtime collation receipt and offline data
checksums before recording its format. It never creates a database, changes
credentials or marks arbitrary existing data as new. Failed verifiers retain the
held upgrade for reviewed recovery. Existing correctly registered stores need no
storage transition. New additions record their proven format before initialization.
Historical signed release bytes remain unchanged.

Suite 3.2.1 remains a retained failed release tag: a fresh security scan rejected
its PostgreSQL libxslt dependency before publication. Suite 3.2.2 selects the new
`runtime-2026-11-xslt` image profile. The earlier profile and signed manifests keep
their original pins. This library patch preserves the major, collation identity and
storage format; the explicit unversioned-store recovery remains separately verified.

Suite 3.7.0 and later select `runtime-2026-11-pg1712`: the PostgreSQL 17.12 and 18.7 security
releases as `hive-postgres` 17.12-1 and 18.7-1. A minor release keeps the major, the hardened
runtime and its collation receipt, so the storage format, readable formats and reconciliation
command are identical to `runtime-2026-11-xslt` and an upgrade between them has no storage
transition. Only the image and its recorded version change. The image workflow checks this by
starting data written by the previous image (`upgradeFrom` in `deployment/images.json`) directly on
the candidate. `runtime-2026-11-xslt` remains selectable up to suite 3.6.1, and its signed
manifests keep their pins.
