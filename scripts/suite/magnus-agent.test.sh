#!/usr/bin/env bash
# hive.sh magnus-agent and its host script, with stubbed Node.js, npm, systemd, apt and Docker.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
node_secret="obviously-fake-node-manager-secret-$(printf 'n%.0s' {1..20})"
result_secret="obviously-fake-result-signing-secret-$(printf 'r%.0s' {1..20})"
bin="$temporary/bin"; mkdir -p "$bin" "$temporary/log"
log="$temporary/log/calls"
# Every stub records its arguments, so the test can prove no secret was ever an argument.
stub() { printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "%s" "$*" >> "%s"\n%s\n' "$1" "$log" "$2" > "$bin/$1"; chmod +x "$bin/$1"; }
stub id 'if [[ "$*" == -u ]]; then echo 0; else exec /usr/bin/id "$@"; fi'
stub systemctl 'case "$1" in is-active) [[ -f "'"$temporary"'/active" ]] && echo active || echo inactive;; restart) touch "'"$temporary"'/active";; disable) rm -f "'"$temporary"'/active";; esac; exit 0'
stub ss 'exit 0'
stub jq 'exec /usr/bin/jq "$@"'
stub openssl 'exec /usr/bin/openssl "$@"'
stub cat 'exec /usr/bin/cat "$@"'
stub grep 'exec /usr/bin/grep "$@"'
stub tailscale 'exit 1'
stub dpkg 'echo amd64'
stub apt-get 'if [[ "$*" == *nodejs* ]]; then echo v24.22.1 > "'"$temporary"'/node-version"; fi'
stub curl 'while (($#)); do [[ "$1" == -o ]] && cp "'"$temporary"'/nodesource.asc" "$2"; shift; done'
stub gpg 'printf "fpr:::::::::%s:\n" "$(cat "'"$temporary"'/fingerprint")"'
stub npm 'case "$1" in
  pack) v=${@: -1}; v=${v##*@}; printf "fixture-%s\n" "$v" > "magnus-agent-$v.tgz"; echo "magnus-agent-$v.tgz";;
  install) prefix=$3; tarball=${@: -1}; v=${tarball##*magnus-agent-}; v=${v%.tgz}
    mkdir -p "$prefix/node_modules/@hivemagnus/magnus-agent/dist"; printf "{\"version\":\"%s\"}\n" "$v" > "$prefix/node_modules/@hivemagnus/magnus-agent/package.json"
    touch "$prefix/node_modules/@hivemagnus/magnus-agent/dist/index.js";;
esac'
stub node 'if [[ "$1" == --version ]]; then [[ -f "'"$temporary"'/node-version" ]] || exit 127; cat "'"$temporary"'/node-version"; exit; fi
case "$2" in
  check) [[ -f "$4" ]];;
  install-service) dir=$4 unit=$6; v=$(jq -r .version "$dir/node_modules/@hivemagnus/magnus-agent/package.json")
    mkdir -p "$dir/versions/$v"; mv "$dir/node_modules" "$dir/versions/$v/"; ln -s "versions/$v" "$dir/current"; ln -s current/node_modules "$dir/node_modules"; printf "[Unit]\n" > "$unit";;
esac'
nodes() { printf '%s\n' "$1" > "$temporary/node-version"; }
export PATH="$bin:$PATH"
agent="$temporary/opt/magnus-agent"
export MAGNUS_AGENT_UNIT="$temporary/magnus-agent.service" MAGNUS_AGENT_HOST_KEY="$temporary/ssh_host_ed25519_key.pub"
ssh-keygen -q -t ed25519 -N '' -f "$temporary/ssh_host_ed25519_key" -C fixture
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj /CN=hive.example.com -addext subjectAltName=DNS:hive.example.com \
  -keyout "$temporary/console.key" -out "$temporary/console.crt" 2>/dev/null; chmod 600 "$temporary/console.key"
