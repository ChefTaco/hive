#!/usr/bin/env bash
# Builds a suite manifest from synthetic pinned digests, signs it with a throwaway key and
# runs the release checks over it, including the controller's own hive_manifest checks.
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
# Release builds require committed runtime bytes. Test the current source in a throwaway
# repository so contributors can run this gate before committing their runtime changes.
fixture=$temporary/source
mkdir -p "$fixture"
source "$root/scripts/suite/controller.sh"
while IFS= read -r file; do
  mkdir -p "$fixture/$(dirname -- "$file")"
  cp "$root/$file" "$fixture/$file"
done < <({ hive_runtime_files; printf '%s\n' scripts/release/build-suite-manifest.mjs scripts/release/check-suite-release.sh \
  scripts/suite/release-contracts.mjs scripts/suite/suite-catalog.mjs scripts/suite/suite-catalog.json examples/installation.json; })
git -C "$fixture" init -q
git -C "$fixture" add .
git -C "$fixture" -c user.name='Synthetic Test' -c user.email=test@example.com commit -qm 'Synthetic release fixture'
root=$fixture
digest() { printf 'sha256:%064d' "$1"; }
jq -n '{schema:1,version:"9.9.9",user:"1000:1000",products:({
  "hive-registry":"hive-registry","ingress":"hive-ingress","oathweave":"oathweave","emberpath":"emberpath","hivemem":"hivemem",
  "hiveskills":"hiveskills","hivexui":"hivexui","magnus":"magnus-server","magnus-gateway":"magnus-fleet-gateway","cindertrace":"cindertrace",
  "chattermost":"chattermost","chat-migrator":"chattermost-migrator","emberfold":"emberfold"}|with_entries(.value={image:("ghcr.io/example/"+.value+":1.0.0"),version:"1.0.0",platforms:["linux/amd64","linux/arm64"]}))}' > "$temporary/inputs.json"
jq --arg digest "$(digest 7)" '.products|map_values(.image|sub(":[0-9.]+$";"@"+$digest))' "$temporary/inputs.json" > "$temporary/pinned.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/release.json" >/dev/null
# The production builder must still refuse uncommitted controller changes.
printf '\n' >> "$root/hive.sh"
if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/dirty.json" >/dev/null 2>&1; then echo 'An uncommitted controller was pinned' >&2; exit 1; fi
git -C "$root" checkout -- hive.sh
jq -e '
  .version=="9.9.9" and (.controllerSHA256|test("^[a-f0-9]{64}$")) and
  (.profiles.core|index("hive-registry"))!=null and (.profiles.full|index("hive-registry"))!=null and
  (.profiles.full|index("magnus-gateway"))==null and .components["magnus-gateway"]!=null and
  .components.ardentstudio==null and
  (.profiles.full|length)==18 and (.profiles.core|length)==9 and
  .components.chattermost.initialization.image==("ghcr.io/example/chattermost-migrator@"+("sha256:"+("0"*63)+"7")) and
  .components["magnus-postgres"].version=="17.11" and .components["cindertrace-postgres"].version=="18.6" and
  .components["oathweave-redis"].version=="8.2.10" and .components["hivemem-qdrant"].version=="1.18.3" and
  all(.components[]; .catalog!=null and (.image|test("@sha256:[a-f0-9]{64}$")))
