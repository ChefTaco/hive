#!/usr/bin/env bash
# Verifies a signed suite release offline, the way an installer will see it:
#   - the detached signature verifies against trust/publisher.pub
#   - releases/VERSION.json is exactly the reviewed contracts with its pinned digests,
#     and pins the controller in this checkout (scripts/release/build-suite-manifest.mjs --check)
#   - the controller's own hive_manifest checks accept it for core and full installations
#     (hive.sh plan, which never contacts a host)
# Usage: scripts/release/check-suite-release.sh VERSION [--registry]
#   --registry also checks that every pinned image digest resolves in its registry.
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
version=${1:?usage: check-suite-release.sh VERSION [--registry]}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'An exact X.Y.Z version is required' >&2; exit 1; }
# Tests may point at a temporary release with HIVE_RELEASE_MANIFEST, HIVE_RELEASE_INPUTS and HIVE_RELEASE_TRUST.
manifest=${HIVE_RELEASE_MANIFEST:-$root/releases/$version.json} trust=${HIVE_RELEASE_TRUST:-$root/trust/publisher.pub}
signature="$manifest.sig" inputs=${HIVE_RELEASE_INPUTS:-$root/releases/$version.inputs.json}
for file in "$manifest" "$signature" "$trust"; do [[ -f "$file" ]] || { echo "Missing $file" >&2; exit 1; }; done
openssl pkeyutl -verify -pubin -inkey "$trust" -rawin -in "$manifest" -sigfile "$signature" >/dev/null || { echo 'Signature verification failed' >&2; exit 1; }
echo "signature: verified with $(basename -- "$trust")"
node "$root/scripts/release/build-suite-manifest.mjs" --version "$version" --check --inputs "$inputs" --output "$manifest"

temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
for profile in core full; do
  jq --arg version "$version" --arg profile "$profile" --slurpfile release "$manifest" '
    .release=$version | .profile=$profile |
    .components=(($release[0].profiles[$profile]) as $names | $names | map(. as $name | {key:$name, value:({host:"control"} +
      (if $release[0].components[$name].kind=="static-ui" then {}
       elif $release[0].components[$name].kind=="datastore" then {configDirectory:("/opt/hive/config/"+$name)}
       else {envFile:("/opt/hive/config/"+$name+".env"),configDirectory:("/opt/hive/config/"+$name)} end))}) | from_entries)
  ' "$root/examples/installation.json" > "$temporary/$profile.json"
  "$root/hive.sh" plan --config "$temporary/$profile.json" --release "$version" --manifest "$manifest" --signature "$signature" --trust-key "$trust" --non-interactive > "$temporary/$profile.plan"
  jq -e --arg version "$version" '.release==$version and (.planDigest|test("^[a-f0-9]{64}$"))' "$temporary/$profile.plan" >/dev/null
  echo "hive_manifest: $profile profile accepted ($(jq '.components|length' "$temporary/$profile.plan") components)"
done

if [[ "${2:-}" == --registry ]]; then
  node "$root/scripts/release/build-suite-manifest.mjs" --version "$version" --check --resolve-tags --inputs "$inputs" --output "$manifest"
  buildx=(docker buildx); docker buildx version >/dev/null 2>&1 || buildx=("${DOCKER_BUILDX:-/usr/libexec/docker/cli-plugins/docker-buildx}")
  while IFS= read -r image; do
    "${buildx[@]}" imagetools inspect "$image" --format '{{json .Manifest.Digest}}' >/dev/null || { echo "Not resolvable: $image" >&2; exit 1; }
    echo "registry: $image"
  done < <(jq -r '[.components[]|.image,(.initialization.image // empty)]|unique[]' "$manifest")
fi
echo "Release $version: all checks passed"
