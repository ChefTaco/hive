#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
export HIVE_ROOT=$ROOT
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/adapters.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() {
  if ( "$@" ) > "$temporary/result" 2>&1; then fail 'Obsolete inference input was accepted'; fi
  grep -q 'Obsolete managed-inference' "$temporary/result" || { cat "$temporary/result"; fail 'Missing migration guidance'; }
}
cp "$ROOT/examples/installation.json" "$temporary/base.json"
jq '.inference=[{id:"existing-provider",host:"control",engine:"ollama",protocol:"openai",endpoint:"https://inference.example.com",model:{id:"existing-model"},authHeaderFile:"/opt/credentials/provider.header"}]' "$temporary/base.json" > "$temporary/external.json"
HIVE_CONFIG=$temporary/external.json HIVE_VERSION=0.1.0
hive_validate
jq '.inference[0].registration={endpoint:"https://console.example.com",apiPrefix:"/api/emberpath",credentialFile:"/opt/credentials/enrollment.header",providerSlug:"example"}' "$temporary/external.json" > "$temporary/prefix.json"
HIVE_CONFIG=$temporary/prefix.json hive_validate
jq '.inference[0].registration.apiPrefix="/api/../providers"' "$temporary/prefix.json" > "$temporary/invalid-prefix.json"
if (HIVE_CONFIG=$temporary/invalid-prefix.json hive_validate) > "$temporary/result" 2>&1; then fail 'Unsafe API prefix passed validation'; fi
hive_plan > "$temporary/plan.json"
jq -e '.inference[0]|.endpoint=="https://inference.example.com" and .credentialConfigured==true and (has("authHeaderFile")|not) and (has("backend")|not)' "$temporary/plan.json" >/dev/null
# No rejection may reach a remote host, Docker, downloader or model store.
mkdir -m 700 "$temporary/bin" "$temporary/models" "$temporary/installation"
printf 'preserve existing model bytes\n' > "$temporary/models/existing.gguf"
for command in docker ssh scp curl; do
  printf '#!/usr/bin/env bash\nprintf "unexpected mutation\\n" >> %q\nexit 99\n' "$temporary/calls" > "$temporary/bin/$command"
  chmod 700 "$temporary/bin/$command"
done
export PATH="$temporary/bin:$PATH"
for patch in '.inference[0].managed=true' '.inference[0].managed=false' '.inference[0].backend="external"' '.inference[0].model.url="https://models.example.com/model.gguf"' '.inference[0].model.downloadBytes=1' '.inference[0].model.license={accepted:true}' '.inference[0].devices=["example"]' '.inference[0].storageDirectory="/opt/models"' '.inferenceProfiles={}' '.components.ollama={host:"control"}'; do
  jq "$patch" "$temporary/external.json" > "$temporary/obsolete.json"
  reject "$ROOT/hive.sh" install --config "$temporary/obsolete.json" --non-interactive --yes
  reject "$ROOT/hive.sh" plan --config "$temporary/obsolete.json"
done
openssl genpkey -algorithm ED25519 -out "$temporary/private" >/dev/null 2>&1
openssl pkey -in "$temporary/private" -pubout -out "$temporary/public" >/dev/null 2>&1
jq -n --slurpfile c "$temporary/base.json" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:"1000:1000",healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.ingress.kind="ingress"' > "$temporary/release.json"
HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/signature HIVE_TRUST_KEY=$temporary/public
cp "$temporary/release.json" "$temporary/valid.json"
for patch in '.inferenceProfiles={}' '.managedInference=[]' '.modelStorage="/opt/models"' '.components.ollama=.components.emberpath' '.components.emberpath.image=("ollama/ollama@sha256:"+("0"*64))'; do
  jq "$patch" "$temporary/valid.json" > "$HIVE_MANIFEST"
  openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$HIVE_MANIFEST" -out "$HIVE_SIGNATURE"
  reject hive_manifest
done
cp "$temporary/valid.json" "$HIVE_MANIFEST"
openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$HIVE_MANIFEST" -out "$HIVE_SIGNATURE"
hive_manifest; hive_render control > "$temporary/rendered.json"
jq -e --slurpfile config "$temporary/base.json" '(.services|keys)==($config[0].components|keys)' "$temporary/rendered.json" >/dev/null
# Existing projects must be held before locking, changing receipts or stopping.
printf '{"services":{"inference-old":{"image":"example.com/retained:old"}}}' > "$temporary/installation/compose.json"
input=$(jq -nc --arg directory "$temporary/installation" '{directory:$directory,installation:"example",host:"control",plan:("a"*64),version:"0.1.0",action:"prepare"}')
if printf '%s\n' "$input" | bash "$ROOT/scripts/suite/host-runtime.sh" > "$temporary/result" 2>&1; then fail 'Existing inference project was adopted'; fi
grep -q 'Obsolete managed-inference Compose project' "$temporary/result" || fail 'Missing legacy project migration guidance'
[[ ! -e "$temporary/installation/controller.lock" && ! -e "$temporary/installation/installation.json" && ! -e "$temporary/calls" ]] || fail 'Inference rejection caused host changes'
rm -- "$temporary/installation/compose.json"
mkdir -p "$temporary/installation/data/hivemem/models"
printf 'retain these external model bytes\n' > "$temporary/installation/data/hivemem/models/existing.GGUF"
if printf '%s\n' "$input" | bash "$ROOT/scripts/suite/host-runtime.sh" > "$temporary/result" 2>&1; then fail 'Existing model assets were adopted'; fi
grep -q 'Obsolete managed-inference model assets' "$temporary/result" || fail 'Missing model asset migration guidance'
[[ $(cat "$temporary/installation/data/hivemem/models/existing.GGUF") == 'retain these external model bytes' ]] || fail 'Existing model asset was changed'
[[ ! -e "$temporary/installation/controller.lock" && ! -e "$temporary/installation/installation.json" && ! -e "$temporary/calls" ]] || fail 'Model asset rejection caused host changes'
[[ $(cat "$temporary/models/existing.gguf") == 'preserve existing model bytes' ]] || fail 'Existing model was changed'
printf 'Passed: external endpoint schema/rendering, obsolete config/release/project migration guards, no host/API/download changes and preserved model files.\n'