' "$temporary/release.json" >/dev/null || { echo 'Generated manifest misses a reviewed contract' >&2; exit 1; }
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" 2>/dev/null
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
export HIVE_RELEASE_MANIFEST="$temporary/release.json" HIVE_RELEASE_INPUTS="$temporary/inputs.json" HIVE_RELEASE_TRUST="$temporary/publisher.pub"
"$root/scripts/release/check-suite-release.sh" 9.9.9 >/dev/null
# A hand edit, a wrong key and a changed controller are all refused.
cp "$temporary/release.json" "$temporary/original.json"
jq '.components.emberpath.service.user="0:0"' "$temporary/original.json" > "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
if "$root/scripts/release/check-suite-release.sh" 9.9.9 >/dev/null 2>&1; then echo 'A hand-edited manifest passed' >&2; exit 1; fi
cp "$temporary/original.json" "$temporary/release.json"
openssl genpkey -algorithm ED25519 -out "$temporary/other.key" 2>/dev/null
openssl pkeyutl -sign -inkey "$temporary/other.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
if "$root/scripts/release/check-suite-release.sh" 9.9.9 >/dev/null 2>&1; then echo 'A foreign signature passed' >&2; exit 1; fi
jq '.controllerSHA256=("0"*64)' "$temporary/original.json" > "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
if "$root/scripts/release/check-suite-release.sh" 9.9.9 >/dev/null 2>&1; then echo 'A different controller digest passed' >&2; exit 1; fi
# The Magnus agent package is pinned when the inputs name it, and only as Magnus's own version.
integrity="sha512-$(printf 'A%.0s' {1..86})=="
jq --arg integrity "$integrity" '.magnusAgent={name:"@hivemagnus/magnus-agent",version:"1.0.0",integrity:$integrity}' "$temporary/inputs.json" > "$temporary/agent-inputs.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/agent-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/agent.json" >/dev/null
jq -e --arg integrity "$integrity" '.components.magnus.agentPackage=={name:"@hivemagnus/magnus-agent",version:"1.0.0",integrity:$integrity}' "$temporary/agent.json" >/dev/null || { echo 'The agent package was not pinned' >&2; exit 1; }
for change in '.magnusAgent.version="1.0.1"' '.magnusAgent.name="magnus-agent"' '.magnusAgent.integrity="sha1-abc"' '.magnusAgent.extra=true'; do
  jq "$change" "$temporary/agent-inputs.json" > "$temporary/bad-inputs.json"
  if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/bad-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo "An invalid agent pin passed: $change" >&2; exit 1; fi
done
# Ardent Project Studio is offered when the inputs name its image, and no profile selects it.
jq '.products.ardentstudio={image:"ghcr.io/example/ardent-studio:0.1.0",version:"0.1.0",platforms:["linux/amd64","linux/arm64"]}' "$temporary/inputs.json" > "$temporary/studio-inputs.json"
jq --arg digest "$(digest 7)" '.ardentstudio=("ghcr.io/example/ardent-studio@"+$digest)' "$temporary/pinned.json" > "$temporary/studio-pinned.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/studio-inputs.json" --pinned "$temporary/studio-pinned.json" --output "$temporary/studio.json" >/dev/null
jq -e '
  .components.ardentstudio as $studio |
  $studio.kind=="application" and $studio.storageFormat=="ardentstudio-v1" and $studio.version=="0.1.0" and
  $studio.image==("ghcr.io/example/ardent-studio@sha256:"+("0"*63)+"7") and $studio.service.user=="1000:1000" and
  $studio.service.healthcheck.test==["CMD","node","/app/healthcheck.mjs"] and ($studio|has("requiresLocal")|not) and
  $studio.catalog.consoleSection=="studio" and $studio.catalog.connection.consolePath=="/studio" and
  $studio.catalog.connection.browserPrefix=="/api/ardentstudio" and $studio.catalog.dependencies==["magnus","oathweave","hivemem"] and
  all(.profiles[]; index("ardentstudio")==null) and (.profiles.full|length)==18
' "$temporary/studio.json" >/dev/null || { echo 'The Ardent Project Studio contract is not the reviewed one' >&2; exit 1; }
diff <(jq 'del(.components.ardentstudio)' "$temporary/studio.json") <(jq . "$temporary/original.json") >/dev/null || { echo 'Offering Ardent Project Studio changed another component' >&2; exit 1; }
jq '.products["unreviewed-product"]=.products.ardentstudio' "$temporary/studio-inputs.json" > "$temporary/bad-inputs.json"
jq '.["unreviewed-product"]=.ardentstudio' "$temporary/studio-pinned.json" > "$temporary/bad-pinned.json"
if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/bad-inputs.json" --pinned "$temporary/bad-pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'An unknown product image passed' >&2; exit 1; fi
echo 'build-suite-manifest: ok'
