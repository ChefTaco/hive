#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/rejection.log" 2>&1; then fail 'Unsafe fresh custom selection was accepted'; fi; }
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/server.key" -out "$temporary/server.crt" -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -days 2 >/dev/null 2>&1
chmod 600 "$temporary/server.key"
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
jq -n --slurpfile c "$ROOT/examples/installation.json" --arg user "$(id -u):$(id -g)" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:$user,healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.hivexui.service.user="101:101" | .components.ingress.kind="ingress"' > "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
mkdir "$temporary/bin"
printf '#!/usr/bin/env bash\n[[ "$1" == info || "$1" == ps ]]\n' > "$temporary/bin/docker"
chmod +x "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
run_init() { "$ROOT/hive.sh" init --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes; }
for selection in foundation skills models memory coordinated; do
  case "$selection" in foundation) extras='[]';; skills) extras='["hiveskills"]';; models) extras='["emberpath"]';; memory) extras='["hivemem","hivemem-qdrant"]';; coordinated) extras='["emberpath","hivemem","hivemem-qdrant"]';; esac
  jq --arg root "$temporary/$selection" --arg cert "$temporary/server.crt" --arg key "$temporary/server.key" --argjson extras "$extras" '
    .profile="custom" | .installation="custom-proof" | .origin="https://localhost:65428" | .hosts.control.directory=$root |
    (["oathweave","oathweave-redis","hivexui","ingress"]+$extras) as $names |
    .components|=with_entries(select(.key as $name|$names|index($name)!=null)) |
    .components|=with_entries(.key as $name|if $name!="hivexui" then .value.configDirectory=($root+"/config/"+$name) else . end|if .value.envFile then .value.envFile=($root+"/config/"+$name+".env") else . end) |
    .console.httpsPort=65428 | .console.runtimeFile=($root+"/config/runtime.json") |
    .bootstrap.certificateFile=$cert | .bootstrap.privateKeyFile=$key
  ' "$ROOT/examples/installation.json" > "$temporary/config.json"
  run_init > "$temporary/$selection.log"
  runtime="$temporary/$selection/config/runtime.json"
  jq -e --argjson extras "$extras" '(.products|keys)==(["oathweave"]+($extras|map(select(.!="hivemem-qdrant")))|sort)' "$runtime" >/dev/null || fail 'Unselected product reached browser runtime'
  clients="$temporary/$selection/config/oathweave/suite-bootstrap.json"
  jq -e --slurpfile runtime "$runtime" '(.clients|map(.audience)|sort)==($runtime[0].products|keys)' "$clients" >/dev/null || fail 'Unselected product received browser client grants'
  if [[ "$selection" == coordinated ]]; then
    rg -q '^IAM_ENROLLMENT_PRODUCTS_JSON=' "$temporary/$selection/config/oathweave.env" || fail 'Selected coordinated enrollment missing'
    jq -e '.enrollmentInstallationId=="custom-proof"' "$runtime" >/dev/null
  else
    if rg -q '^IAM_ENROLLMENT_(INSTALLATION_ID|PRODUCTS_JSON)=' "$temporary/$selection/config/oathweave.env"; then fail 'Incomplete coordinator points at an unselected product'; fi
    jq -e 'has("enrollmentInstallationId")|not' "$runtime" >/dev/null
  fi
  for product in emberpath hivemem hiveskills; do
    if ! jq -e --arg name "$product" 'index($name)!=null' <<< "$extras" >/dev/null; then
      [[ ! -e "$temporary/$selection/config/$product.env" && ! -e "$temporary/$selection/config/$product" ]] || fail 'Unselected product configuration was created'
    fi
  done
  [[ "$selection" == models || "$selection" == coordinated || ! -e "$temporary/$selection/config/.initializer/secrets/model-id" ]] || fail 'Unselected model product account created'
  [[ "$selection" == memory || "$selection" == coordinated || ! -e "$temporary/$selection/config/.initializer/secrets/memory-id" ]] || fail 'Unselected memory product account created'
  find "$temporary/$selection/config" -type f -exec sha256sum {} + | sort > "$temporary/before"
  run_init > "$temporary/$selection-repeat.log"
  find "$temporary/$selection/config" -type f -exec sha256sum {} + | sort > "$temporary/after"
  cmp -s "$temporary/before" "$temporary/after" || fail 'Repeated custom initialization changed an artifact'
done
jq 'del(.components.oathweave)' "$temporary/config.json" > "$temporary/bad.json"; mv "$temporary/bad.json" "$temporary/config.json"
reject run_init
rg -q 'Fresh suite initialization requires Oathweave' "$temporary/rejection.log" || fail 'Missing foundation was not rejected before existing-state checks'
printf 'Passed: selectable fresh foundation, optional models/memory/skills, selected-only client grants/IDs/config, explicit unavailable partial coordinator and stable repeated setup.\n'
