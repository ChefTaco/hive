# Releasing the Hive suite

A suite release is a signed manifest that pins the exact images `hive.sh` installs. Suite versions
start at 2.0.0 and use tags `vX.Y.Z`. The legacy npm packages keep their own `v1.Y.Z` tags and
`.github/workflows/publish.yml`; a suite release publishes nothing to npm.

## What a release contains

| File | Meaning |
|---|---|
| `releases/X.Y.Z.inputs.json` | The product image tags and versions of this release, and the service owner |
| `releases/X.Y.Z.json` | The manifest: every component, network, datastore, storage format, initialization contract and catalog entry, images pinned by digest, and `controllerSHA256` |
| `releases/X.Y.Z.json.sig` | Detached Ed25519 signature of the manifest bytes |
| `trust/publisher.pub` | The publisher's public key |

The service contracts come from `scripts/suite/release-contracts.mjs` and the catalog from
`scripts/suite/suite-catalog.json`. The developer proofs build their manifests from the same code,
so a release ships the contracts they exercised. `controllerSHA256` is the digest of the controller
runtime files (`hive_runtime_files` in `scripts/suite/controller.sh`); `hive.sh` refuses the manifest
when run from any other controller source, so install from a checkout of the release tag.

## Steps

1. **Release the products.** Each product repository publishes its own multi-architecture image
   from its own version tag. Record the exact tags in `releases/X.Y.Z.inputs.json`. The input file
   lists the platforms each image must provide. Releases that adopt the patched datastore
   runtime set `"datastoreProfile": "runtime-2026-11"`. This selects the reviewed Redis,
   Qdrant and PostgreSQL tags in `release-contracts.mjs`; older inputs retain their
   historical pins. PostgreSQL receives a new storage format and the explicit offline
   collation migration, so adoption requires the normal backup and rehearsal workflow.
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
