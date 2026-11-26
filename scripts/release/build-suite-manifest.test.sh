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
# Withdrawn releases are carried, sorted, by the signed manifest; invalid lists are refused.
mkdir -p "$root/releases"
for version in 3.2.1 3.12.8 3.12.9; do printf '{"version":"%s"}\n' "$version" > "$root/releases/$version.json"; done
git -C "$root" add releases && git -C "$root" -c user.name='Synthetic Test' -c user.email=test@example.com commit -qm 'Synthetic releases'
jq '.withdrawn=[{version:"3.12.8",action:"refuse",reason:"Signed but never published",replacement:"3.12.9"},{version:"3.2.1",action:"warn",reason:"Failed its release scan"}]' "$temporary/inputs.json" > "$temporary/withdrawn-inputs.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/withdrawn-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/withdrawn.json" >/dev/null
jq -e '.withdrawn==[{version:"3.2.1",action:"warn",reason:"Failed its release scan"},{version:"3.12.8",action:"refuse",reason:"Signed but never published",replacement:"3.12.9"}]' "$temporary/withdrawn.json" >/dev/null || { echo 'The withdrawn releases were not carried' >&2; exit 1; }
diff <(jq -S 'del(.withdrawn)' "$temporary/withdrawn.json") <(jq -S . "$temporary/original.json") >&2 || { echo 'withdrawn changed more than the list' >&2; exit 1; }
for change in '.withdrawn=[]' '.withdrawn=[{version:"9.9.9",action:"refuse",reason:"x"}]' '.withdrawn=[{version:"1.9.9",action:"refuse",reason:"x"}]' '.withdrawn=[{version:"3.12.8",action:"delete",reason:"x"}]' '.withdrawn=[{version:"3.12.8",action:"refuse",reason:""}]' '.withdrawn=[{version:"3.12.8",action:"refuse",reason:"x",extra:1}]' '.withdrawn=[{version:"3.12.8",action:"refuse",reason:"x",replacement:"3.12.7"}]' '.withdrawn=[{version:"3.12.8",action:"refuse",reason:"x"},{version:"3.12.8",action:"warn",reason:"y"}]'; do
  jq "$change" "$temporary/inputs.json" > "$temporary/bad-inputs.json"
  if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/bad-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo "An invalid withdrawn list passed: $change" >&2; exit 1; fi