printf 'NODE_ENV=production\nNODE_MANAGER_SECRET=%s\nRESULT_SIGNING_SECRET=%s\n' "$node_secret" "$result_secret" > "$temporary/magnus.env"; chmod 600 "$temporary/magnus.env"
integrity() { printf 'sha512-%s' "$(printf 'fixture-%s\n' "$1" | openssl dgst -sha512 -binary | base64 -w0)"; }
host() { # ACTION REQUEST
  jq -nc --arg action "$1" --argjson request "$2" '{action:$action,magnusAgent:$request}' |
    bash "$ROOT/scripts/suite/magnus-agent-host.sh" > "$temporary/out" 2> "$temporary/err"
}
request() { # VERSION [INTEGRITY]
  jq -nc --arg root "$agent" --arg version "$1" --arg integrity "${2:-$(integrity "$1")}" --arg env "$temporary/magnus.env" --arg cert "$temporary/console.crt" --arg key "$temporary/console.key" \
    '{root:$root,package:{name:"@hivemagnus/magnus-agent",version:$version,integrity:$integrity},controlApiUrl:"https://hive.example.com:4000",hostFqdn:"hive.example.com",
      certificate:{certificate:$cert,key:$key,renewal:"console"},magnusEnvironment:$env}'
}
no_secret() { if /usr/bin/grep -nF -e "$node_secret" -e "$result_secret" "$@" | cut -c1-300 >&2; then fail "A secret appeared in $*"; fi; }

# Node.js: the engines range ^24.22.1 || ^26.13.0.
for case in 'none false' 'v22.12.0 false' 'v24.21.9 false' 'v24.22.1 true' 'v24.30.0 true' 'v25.0.0 false' 'v26.13.0 true' 'v26.12.9 false'; do
  read -r version expected <<< "$case"
  if [[ "$version" == none ]]; then rm -f "$temporary/node-version"; else nodes "$version"; fi
  host magnus-agent-preflight '{}' || fail 'preflight failed'
  [[ $(jq -r '.node.ok // false' "$temporary/out") == "$expected" ]] || fail "Node $version: expected ok=$expected"
done
nodes v22.12.0
if host magnus-agent-install "$(request 2.1.1)"; then fail 'Installed with an old Node.js'; fi
grep -q 'does not satisfy' "$temporary/err" || fail 'The Node.js refusal is unclear'

# Installing Node.js checks NodeSource's key fingerprint.
printf 'KEY\n' > "$temporary/nodesource.asc"
printf '0000000000000000000000000000000000000000\n' > "$temporary/fingerprint"
if host magnus-agent-node '{}'; then fail 'Installed Node.js with a foreign key'; fi
grep -q 'did not match fingerprint' "$temporary/err" || fail 'The key refusal is unclear'
printf '6F71F525282841EEDAF851B42F59B5F99B1BE0B4\n' > "$temporary/fingerprint"
nodes v22.12.0

# The package must match the pinned integrity.
nodes v24.22.1
if host magnus-agent-install "$(request 2.1.1 "sha512-$(printf 'B%.0s' {1..86})==")"; then fail 'Installed a tarball with another integrity'; fi
grep -q 'does not match the integrity' "$temporary/err" || fail 'The integrity refusal is unclear'
[[ ! -e "$agent/node_modules" ]] || fail 'A refused package was installed'

# A fresh install: root-only environment with the credentials, the agent's own service setup.
: > "$log"
host magnus-agent-install "$(request 2.1.1)" || { cat "$temporary/err" >&2; fail 'install failed'; }
jq -e '.version=="2.1.1" and .service=="active" and .changed==true' "$temporary/out" >/dev/null || fail 'install did not report the running version'
[[ $(stat -c %a "$agent/.env") == 600 ]] || fail 'The agent environment is not owner-only'
/usr/bin/grep -qx "NODE_MANAGER_SECRET=$node_secret" "$agent/.env" && /usr/bin/grep -qx "RESULT_SIGNING_SECRET=$result_secret" "$agent/.env" || fail 'The credentials did not reach the agent environment'
grep -qx 'CONTROL_API_URL=https://hive.example.com:4000' "$agent/.env" && grep -qx "TLS_CERT_PATH=$temporary/console.crt" "$agent/.env" || fail 'The agent environment is wrong'
! grep -q MAGNUS_AGENT_TLS_RENEWAL "$agent/.env" || fail 'The console certificate was given to the agent to renew'
[[ -L "$agent/current" && -f "$MAGNUS_AGENT_UNIT" ]] || fail 'install-service did not set up the service'
/usr/bin/grep -q 'install-service --dir' "$log" && /usr/bin/grep -q 'check --env-file' "$log" || fail 'The agent was not checked and set up with its own commands'
no_secret "$log" "$temporary/out" "$temporary/err"

