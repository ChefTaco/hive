#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/rejection.log" 2>&1; then fail 'Unsafe initialization was accepted'; fi; }
real_openssl=$(command -v openssl)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/console.key" -out "$temporary/console.crt" -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -days 2 >/dev/null 2>&1
chmod 600 "$temporary/console.key"
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
jq --arg directory "$temporary/install" --arg certificate "$temporary/console.crt" --arg key "$temporary/console.key" '.origin="https://localhost:65429" | .hosts.control.directory=$directory | .console.runtimeFile=($directory+"/config/runtime.json") | .console.httpsPort=65429 | .bootstrap.certificateFile=$certificate | .bootstrap.privateKeyFile=$key | .components|=with_entries(.value|=(. as $p|{host:$p.host}+(if $p.envFile then {envFile:($directory+"/config/"+($p.envFile|split("/")|last))} else {} end)+(if $p.configDirectory then {configDirectory:($directory+"/config/"+($p.configDirectory|split("/")|last))} else {} end)))' "$ROOT/examples/installation.json" > "$temporary/config.json"
jq -n --slurpfile c "$temporary/config.json" --arg user "$(id -u):$(id -g)" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:$user,healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.hivexui.service.user="101:101" | .components.ingress.kind="ingress"' > "$temporary/release.json"
source "$ROOT/scripts/suite/test-catalog.sh"; hive_test_catalog "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
mkdir -m 700 "$temporary/bin"
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
case "$*" in info|'ps -aq --filter label=com.docker.compose.project=example-suite-control') exit 0;;
  'compose -f '*'/compose.json restart ingress') printf '%s\n' "$*" >> "${0%/*}/../docker.log";;
  *) exit 99;; esac
SH
chmod 700 "$temporary/bin/docker"
cat > "$temporary/bin/openssl" <<SH
#!/usr/bin/env bash
if [[ "\$1 \${2:-} \${3:-}" == 'genpkey -algorithm RSA' && ! -e '$temporary/interrupted' ]]; then touch '$temporary/interrupted'; exit 23; fi
exec '$real_openssl' "\$@"
SH
chmod 700 "$temporary/bin/openssl"
export PATH="$temporary/bin:$PATH"
run_init() { "$ROOT/hive.sh" init --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes; }
# A certificate for another name is refused before anything is created: x509 -checkhost
# would report the mismatch and still exit 0.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/wrong.key" -out "$temporary/wrong.crt" -subj '/CN=wrong.example.com' -addext 'subjectAltName=DNS:wrong.example.com' -days 2 >/dev/null 2>&1
chmod 600 "$temporary/wrong.key"
jq --arg certificate "$temporary/wrong.crt" --arg key "$temporary/wrong.key" '.bootstrap.certificateFile=$certificate | .bootstrap.privateKeyFile=$key' "$temporary/config.json" > "$temporary/wrong.json"
if "$ROOT/hive.sh" init --config "$temporary/wrong.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes > "$temporary/wrong.log" 2>&1; then fail 'A console certificate for another name was accepted'; fi
grep -q 'is not valid for localhost' "$temporary/wrong.log" || fail 'The wrong-name refusal does not name the origin'
[[ ! -e "$temporary/install" && ! -e "$temporary/interrupted" ]] || fail 'A wrong-name certificate reached initialization'
reject run_init
[[ -e "$temporary/interrupted" ]] || fail 'Initialization did not reach the injected interruption'
[[ ! -e "$temporary/install/installation.json" && ! -d "$temporary/install/data" ]] || fail 'Configuration setup created application state'
find "$temporary/install/config/.initializer/secrets" -type f -exec sha256sum {} + | sort > "$temporary/secrets.before"
run_init > "$temporary/initialized.log"
find "$temporary/install/config/.initializer/secrets" -type f -exec sha256sum {} + | sort > "$temporary/secrets.after"
cmp -s "$temporary/secrets.before" "$temporary/secrets.after" || fail 'Retry changed initial credentials or IDs'
# A fresh Emberpath serves no HiveMem-backed endpoints, so it gets neither a static memory
# token that would expire nor a HiveMem identity it does not use.
! grep -qE '^(HIVE_ROUTER_MEMORY_PROXY_TOKEN|EMBERPATH_HIVEMEM_CLIENT_ID)=' "$temporary/install/config/emberpath.env" || fail 'A fresh Emberpath holds a memory credential'
! grep -q '^HIVEMEM_OATHWEAVE_SERVICES_JSON=' "$temporary/install/config/hivemem.env" || fail 'A fresh HiveMem links a service it does not serve'
[[ ! -e "$temporary/install/config/.credentials" ]] || fail 'A fresh installation stores a memory client secret'
find "$temporary/install/config" -type f -exec sha256sum {} + | sort > "$temporary/all.before"
run_init > "$temporary/repeat.log"
find "$temporary/install/config" -type f -exec sha256sum {} + | sort > "$temporary/all.after"
cmp -s "$temporary/all.before" "$temporary/all.after" || fail 'Repeated initialization changed configuration'
jq -e '.phase=="complete"' "$temporary/install/config/.initializer/receipt.json" >/dev/null
jq -e '.mode=="suite" and (.products|length)==4 and (.identity|keys)==["apiPrefix","clients","issuer"]' "$temporary/install/config/runtime.json" >/dev/null
# Public browser artifacts contain none of the generated credentials.
while IFS= read -r file; do
  if rg -F -q -- "$(cat "$file")" "$temporary/install/config/runtime.json" "$temporary/install/config/ingress.env"; then fail 'Infrastructure credential reached a browser/ingress artifact'; fi