done
# The list is cumulative: a later release must keep every entry of the newest earlier manifest.
printf '{"version":"9.9.8","withdrawn":[{"version":"3.12.8","action":"refuse","reason":"x"}]}\n' > "$root/releases/9.9.8.json"
git -C "$root" add releases && git -C "$root" -c user.name='Synthetic Test' -c user.email=test@example.com commit -qm 'Synthetic withdrawal'
if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'A withdrawal was dropped' >&2; exit 1; fi
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/withdrawn-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/withdrawn.json" >/dev/null
git -C "$root" rm -q releases/9.9.8.json && git -C "$root" -c user.name='Synthetic Test' -c user.email=test@example.com commit -qm 'Drop synthetic withdrawal'
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
jq '.datastoreProfile="runtime-2026-11" | .version="3.2.1"' "$temporary/inputs.json" > "$temporary/runtime-inputs.json"
jq --arg redis "ghcr.io/cheftaco/hive-redis@$(digest 8)" --arg qdrant "ghcr.io/cheftaco/hive-qdrant@$(digest 9)" \
  --arg pg17 "ghcr.io/cheftaco/hive-postgres@$(digest 10)" --arg pg18 "ghcr.io/cheftaco/hive-postgres@$(digest 11)" \
  '.+{"datastore:redis":$redis,"datastore:qdrant":$qdrant,"datastore:postgres17":$pg17,"datastore:postgres18":$pg18}' \
  "$temporary/pinned.json" > "$temporary/runtime-pinned.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 3.2.1 --inputs "$temporary/runtime-inputs.json" --pinned "$temporary/runtime-pinned.json" --output "$temporary/runtime.json" >/dev/null
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
node "$root/scripts/release/build-suite-manifest.mjs" --version 3.2.1 --check --inputs "$temporary/runtime-inputs.json" --output "$temporary/runtime.json" >/dev/null
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
node "$root/scripts/release/build-suite-manifest.mjs" --version 3.2.1 --inputs "$temporary/patched-inputs.json" --pinned "$temporary/runtime-pinned.json" --output "$temporary/patched.json" >/dev/null
cmp "$temporary/runtime.json" "$temporary/patched.json" || { echo 'The library patch changed the storage or product contract' >&2; exit 1; }
# A PostgreSQL security minor release selects new immutable images for the same majors.
# Only the datastore image and recorded minor version change: the storage format, readable
# formats and explicit reconciliation stay exactly the xslt profile's, so an upgrade from it
# needs no storage transition. Superseded profiles are refused for later suite releases.
node --input-type=module - "$root/scripts/suite/release-contracts.mjs" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { datastoreProfileReferences: references, assertDatastoreProfileCurrent: current } = await import(pathToFileURL(process.argv[2]));
const xslt = references('runtime-2026-11-xslt'), minor = references('runtime-2026-11-pg1712');
assert.equal(xslt['datastore:postgres17'].image, 'ghcr.io/cheftaco/hive-postgres:17.11-4');
assert.equal(xslt['datastore:postgres18'].image, 'ghcr.io/cheftaco/hive-postgres:18.6-4');
assert.equal(minor['datastore:postgres17'].image, 'ghcr.io/cheftaco/hive-postgres:17.12-1');
assert.equal(minor['datastore:postgres18'].image, 'ghcr.io/cheftaco/hive-postgres:18.7-1');
assert.equal(minor['datastore:postgres17'].version, '17.12');
assert.equal(minor['datastore:postgres18'].version, '18.7');
assert.deepEqual(minor['datastore:redis'], xslt['datastore:redis']);
assert.deepEqual(minor['datastore:qdrant'], xslt['datastore:qdrant']);
for (const version of ['3.2.1', '3.6.1']) current(version, 'runtime-2026-11-xslt');
current('3.2.1', 'runtime-2026-11');
for (const version of ['3.6.2', '3.7.0', '4.0.0']) assert.throws(() => current(version, 'runtime-2026-11-xslt'), /superseded/);
assert.throws(() => current('3.3.0', 'runtime-2026-11'), /superseded/);
current('3.7.0', 'runtime-2026-11-pg1712');
assert.throws(() => current('3.8.0', 'runtime-2026-11-pg1712'), /superseded/);
// The libxslt patch of the same minor releases: new immutable PostgreSQL tags only.
const patch = references('runtime-2026-11-pg1712-xslt');
assert.equal(patch['datastore:postgres17'].image, 'ghcr.io/cheftaco/hive-postgres:17.12-2');
assert.equal(patch['datastore:postgres18'].image, 'ghcr.io/cheftaco/hive-postgres:18.7-2');
assert.equal(patch['datastore:postgres17'].version, minor['datastore:postgres17'].version);
assert.equal(patch['datastore:postgres18'].version, minor['datastore:postgres18'].version);
assert.deepEqual(patch['datastore:redis'], minor['datastore:redis']);
assert.deepEqual(patch['datastore:qdrant'], minor['datastore:qdrant']);
current('3.14.0', 'runtime-2026-11-pg1712-xslt');
assert.throws(() => current('3.14.1', 'runtime-2026-11-pg1712-xslt'), /superseded/);
// The Zstandard patch of the same minor releases: new immutable PostgreSQL tags only.
const zstd = references('runtime-2026-11-pg1712-zstd');
assert.equal(zstd['datastore:postgres17'].image, 'ghcr.io/cheftaco/hive-postgres:17.12-3');
assert.equal(zstd['datastore:postgres18'].image, 'ghcr.io/cheftaco/hive-postgres:18.7-3');
assert.equal(zstd['datastore:postgres17'].version, patch['datastore:postgres17'].version);
assert.equal(zstd['datastore:postgres18'].version, patch['datastore:postgres18'].version);
assert.deepEqual(zstd['datastore:redis'], patch['datastore:redis']);
assert.deepEqual(zstd['datastore:qdrant'], patch['datastore:qdrant']);
current('3.14.3', 'runtime-2026-11-pg1712-zstd');
assert.throws(() => current('3.15.0', 'runtime-2026-11-pg1712-zstd'), /superseded/);
// The OpenSSL patch of the Redis image: a new immutable Redis tag only.
const openssl = references('runtime-2026-11-pg1712-zstd-openssl');
assert.equal(openssl['datastore:redis'].image, 'ghcr.io/cheftaco/hive-redis:8.2.10-3');
assert.equal(openssl['datastore:redis'].version, zstd['datastore:redis'].version);
assert.deepEqual(openssl['datastore:qdrant'], zstd['datastore:qdrant']);
assert.deepEqual(openssl['datastore:postgres17'], zstd['datastore:postgres17']);
assert.deepEqual(openssl['datastore:postgres18'], zstd['datastore:postgres18']);
current('9.9.9', 'runtime-2026-11-pg1712-zstd-openssl');
NODE
jq '.datastoreProfile="runtime-2026-11-xslt"' "$temporary/inputs.json" > "$temporary/xslt-inputs.json"
jq '.datastoreProfile="runtime-2026-11-pg1712"' "$temporary/inputs.json" > "$temporary/minor-inputs.json"
jq --arg pg17 "ghcr.io/cheftaco/hive-postgres@$(digest 12)" --arg pg18 "ghcr.io/cheftaco/hive-postgres@$(digest 13)" \
  '.+{"datastore:postgres17":$pg17,"datastore:postgres18":$pg18}' "$temporary/runtime-pinned.json" > "$temporary/minor-pinned.json"
