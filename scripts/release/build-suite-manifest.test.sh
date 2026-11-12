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
# Explicit hardened datastore selection preserves historical defaults and declares each
# collation transition. Test input failures before any network or host mutation.
jq '.datastoreProfile="runtime-2026-11"' "$temporary/inputs.json" > "$temporary/runtime-inputs.json"
jq --arg redis "ghcr.io/cheftaco/hive-redis@$(digest 8)" --arg qdrant "ghcr.io/cheftaco/hive-qdrant@$(digest 9)" \
  --arg pg17 "ghcr.io/cheftaco/hive-postgres@$(digest 10)" --arg pg18 "ghcr.io/cheftaco/hive-postgres@$(digest 11)" \
  '.+{"datastore:redis":$redis,"datastore:qdrant":$qdrant,"datastore:postgres17":$pg17,"datastore:postgres18":$pg18}' \
  "$temporary/pinned.json" > "$temporary/runtime-pinned.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/runtime-inputs.json" --pinned "$temporary/runtime-pinned.json" --output "$temporary/runtime.json" >/dev/null
jq -e --slurpfile old "$temporary/original.json" --slurpfile pinned "$temporary/runtime-pinned.json" '
  (.components as $components | all(["magnus-postgres","chattermost-postgres","cindertrace-postgres"][]; . as $name |
    $components[$name].storageFormat==($old[0].components[$name].storageFormat+"-runtime2") and
    $components[$name].readableFormats==[$components[$name].storageFormat] and
    $components[$name].migration=={from:$old[0].components[$name].storageFormat,command:["hive-pg-reconcile"]} and
    (($old[0].components[$name].readableFormats // [])|index($components[$name].storageFormat))==null)) and
  .components["magnus-postgres"].image==$pinned[0]["datastore:postgres17"] and
  .components["chattermost-postgres"].image==$pinned[0]["datastore:postgres17"] and
  .components["cindertrace-postgres"].image==$pinned[0]["datastore:postgres18"] and
  all(.components|to_entries[]|select(.key|endswith("-redis")); .value.image==$pinned[0]["datastore:redis"] and .value.storageFormat=="redis-aof-v1") and
  .components["hivemem-qdrant"].image==$pinned[0]["datastore:qdrant"] and
  .components["hivemem-qdrant"].storageFormat=="qdrant-v1.18.1" and
  .components["magnus-postgres"].version=="17.11" and .components["cindertrace-postgres"].version=="18.6"
' "$temporary/runtime.json" >/dev/null || { echo 'The hardened datastore migration contract is incomplete' >&2; exit 1; }
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --check --inputs "$temporary/runtime-inputs.json" --output "$temporary/runtime.json" >/dev/null
# A patched library selects new immutable images without rewriting historical tags or
# changing the already reviewed collation/storage transition.
node --input-type=module - "$root/scripts/suite/release-contracts.mjs" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { datastoreProfileReferences: references } = await import(pathToFileURL(process.argv[2]));
const old = references('runtime-2026-11'), patched = references('runtime-2026-11-xslt');
assert.equal(old['datastore:postgres17'].image, 'ghcr.io/cheftaco/hive-postgres:17.11-3');
assert.equal(old['datastore:postgres18'].image, 'ghcr.io/cheftaco/hive-postgres:18.6-3');
assert.equal(patched['datastore:postgres17'].image, 'ghcr.io/cheftaco/hive-postgres:17.11-4');
assert.equal(patched['datastore:postgres18'].image, 'ghcr.io/cheftaco/hive-postgres:18.6-4');
assert.deepEqual(patched['datastore:redis'], old['datastore:redis']);
assert.deepEqual(patched['datastore:qdrant'], old['datastore:qdrant']);
NODE
jq '.datastoreProfile="runtime-2026-11-xslt"' "$temporary/runtime-inputs.json" > "$temporary/patched-inputs.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/patched-inputs.json" --pinned "$temporary/runtime-pinned.json" --output "$temporary/patched.json" >/dev/null
cmp "$temporary/runtime.json" "$temporary/patched.json" || { echo 'The library patch changed the storage or product contract' >&2; exit 1; }
for profile in unknown legacy null; do
  jq --arg profile "$profile" '.datastoreProfile=(if $profile=="null" then null else $profile end)' "$temporary/runtime-inputs.json" > "$temporary/bad-inputs.json"
  if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/bad-inputs.json" --pinned "$temporary/runtime-pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'An unknown datastore profile passed' >&2; exit 1; fi
done
for mutation in 'del(.["datastore:postgres17"])' '.["datastore:redis"]="ghcr.io/example/other@sha256:"+("a"*64)'; do
  jq "$mutation" "$temporary/runtime-pinned.json" > "$temporary/bad-pinned.json"
  if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/runtime-inputs.json" --pinned "$temporary/bad-pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'An incomplete or foreign datastore pin passed' >&2; exit 1; fi
done
# Emberpath 2.2.0 and HiveSkills 1.5.0 change their product data formats. Their upgrade is an
# explicit storage transition running each product's own migrate; older pins stay unchanged.
jq -e '.components.emberpath.storageFormat=="emberpath-v1" and .components.hiveskills.storageFormat=="hiveskills-v1" and
  (.components.emberpath|has("migration") or has("readableFormats")|not) and (.components.hiveskills|has("migration") or has("readableFormats")|not)' \
  "$temporary/original.json" >/dev/null || { echo 'Older product pins gained a data format transition' >&2; exit 1; }
for versions in '2.1.0 1.4.0 emberpath-v1 hiveskills-v1' '2.2.0 1.4.0 emberpath-managed-format-2 hiveskills-v1' '2.1.0 1.5.0 emberpath-v1 hiveskills-managed-format-3' '2.3.1 1.5.0 emberpath-managed-format-2 hiveskills-managed-format-3'; do
  read -r router skills router_format skills_format <<< "$versions"
  jq --arg router "$router" --arg skills "$skills" '.products.emberpath.version=$router | .products.hiveskills.version=$skills' "$temporary/inputs.json" > "$temporary/format-inputs.json"
  node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/format-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/format.json" >/dev/null
  jq -e --arg router "$router_format" --arg skills "$skills_format" '
    def transition($name; $format; $from):
      .components[$name] as $c | $c.storageFormat==$format and
      (if $format==$from then ($c|has("migration") or has("readableFormats")|not)
       else $c.readableFormats==[$format] and $c.migration=={from:$from,command:["migrate","--backup-dir","/data/migration-backups"]} end);
    transition("emberpath"; $router; "emberpath-v1") and transition("hiveskills"; $skills; "hiveskills-v1")
  ' "$temporary/format.json" >/dev/null || { echo "The product data format contract is wrong for $versions" >&2; exit 1; }
  diff <(jq 'del(.components.emberpath, .components.hiveskills)' "$temporary/format.json") <(jq 'del(.components.emberpath, .components.hiveskills)' "$temporary/original.json") >/dev/null || { echo 'A product data format changed another component' >&2; exit 1; }
done
jq 'del(.products.emberpath.version)' "$temporary/inputs.json" > "$temporary/bad-inputs.json"
if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/bad-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'A product without an exact version skipped its data format review' >&2; exit 1; fi
# Embermend requires an explicit reviewed bridge declaration, not a version guess.
jq '.products.embermend={image:"ghcr.io/example/embermend:0.1.0",version:"0.1.0",platforms:["linux/amd64","linux/arm64"]} | .products.magnus.version="2.5.0" | .products.magnus.embermendProtocol=1' "$temporary/inputs.json" > "$temporary/embermend-inputs.json"
jq --arg digest "$(digest 95)" '.+{embermend:("ghcr.io/example/embermend@"+$digest)}' "$temporary/pinned.json" > "$temporary/embermend-pinned.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/embermend-inputs.json" --pinned "$temporary/embermend-pinned.json" --output "$temporary/embermend.json" >/dev/null
jq -e '.components.magnus.embermendProtocol==1 and .components.embermend.image==.components["embermend-worker"].image and .components["embermend-worker"].version=="0.1.0"' "$temporary/embermend.json" >/dev/null
for change in 'del(.products.magnus.embermendProtocol)' '.products.magnus.embermendProtocol=2' '.products.magnus.version="2.3.7"' '.products.magnus.version="2.4.3"'; do
  jq "$change" "$temporary/embermend-inputs.json" > "$temporary/embermend-bad.json"
  if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/embermend-bad.json" --pinned "$temporary/embermend-pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'An undeclared/incompatible Magnus bridge passed' >&2; exit 1; fi
done
echo 'build-suite-manifest: ok'