done < <(find "$temporary/install/config/.initializer/secrets" -type f ! -name '*-id')
# A renewed console certificate. Before tls-refresh, repeating setup refuses the changed input;
# afterwards the ingress serves it, the receipt records it and repeating setup succeeds.
refresh() { "$ROOT/hive.sh" tls-refresh --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub"; }
refresh > "$temporary/refresh.log" || fail 'tls-refresh of an unchanged certificate failed'
grep -q 'already current' "$temporary/refresh.log" && [[ ! -e "$temporary/docker.log" ]] || fail 'An unchanged certificate restarted the ingress'
cp "$temporary/console.crt" "$temporary/original.crt"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/console.key" -out "$temporary/console.crt" -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -days 3 >/dev/null 2>&1
reject run_init
grep -q 'Initialization inputs changed' "$temporary/rejection.log" || fail 'A renewed certificate was not detected'
cp "$temporary/console.key" "$temporary/renewed.key"; cp "$temporary/console.crt" "$temporary/renewed.crt"
cp "$temporary/wrong.crt" "$temporary/console.crt"; cp "$temporary/wrong.key" "$temporary/console.key"
reject refresh
grep -q 'is not valid for localhost' "$temporary/rejection.log" || fail 'tls-refresh did not refuse the name'
cmp -s "$temporary/original.crt" "$temporary/install/config/ingress/console.crt" || fail 'A wrong-name certificate reached the ingress'
cp "$temporary/renewed.crt" "$temporary/console.crt"; cp "$temporary/renewed.key" "$temporary/console.key"
# An installed plan pins its deployment inputs, the ingress configuration among them.
plan=$("$ROOT/hive.sh" plan --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" | jq -r .planDigest)
jq -n --arg config "$temporary/install/config/ingress" '{services:{ingress:{volumes:[{source:$config,read_only:true}]}}}' > "$temporary/install/compose.json"
inputs="$temporary/install/deployment-inputs.$plan.json"
pinned=$(source "$ROOT/scripts/suite/input-artifacts-host.sh"; deployment_inputs_digest "$temporary/install/compose.json")
jq -n --arg sha "$pinned" '{schema:1,sha256:$sha}' > "$inputs"
refresh > "$temporary/refresh.log" || fail 'tls-refresh of a renewed certificate failed'
cmp -s "$temporary/renewed.crt" "$temporary/install/config/ingress/console.crt" && cmp -s "$temporary/renewed.key" "$temporary/install/config/ingress/console.key" || fail 'The ingress copies were not replaced'
cmp -s "$temporary/original.crt" "$temporary/install/config/.initializer/console.crt.previous" || fail 'The previous certificate was not kept'
[[ ! -e "$temporary/install/config/ingress/console.crt.previous" ]] || fail 'The previous certificate was left in the ingress configuration'
[[ $(jq -r .sha256 "$inputs") == "$(source "$ROOT/scripts/suite/input-artifacts-host.sh"; deployment_inputs_digest "$temporary/install/compose.json")" && $(jq -r .sha256 "$inputs") != "$pinned" ]] || fail 'The plan inputs were not re-pinned to the renewed certificate'
[[ $(stat -c %a "$temporary/install/config/ingress/console.key") == 600 ]] || fail 'The renewed key is not owner-only'
grep -q 'restart ingress' "$temporary/docker.log" || fail 'The ingress was not restarted'
run_init > "$temporary/renewed.log" || fail 'Repeating setup after tls-refresh failed'
refresh > "$temporary/refresh.log" && grep -q 'already current' "$temporary/refresh.log" || fail 'A repeated tls-refresh was not a no-op'
# A refresh interrupted after replacing the copies records them and restarts the ingress on retry.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/console.key" -out "$temporary/console.crt" -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -days 4 >/dev/null 2>&1
cp "$temporary/console.crt" "$temporary/install/config/ingress/console.crt"; cp "$temporary/console.key" "$temporary/install/config/ingress/console.key"
: > "$temporary/docker.log"
refresh > "$temporary/refresh.log" || fail 'Retrying an interrupted tls-refresh failed'
grep -q 'restart ingress' "$temporary/docker.log" || fail 'An interrupted refresh did not restart the ingress'
run_init > /dev/null || fail 'Repeating setup after an interrupted refresh failed'
printf 'tampered\n' >> "$temporary/install/config/ingress/backend-ca.pem"
reject refresh
grep -q 'A generated configuration artifact changed' "$temporary/rejection.log" || fail 'tls-refresh accepted a changed artifact'
head -n -1 "$temporary/install/config/ingress/backend-ca.pem" > "$temporary/ca.pem"; cat "$temporary/ca.pem" > "$temporary/install/config/ingress/backend-ca.pem"
run_init > /dev/null || fail 'Restoring the CA bundle did not restore the installation'
cp "$temporary/config.json" "$temporary/valid.json"
jq '.bootstrap.adminEmail="changed@example.com"' "$temporary/valid.json" > "$temporary/config.json"
reject run_init
cp "$temporary/valid.json" "$temporary/config.json"
printf 'OPERATOR_OWNED=retained\n' > "$temporary/install/config/emberpath.env"
reject run_init
[[ $(cat "$temporary/install/config/emberpath.env") == OPERATOR_OWNED=retained ]] || fail 'Existing configuration was overwritten'
printf 'Passed: fresh configuration generation, no memory credential where none is used, interrupted entropy preservation, exact retry, repeat execution, public artifact secret isolation and existing-file refusal, wrong-name certificate refusal and console certificate refresh.\n'