if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/xslt-inputs.json" --pinned "$temporary/runtime-pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'A superseded datastore profile passed for a later release' >&2; exit 1; fi
jq '.version="3.6.1"' "$temporary/xslt-inputs.json" > "$temporary/xslt-historical.json"
jq '.version="3.6.1"' "$temporary/minor-inputs.json" > "$temporary/minor-historical.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 3.6.1 --inputs "$temporary/xslt-historical.json" --pinned "$temporary/runtime-pinned.json" --output "$temporary/xslt.json" >/dev/null
node "$root/scripts/release/build-suite-manifest.mjs" --version 3.6.1 --inputs "$temporary/minor-historical.json" --pinned "$temporary/minor-pinned.json" --output "$temporary/minor-same.json" >/dev/null
jq '.version="3.7.0"' "$temporary/minor-inputs.json" > "$temporary/minor-370.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 3.7.0 --inputs "$temporary/minor-370.json" --pinned "$temporary/minor-pinned.json" --output "$temporary/minor.json" >/dev/null
jq -e --slurpfile pinned "$temporary/minor-pinned.json" '
  .components["magnus-postgres"].image==$pinned[0]["datastore:postgres17"] and .components["chattermost-postgres"].image==$pinned[0]["datastore:postgres17"] and
  .components["cindertrace-postgres"].image==$pinned[0]["datastore:postgres18"] and
  .components["magnus-postgres"].version=="17.12" and .components["chattermost-postgres"].version=="17.12" and .components["cindertrace-postgres"].version=="18.7"
' "$temporary/minor.json" >/dev/null || { echo 'The PostgreSQL minor profile did not select its images' >&2; exit 1; }
strip='del(.components[]|select(.kind=="datastore" and (.image|startswith("ghcr.io/cheftaco/hive-postgres@")))|.image,.version)'
cmp <(jq -S "$strip" "$temporary/xslt.json") <(jq -S "$strip" "$temporary/minor-same.json") || { echo 'The PostgreSQL minor release changed a storage or product contract' >&2; exit 1; }
jq '.datastoreProfile="runtime-2026-11-pg1712-xslt" | .version="3.6.1"' "$temporary/inputs.json" > "$temporary/patch-inputs.json"
jq --arg pg17 "ghcr.io/cheftaco/hive-postgres@$(digest 14)" --arg pg18 "ghcr.io/cheftaco/hive-postgres@$(digest 15)" \
  '.+{"datastore:postgres17":$pg17,"datastore:postgres18":$pg18}' "$temporary/runtime-pinned.json" > "$temporary/patch-pinned.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 3.6.1 --inputs "$temporary/patch-inputs.json" --pinned "$temporary/patch-pinned.json" --output "$temporary/patch-same.json" >/dev/null
cmp <(jq -S "$strip" "$temporary/minor-same.json") <(jq -S "$strip" "$temporary/patch-same.json") || { echo 'The PostgreSQL library patch changed a storage or product contract' >&2; exit 1; }
if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/minor-inputs.json" --pinned "$temporary/minor-pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'The superseded PostgreSQL minor profile passed for a later release' >&2; exit 1; fi
for profile in unknown legacy null; do
  jq --arg profile "$profile" '.datastoreProfile=(if $profile=="null" then null else $profile end)' "$temporary/runtime-inputs.json" > "$temporary/bad-inputs.json"
  if node "$root/scripts/release/build-suite-manifest.mjs" --version 3.2.1 --inputs "$temporary/bad-inputs.json" --pinned "$temporary/runtime-pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'An unknown datastore profile passed' >&2; exit 1; fi
done
for mutation in 'del(.["datastore:postgres17"])' '.["datastore:redis"]="ghcr.io/example/other@sha256:"+("a"*64)'; do
  jq "$mutation" "$temporary/runtime-pinned.json" > "$temporary/bad-pinned.json"
  if node "$root/scripts/release/build-suite-manifest.mjs" --version 3.2.1 --inputs "$temporary/runtime-inputs.json" --pinned "$temporary/bad-pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'An incomplete or foreign datastore pin passed' >&2; exit 1; fi