# Repeating changes nothing; a new version upgrades in place; a lost service is repaired.
: > "$log"
host magnus-agent-install "$(request 2.1.1)" || fail 'repeat failed'
jq -e '.changed==false' "$temporary/out" >/dev/null || fail 'A repeat reported a change'
! /usr/bin/grep -q '^npm ' "$log" && ! /usr/bin/grep -q 'install-service' "$log" && ! /usr/bin/grep -q 'systemctl restart' "$log" || fail 'A repeat reinstalled or restarted'
host magnus-agent-install "$(request 2.1.2)" || { cat "$temporary/err" >&2; fail 'upgrade failed'; }
[[ $(readlink "$agent/current") == versions/2.1.2 && $(jq -r .version "$temporary/out") == 2.1.2 ]] || fail 'The upgrade did not switch versions'
rm -f "$temporary/active"; : > "$log"
host magnus-agent-install "$(request 2.1.2)" || fail 'repair failed'
/usr/bin/grep -q 'systemctl restart' "$log" || fail 'A stopped service was not restarted'

# Credentials for another host arrive in the request, never as an argument.
host magnus-agent-install "$(request 2.1.2 | jq -c 'del(.magnusEnvironment)')" && fail 'Installed without credentials' || true
grep -q 'credentials are missing' "$temporary/err" || fail 'Missing credentials were not refused'
/usr/bin/jq -nc --arg action magnus-agent-install --argjson request "$(request 2.1.2 | jq -c 'del(.magnusEnvironment)')" --arg node "${node_secret}x" --arg result "${result_secret}x" \
  '{action:$action,magnusAgent:$request,secret:{NODE_MANAGER_SECRET:$node,RESULT_SIGNING_SECRET:$result}}' | bash "$ROOT/scripts/suite/magnus-agent-host.sh" > "$temporary/out" 2>&1 || fail 'A remote-style install failed'
/usr/bin/grep -qx "NODE_MANAGER_SECRET=${node_secret}x" "$agent/.env" || fail 'Credentials from the request were not written'
no_secret "$temporary/out"

host magnus-agent-host-key '{}' && [[ $(jq -r .fingerprint "$temporary/out") == SHA256:* ]] || fail 'The host key fingerprint was not read'
host magnus-agent-remove "$(jq -nc --arg root "$agent" '{root:$root}')" || fail 'remove failed'
[[ ! -e "$agent" && ! -e "$MAGNUS_AGENT_UNIT" ]] || fail 'remove left the agent behind'
/usr/bin/grep -q 'systemctl disable --now magnus-agent' "$log" || fail 'remove did not stop the service'

# The controller: no agent port, no install; Node.js without consent, no install.
jq -n --arg dir "$temporary/install" '{schema:1,installation:"example-suite",origin:"https://hive.example.com",hosts:{control:{target:"local",directory:$dir}},
  components:{magnus:{host:"control"}},agents:[],inference:[],console:{host:"control"},bootstrap:{certificateFile:"/etc/hive/tls/console.crt",privateKeyFile:"/etc/hive/tls/console.key"}}' > "$temporary/config.json"
