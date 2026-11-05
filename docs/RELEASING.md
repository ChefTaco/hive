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
   lists the platforms each image must provide.
2. **Publish the suite images.** The Hive Registry and the ingress are built from this repository.
   Merge the release candidate to `main`, then run *Actions > Suite release > Run workflow* on
   `main` with the version and `dry_run` off. It builds and executes both architectures, then
   publishes `ghcr.io/cheftaco/hive-registry:X.Y.Z` and `ghcr.io/cheftaco/hive-ingress:X.Y.Z` with
   provenance, an SBOM and an attestation. An existing tag is never rebuilt.
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
6. **Commit and tag.** Commit the manifest, the signature and any documentation, and let CI pass
   on `main`. Then push the tag `vX.Y.Z`. The *Suite release* workflow checks the tagged tree again
   and checks the suite image digests against the published tags. Then it publishes the GitHub
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