done
# Emberpath 2.2.0 and HiveSkills 1.5.0 change their product data formats. Their upgrade is an
# explicit storage transition running each product's own migrate; older pins stay unchanged.
jq -e '.components.emberpath.storageFormat=="emberpath-v1" and .components.hiveskills.storageFormat=="hiveskills-v1" and
  (.components.emberpath|has("migration") or has("readableFormats")|not) and (.components.hiveskills|has("migration") or has("readableFormats")|not)' \
  "$temporary/original.json" >/dev/null || { echo 'Older product pins gained a data format transition' >&2; exit 1; }
# Emberpath 2.6.0's managed-format-3 migrates from managed-format-2.
for versions in '2.1.0 1.4.0 emberpath-v1 hiveskills-v1' '2.2.0 1.4.0 emberpath-managed-format-2 hiveskills-v1' '2.1.0 1.5.0 emberpath-v1 hiveskills-managed-format-3' '2.3.1 1.5.0 emberpath-managed-format-2 hiveskills-managed-format-3' '2.5.4 1.9.0 emberpath-managed-format-2 hiveskills-managed-format-3' '2.6.0 1.9.0 emberpath-managed-format-3 hiveskills-managed-format-3' '2.7.1 1.9.0 emberpath-managed-format-3 hiveskills-managed-format-3'; do
  read -r router skills router_format skills_format <<< "$versions"
  router_from=emberpath-v1; [[ "$router_format" != emberpath-managed-format-3 ]] || router_from=emberpath-managed-format-2
  jq --arg router "$router" --arg skills "$skills" '.products.emberpath.version=$router | .products.hiveskills.version=$skills' "$temporary/inputs.json" > "$temporary/format-inputs.json"
  node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/format-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/format.json" >/dev/null
  jq -e --arg router "$router_format" --arg skills "$skills_format" --arg router_from "$router_from" '
    def transition($name; $format; $from):
      .components[$name] as $c | $c.storageFormat==$format and
      (if $format==$from then ($c|has("migration") or has("readableFormats")|not)
       else $c.readableFormats==[$format] and $c.migration=={from:$from,command:["migrate","--backup-dir","/data/migration-backups"]} end);
    transition("emberpath"; $router; $router_from) and transition("hiveskills"; $skills; "hiveskills-v1")
  ' "$temporary/format.json" >/dev/null || { echo "The product data format contract is wrong for $versions" >&2; exit 1; }
  diff <(jq 'del(.components.emberpath, .components.hiveskills)' "$temporary/format.json") <(jq 'del(.components.emberpath, .components.hiveskills)' "$temporary/original.json") >/dev/null || { echo 'A product data format changed another component' >&2; exit 1; }
done
jq 'del(.products.emberpath.version)' "$temporary/inputs.json" > "$temporary/bad-inputs.json"
if node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/bad-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/bad.json" >/dev/null 2>&1; then echo 'A product without an exact version skipped its data format review' >&2; exit 1; fi
# HiveMem 1.9.0 moves Emberpath's former memory principal, hive-router, to emberpath as its signed
# initialization; older HiveMem pins have none and stay byte for byte.
jq -e '.components.hivemem|has("initialization")|not' "$temporary/original.json" >/dev/null || { echo 'An older HiveMem gained an initialization' >&2; exit 1; }
for version in 1.9.0 1.10.2 2.0.0; do
  jq --arg version "$version" '.products.hivemem.version=$version' "$temporary/inputs.json" > "$temporary/memory-inputs.json"
  node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/memory-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/memory.json" >/dev/null
  jq -e '.components.hivemem as $memory | $memory.initialization=={image:$memory.image,
      command:["rename-agent","--from","hive-router","--to","emberpath"],
      verificationCommand:["rename-agent","--from","hive-router","--to","emberpath","--verify"]}' "$temporary/memory.json" >/dev/null || { echo "HiveMem $version lacks the reviewed memory identity rename" >&2; exit 1; }
  diff <(jq 'del(.components.hivemem)' "$temporary/memory.json") <(jq 'del(.components.hivemem)' "$temporary/original.json") >/dev/null || { echo 'The memory identity rename changed another component' >&2; exit 1; }
done
jq '.products.hivemem.version="1.8.9"' "$temporary/inputs.json" > "$temporary/memory-inputs.json"
node "$root/scripts/release/build-suite-manifest.mjs" --version 9.9.9 --inputs "$temporary/memory-inputs.json" --pinned "$temporary/pinned.json" --output "$temporary/memory.json" >/dev/null
jq -e '.components.hivemem|has("initialization")|not' "$temporary/memory.json" >/dev/null || { echo 'HiveMem 1.8.9 gained an initialization' >&2; exit 1; }
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