controller() { (
  export HIVE_ROOT=$ROOT; source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/magnus-gateway.sh"; source "$ROOT/scripts/suite/magnus-agent.sh"
  HIVE_CONFIG=$temporary/config.json HIVE_MANIFEST=$temporary/release.json HIVE_VERSION=9.9.9 HIVE_ID=example-suite
  HIVE_AGENT_TARGET=${HIVE_AGENT_TARGET:-} HIVE_AGENT_SSH_CONFIG='' HIVE_AGENT_SUDO_FILE='' HIVE_AGENT_INSTALL_NODE=false HIVE_AGENT_TRUST=false HIVE_CONFIRMED=true
  hive_magnus_agent "$@"
) < /dev/null > "$temporary/controller.log" 2>&1; }
jq -n '{components:{magnus:{agentPackage:{name:"@hivemagnus/magnus-agent",version:"2.1.1",integrity:("sha512-"+("A"*86)+"==")}}}}' > "$temporary/release.json"
if controller install; then fail 'Installed without an agent port'; fi
grep -q 'publishes no Magnus agent port' "$temporary/controller.log" || fail 'The missing agent port refusal is unclear'
jq '.console.nativeListeners=[{port:4000,component:"magnus"}]' "$temporary/config.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/config.json"
rm -f "$temporary/node-version"
if controller install; then fail 'Installed without Node.js'; fi
grep -q "Node.js was not installed. Install it yourself" "$temporary/controller.log" && grep -q 6F71F525282841EEDAF851B42F59B5F99B1BE0B4 "$temporary/controller.log" || { cat "$temporary/controller.log" >&2; fail "No manual alternative without consent"; }
jq 'del(.components.magnus.agentPackage)' "$temporary/release.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/release.json"; nodes v24.22.1
if controller install; then fail 'Installed from a release with no pinned package'; fi
grep -q 'pins no Magnus agent package' "$temporary/controller.log" || fail 'The missing pin refusal is unclear'
no_secret "$log" "$temporary/controller.log"
# A fleet host over SSH: the credentials stream from the Magnus host through an owner-only file
# and standard input only, then Magnus accepts the heartbeat and the node is reported.
stub ssh 'exec bash -c "${@: -1}"'
stub docker 'printf "{\"id\":\"node-1\",\"name\":\"node-1.example.com\",\"status\":\"ONLINE\",\"lastHeartbeatAt\":\"%s\"}\n" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj /CN=node-1.example.com -addext subjectAltName=DNS:node-1.example.com \
  -keyout "$temporary/node.key" -out "$temporary/node.crt" 2>/dev/null
stub tailscale 'case "$1" in status) echo "{\"Self\":{\"DNSName\":\"node-1.example.com.\"},\"CertDomains\":[\"node-1.example.com\"]}";;
  cert) shift; while (($# > 1)); do case "$1" in --cert-file) cp "'"$temporary"'/node.crt" "$2"; shift;; --key-file) cp "'"$temporary"'/node.key" "$2"; shift;; esac; shift; done;; esac'
mkdir -p "$temporary/install/config"; cp "$temporary/magnus.env" "$temporary/install/config/magnus.env"
jq '.hosts.fleet={target:"deploy@node-1.example.com",directory:"/opt/magnus-agent"}' "$temporary/config.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/config.json"
jq --arg i "$(integrity 2.1.1)" '.components.magnus.agentPackage={name:"@hivemagnus/magnus-agent",version:"2.1.1",integrity:$i}' "$temporary/release.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/release.json"
rm -f "$temporary/active"; : > "$log"
HIVE_MAGNUS_AGENT_ROOT=$agent HIVE_AGENT_TARGET=fleet controller install || { cat "$temporary/controller.log" >&2; fail 'A fleet host install failed'; }
grep -q 'Magnus accepted the heartbeat: node node-1 (node-1.example.com), ONLINE' "$temporary/controller.log" || { cat "$temporary/controller.log" >&2; fail 'The accepted heartbeat was not reported'; }
/usr/bin/grep -qx "NODE_MANAGER_SECRET=$node_secret" "$agent/.env" && grep -qx 'MAGNUS_AGENT_TLS_RENEWAL=tailscale' "$agent/.env" && grep -qx 'HOST_FQDN=node-1.example.com' "$agent/.env" || fail 'The fleet host environment is wrong'
[[ $(stat -c %a "$agent/certs/agent.key") == 600 ]] || fail 'The tailscale key is not owner-only'
no_secret "$log" "$temporary/controller.log"
printf 'Passed: Magnus agent Node.js range and NodeSource key, pinned package integrity, root-only credentials never in arguments or output, idempotent repair and upgrade, removal, and controller refusals.\n'
