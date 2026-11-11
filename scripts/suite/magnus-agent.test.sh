#!/usr/bin/env bash
# hive.sh magnus-agent and its host script, with stubbed Node.js, npm, systemd, apt and Docker.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
node_secret="obviously-fake-node-manager-secret-$(printf 'n%.0s' {1..20})"
result_secret="obviously-fake-result-signing-secret-$(printf 'r%.0s' {1..20})"
reconcile_secret="obviously-fake-command-reconciliation-secret-$(printf 'c%.0s' {1..20})"
bin="$temporary/bin"; mkdir -p "$bin" "$temporary/log"
log="$temporary/log/calls"
# Every stub records its arguments, so the test can prove no secret was ever an argument.
stub() { printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "%s" "$*" >> "%s"\n%s\n' "$1" "$log" "$2" > "$bin/$1"; chmod +x "$bin/$1"; }
stub id 'case "$*" in -u) echo 0;; "-u hive-agent") echo 1234;; "-u terminal-fixture") echo 1235;; "-G terminal-fixture") echo 1235;; "-nG hive-agent") echo hive-agent;; hive-agent) [[ -f "'"$temporary"'/native-user-created" ]];; *) exec /usr/bin/id "$@";; esac'
mkdir -p "$temporary/native-home"
stub useradd 'touch "'"$temporary"'/native-user-created"'
stub getent 'printf "hive-agent:x:1234:1234:Native runtimes:%s:/bin/bash\n" "'"$temporary"'/native-home"'
stub loginctl 'exit 0'
stub systemctl 'case "$1" in is-active) [[ -f "'"$temporary"'/active" ]] && echo active || echo inactive;; restart) touch "'"$temporary"'/active";; disable) rm -f "'"$temporary"'/active";; esac; exit 0'
stub ss 'exit 0'
stub jq 'exec /usr/bin/jq "$@"'
stub openssl 'exec /usr/bin/openssl "$@"'
stub cat 'exec /usr/bin/cat "$@"'
stub grep 'exec /usr/bin/grep "$@"'
stub tailscale 'exit 1'
stub dpkg 'echo amd64'
stub apt-get 'if [[ "$*" == *nodejs* ]]; then echo v24.22.3 > "'"$temporary"'/node-version"; fi'
stub curl 'while (($#)); do [[ "$1" == -o ]] && cp "'"$temporary"'/nodesource.asc" "$2"; shift; done'
stub gpg 'printf "fpr:::::::::%s:\n" "$(cat "'"$temporary"'/fingerprint")"'
stub npm 'case "$1" in
  pack) spec=${@: -1}; v=${spec##*@}; name=magnus-agent; [[ "$spec" != @hivemagnus/ardent@* ]] || name=ardent
    cp "'"$temporary"'/fixtures/$name-$v.tgz" "$name-$v.tgz"; echo "$name-$v.tgz";;
  ci) [[ "$*" == *--ignore-scripts* && "$*" == *--registry=https://registry.npmjs.org/* && "$*" == *--omit=dev* ]] || exit 99
    [[ ! -f "'"$temporary"'/fail-ci" ]] || { printf "npm error code EINTEGRITY\nprivate diagnostic must stay private\n" >&2; exit 98; };;
  *) exit 97;;
esac'

stub node 'if [[ "$1" == --input-type=module ]]; then cat >/dev/null; [[ ! -f "'"$temporary"'/fail-terminal-preflight" ]]; exit; fi
if [[ "$1" == --version ]]; then [[ -f "'"$temporary"'/node-version" ]] || exit 127; cat "'"$temporary"'/node-version"; exit; fi
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
printf 'NODE_ENV=production\nNODE_MANAGER_SECRET=%s\nRESULT_SIGNING_SECRET=%s\nCOMMAND_RECONCILIATION_SECRET=%s\n' "$node_secret" "$result_secret" "$reconcile_secret" > "$temporary/magnus.env"; chmod 600 "$temporary/magnus.env"
# Real archives exercise extraction and lock validation; only the npm transport is stubbed.
mkdir -p "$temporary/fixtures"
mkdir -p "$temporary/ardent-fixture/package"
printf '{"name":"@hivemagnus/ardent","version":"1.0.0"}\n' > "$temporary/ardent-fixture/package/package.json"
tar -czf "$temporary/fixtures/ardent-1.0.0.tgz" -C "$temporary/ardent-fixture" package
ardent_integrity="sha512-$(openssl dgst -sha512 -binary "$temporary/fixtures/ardent-1.0.0.tgz" | base64 -w0)"
for version in 2.1.1 2.1.2; do
  mkdir -p "$temporary/fixture/package/dist"
  jq -n --arg version "$version" '{name:"@hivemagnus/magnus-agent",version:$version,dependencies:{"fixture-dependency":"1.0.0","@hivemagnus/ardent":"1.0.0"}}' > "$temporary/fixture/package/package.json"
  jq -n --arg ardentIntegrity "$ardent_integrity" --slurpfile package "$temporary/fixture/package/package.json" '{name:$package[0].name,version:$package[0].version,lockfileVersion:3,packages:{"":$package[0],"node_modules/fixture-dependency":{version:"1.0.0",resolved:"https://registry.npmjs.org/fixture-dependency/-/fixture-dependency-1.0.0.tgz",integrity:("sha512-"+("A"*86)+"==")},"node_modules/@hivemagnus/ardent":{version:"1.0.0",resolved:"https://registry.npmjs.org/@hivemagnus/ardent/-/ardent-1.0.0.tgz",integrity:$ardentIntegrity}}}' > "$temporary/fixture/package/npm-shrinkwrap.json"
  touch "$temporary/fixture/package/dist/index.js"
  tar -czf "$temporary/fixtures/magnus-agent-$version.tgz" -C "$temporary/fixture" package
done
integrity() { printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$temporary/fixtures/magnus-agent-$1.tgz" | base64 -w0)"; }
host() { # ACTION REQUEST
  jq -nc --arg action "$1" --argjson request "$2" '{action:$action,magnusAgent:$request}' |
    bash "$ROOT/scripts/suite/magnus-agent-host.sh" > "$temporary/out" 2> "$temporary/err"
}
request() { # VERSION [INTEGRITY]
  jq -nc --arg root "$agent" --arg version "$1" --arg integrity "${2:-$(integrity "$1")}" --arg env "$temporary/magnus.env" --arg cert "$temporary/console.crt" --arg key "$temporary/console.key" \
    '{root:$root,package:{name:"@hivemagnus/magnus-agent",version:$version,integrity:$integrity},controlApiUrl:"https://hive.example.com:4000",hostFqdn:"hive.example.com",
      certificate:{certificate:$cert,key:$key,renewal:"console"},magnusEnvironment:$env}'
}
no_secret() { if /usr/bin/grep -nF -e "$node_secret" -e "$result_secret" -e "$reconcile_secret" "$@" | cut -c1-300 >&2; then fail "A secret appeared in $*"; fi; }

# Node.js: the engines range ^24.22.3 || ^26.13.1.
for case in 'none false' 'v22.12.0 false' 'v24.21.9 false' 'v24.22.1 false' 'v24.22.2 false' 'v24.22.3 true' 'v24.30.0 true' 'v25.0.0 false' 'v26.13.0 false' 'v26.13.1 true' 'v26.12.9 false'; do
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
nodes v24.22.3
if host magnus-agent-install "$(request 2.1.1 "sha512-$(printf 'B%.0s' {1..86})==")"; then fail 'Installed a tarball with another integrity'; fi
grep -q 'does not match the integrity' "$temporary/err" || fail 'The integrity refusal is unclear'
[[ ! -e "$agent/node_modules" ]] || fail 'A refused package was installed'

# A correctly signed top-level package without a shrinkwrap is still refused.
cp "$temporary/fixtures/magnus-agent-2.1.1.tgz" "$temporary/original.tgz"
rm -f "$temporary/fixture/package/npm-shrinkwrap.json"
jq '.version="2.1.1"' "$temporary/fixture/package/package.json" > "$temporary/manifest.json"; mv "$temporary/manifest.json" "$temporary/fixture/package/package.json"
tar -czf "$temporary/fixtures/magnus-agent-2.1.1.tgz" -C "$temporary/fixture" package
if host magnus-agent-install "$(request 2.1.1)"; then fail 'Installed an unlocked agent'; fi
grep -q 'no locked dependency graph' "$temporary/err" || fail 'The missing shrinkwrap refusal is unclear'
[[ ! -e "$agent/node_modules" ]] || fail 'An unlocked package replaced the agent'
cp "$temporary/original.tgz" "$temporary/fixtures/magnus-agent-2.1.1.tgz"
# A complete-looking lock must match the signed package dependencies.
tar -xzf "$temporary/original.tgz" -C "$temporary/fixture"
jq '.packages[""].dependencies={}' "$temporary/fixture/package/npm-shrinkwrap.json" > "$temporary/lock.json"; mv "$temporary/lock.json" "$temporary/fixture/package/npm-shrinkwrap.json"
tar -czf "$temporary/fixtures/magnus-agent-2.1.1.tgz" -C "$temporary/fixture" package
if host magnus-agent-install "$(request 2.1.1)"; then fail 'Installed a mismatched shrinkwrap'; fi
grep -q 'incomplete or does not match' "$temporary/err" || fail 'The lock mismatch refusal is unclear'
cp "$temporary/original.tgz" "$temporary/fixtures/magnus-agent-2.1.1.tgz"

# A fresh install: root-only environment with the credentials, the agent's own service setup.
: > "$log"
host magnus-agent-install "$(request 2.1.1)" || { cat "$temporary/err" >&2; fail 'install failed'; }
jq -e '.version=="2.1.1" and .service=="active" and .changed==true' "$temporary/out" >/dev/null || fail 'install did not report the running version'
[[ $(stat -c %a "$agent/.env") == 600 ]] || fail 'The agent environment is not owner-only'
/usr/bin/grep -qx "NODE_MANAGER_SECRET=$node_secret" "$agent/.env" && /usr/bin/grep -qx "RESULT_SIGNING_SECRET=$result_secret" "$agent/.env" || fail 'The credentials did not reach the agent environment'
/usr/bin/grep -qx "COMMAND_RECONCILIATION_SECRET=$reconcile_secret" "$agent/.env" || fail 'The command reconciliation key did not reach the agent environment'
grep -qx 'CONTROL_API_URL=https://hive.example.com:4000' "$agent/.env" && grep -qx "TLS_CERT_PATH=$temporary/console.crt" "$agent/.env" || fail 'The agent environment is wrong'
! grep -q MAGNUS_AGENT_TLS_RENEWAL "$agent/.env" || fail 'The console certificate was given to the agent to renew'
[[ -L "$agent/current" && -f "$MAGNUS_AGENT_UNIT" ]] || fail 'install-service did not set up the service'
/usr/bin/grep -q 'install-service --dir' "$log" && /usr/bin/grep -q 'check --env-file' "$log" || fail 'The agent was not checked and set up with its own commands'
no_secret "$log" "$temporary/out" "$temporary/err"
grep -qx 'ARDENT_OWNER_USER=hive-agent' "$agent/.env" || fail 'Native runtimes have no non-root owner'
/usr/bin/grep -q 'loginctl enable-linger hive-agent' "$log" && /usr/bin/grep -q 'systemctl start user@1234.service' "$log" || fail 'The native owner user service was not enabled'
[[ -f "$agent.native-owner.json" ]] || fail 'The native owner has no installation ownership record'
staged=$(sed -n 's/^ARDENT_STAGED_PACKAGE=//p' "$agent/.env")
[[ -f "$staged" && $(stat -c %a "$staged") == 644 && $(stat -c %a "$(dirname "$staged")") == 755 ]] || fail 'The native owner cannot read the staged runtime package'
cmp -s "$staged" "$temporary/fixtures/ardent-1.0.0.tgz" || fail 'The staged runtime differs from the signed dependency'
jq -e '.name=="@hivemagnus/ardent" and .version=="1.0.0"' "$(dirname "$staged")/ardent-package.json" >/dev/null || fail 'Native package metadata is missing'
printf 'ARDENT_HOME=%s\n' "$temporary/native-home/.ardent-custom" >> "$agent/.env"
host magnus-agent-install "$(request 2.1.1)" || fail 'repair with native settings failed'

# A failed native terminal authority check neither pauses profiles nor prints credentials.
: > "$log"; touch "$temporary/fail-terminal-preflight"
terminal_request=$(request 2.1.1 | jq --arg script "$(base64 -w0 "$ROOT/scripts/suite/terminal-authority.mjs")" '.terminalRouteScript=$script')
if host magnus-agent-terminal-preflight "$terminal_request"; then fail 'Unavailable terminal authority was accepted'; fi
grep -q 'terminal authority preflight failed' "$temporary/err" || fail 'Terminal route refusal is unclear'
[[ ! -e "$agent/enrollment-maintenance.json" ]] || fail 'The preflight changed profile maintenance state'
! /usr/bin/grep -q '^systemctl .*stop' "$log" || fail 'The failed preflight stopped a profile'
no_secret "$log" "$temporary/out" "$temporary/err"
rm "$temporary/fail-terminal-preflight"

# Repeating changes nothing; a new version upgrades in place; a lost service is repaired.
: > "$log"
host magnus-agent-install "$(request 2.1.1)" || fail 'repeat failed'
jq -e '.changed==false' "$temporary/out" >/dev/null || fail 'A repeat reported a change'
grep -qx "ARDENT_HOME=$temporary/native-home/.ardent-custom" "$agent/.env" || fail 'A repair discarded the native runtime configuration'
! /usr/bin/grep -q '^npm ' "$log" && ! /usr/bin/grep -q 'install-service' "$log" && ! /usr/bin/grep -q 'systemctl restart' "$log" || fail 'A repeat reinstalled or restarted'
cp "$agent/.env" "$temporary/environment.before"
sed -i 's/^ARDENT_OWNER_USER=.*/ARDENT_OWNER_USER=root/' "$agent/.env"
if host magnus-agent-install "$(request 2.1.1)"; then fail 'Accepted root as the native runtime owner'; fi
grep -q 'non-root owner' "$temporary/err" || fail 'Root runtime ownership refusal is unclear'
cp "$temporary/environment.before" "$agent/.env"
cp "$agent.native-owner.json" "$temporary/owner.before"
jq '.uid=9876' "$temporary/owner.before" > "$agent.native-owner.json"
if host magnus-agent-install "$(request 2.1.1)"; then fail 'Accepted a replaced native owner identity'; fi
grep -q 'owner UID changed' "$temporary/err" || fail 'Replaced native owner identity refusal is unclear'
if host magnus-agent-ardent-review "$(request 2.1.1)"; then fail 'Reviewed a replaced native owner identity'; fi
grep -q 'identity differs from its completed installation record' "$temporary/err" || fail 'Enrollment owner identity refusal is unclear'
cp "$temporary/owner.before" "$agent.native-owner.json"
printf 'changed\n' > "$staged"
if host magnus-agent-install "$(request 2.1.1)"; then fail 'Accepted a changed staged runtime'; fi
grep -q 'staged Ardent package changed' "$temporary/err" || fail 'Changed native artifact refusal is unclear'
cp "$temporary/fixtures/ardent-1.0.0.tgz" "$staged"
touch "$temporary/fail-ci"
if host magnus-agent-install "$(request 2.1.2)"; then fail 'Accepted a failed locked install'; fi
grep -q 'npm EINTEGRITY' "$temporary/err" || fail 'The dependency error code was hidden'
! grep -q 'private diagnostic' "$temporary/err" || fail 'Raw npm diagnostics were exposed'
[[ $(readlink "$agent/current") == versions/2.1.1 ]] || fail 'A failed locked install switched the active agent'
rm "$temporary/fail-ci"
host magnus-agent-install "$(request 2.1.2)" || { cat "$temporary/err" >&2; fail 'upgrade failed'; }
[[ $(readlink "$agent/current") == versions/2.1.2 && $(jq -r .version "$temporary/out") == 2.1.2 ]] || fail 'The upgrade did not switch versions'
rm -f "$temporary/active"; : > "$log"
host magnus-agent-install "$(request 2.1.2)" || fail 'repair failed'
/usr/bin/grep -q 'systemctl restart' "$log" || fail 'A stopped service was not restarted'

# Full enrollment explicitly repairs disabled supervision and configures its selected terminal
# identity; an ordinary repair preserves an operator's disabled supervisor.
printf 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED=false\n' >> "$agent/.env"
host magnus-agent-install "$(request 2.1.2 | jq -c '.terminalUser="terminal-fixture"')" || fail 'ordinary repair failed'
grep -qx 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED=false' "$agent/.env" || fail 'Ordinary repair enabled disabled supervision'
! grep -q '^MAGNUS_AGENT_MANAGED_TERMINAL_USER=' "$agent/.env" || fail 'Disabled supervision configured a terminal'
host magnus-agent-install "$(request 2.1.2 | jq -c '.terminalUser="terminal-fixture" | .enableSupervisor=true')" || fail 'Full enrollment runtime setup failed'
grep -qx 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED=true' "$agent/.env" || fail 'Full enrollment did not enable supervision'
grep -qx 'MAGNUS_AGENT_MANAGED_TERMINAL_USER=terminal-fixture' "$agent/.env" || fail 'Full enrollment did not configure its terminal identity'
host magnus-agent-install "$(request 2.1.2)" || fail 'Managed terminal repair failed'
grep -qx 'MAGNUS_AGENT_MANAGED_TERMINAL_USER=terminal-fixture' "$agent/.env" || fail 'A repair discarded the managed terminal identity'

# Credentials for another host arrive in the request, never as an argument.
host magnus-agent-install "$(request 2.1.2 | jq -c 'del(.magnusEnvironment)')" && fail 'Installed without credentials' || true
grep -q 'credentials are missing' "$temporary/err" || fail 'Missing credentials were not refused'
/usr/bin/jq -nc --arg action magnus-agent-install --argjson request "$(request 2.1.2 | jq -c 'del(.magnusEnvironment)')" --arg node "${node_secret}x" --arg result "${result_secret}x" \
  '{action:$action,magnusAgent:$request,secret:{NODE_MANAGER_SECRET:$node,RESULT_SIGNING_SECRET:$result}}' | bash "$ROOT/scripts/suite/magnus-agent-host.sh" > "$temporary/out" 2>&1 || fail 'A remote-style install failed'
/usr/bin/grep -qx "NODE_MANAGER_SECRET=${node_secret}x" "$agent/.env" || fail 'Credentials from the request were not written'
# A Magnus host without a reconciliation key (an older installation) gives the agent none.
! /usr/bin/grep -q '^COMMAND_RECONCILIATION_SECRET=' "$agent/.env" || fail 'An absent reconciliation key was written'
/usr/bin/jq -nc --arg action magnus-agent-install --argjson request "$(request 2.1.2 | jq -c 'del(.magnusEnvironment)')" --arg node "$node_secret" --arg result "$result_secret" --arg reconcile "$reconcile_secret" \
  '{action:$action,magnusAgent:$request,secret:{NODE_MANAGER_SECRET:$node,RESULT_SIGNING_SECRET:$result,COMMAND_RECONCILIATION_SECRET:$reconcile}}' | bash "$ROOT/scripts/suite/magnus-agent-host.sh" > "$temporary/out" 2>&1 || fail 'A remote-style install with a reconciliation key failed'
/usr/bin/grep -qx "COMMAND_RECONCILIATION_SECRET=$reconcile_secret" "$agent/.env" || fail 'The reconciliation key from the request was not written'
if /usr/bin/jq -nc --arg action magnus-agent-install --argjson request "$(request 2.1.2 | jq -c 'del(.magnusEnvironment)')" --arg node "$node_secret" --arg result "$result_secret" \
  '{action:$action,magnusAgent:$request,secret:{NODE_MANAGER_SECRET:$node,RESULT_SIGNING_SECRET:$result,COMMAND_RECONCILIATION_SECRET:"too-short"}}' | bash "$ROOT/scripts/suite/magnus-agent-host.sh" > "$temporary/out" 2>&1; then fail 'A short reconciliation key was accepted'; fi
grep -q 'shorter than 32 characters' "$temporary/out" || fail 'The short reconciliation key refusal is unclear'
/usr/bin/grep -qx "COMMAND_RECONCILIATION_SECRET=$reconcile_secret" "$agent/.env" || fail 'A refused key replaced the agent environment'
# The Magnus host hands over all three node credentials for an agent on another host.
host magnus-agent-secrets "$(jq -nc --arg env "$temporary/magnus.env" '{magnusEnvironment:$env}')" || fail 'Reading the node credentials failed'
/usr/bin/jq -e --arg node "$node_secret" --arg result "$result_secret" --arg reconcile "$reconcile_secret" '.=={NODE_MANAGER_SECRET:$node,RESULT_SIGNING_SECRET:$result,COMMAND_RECONCILIATION_SECRET:$reconcile}' "$temporary/out" >/dev/null || fail 'The node credentials are incomplete'
: > "$temporary/out"
no_secret "$temporary/out"

host magnus-agent-host-key '{}' && [[ $(jq -r .fingerprint "$temporary/out") == SHA256:* ]] || fail 'The host key fingerprint was not read'
host magnus-agent-remove "$(jq -nc --arg root "$agent" '{root:$root}')" || fail 'remove failed'
[[ ! -e "$agent" && ! -e "$MAGNUS_AGENT_UNIT" ]] || fail 'remove left the agent behind'
[[ -f "$agent.native-owner.json" ]] || fail 'Removal orphaned the account that owns native profiles'
/usr/bin/grep -q 'systemctl disable --now magnus-agent' "$log" || fail 'remove did not stop the service'

# The controller: no agent port, no install; Node.js without consent, no install.
jq -n --arg dir "$temporary/install" '{schema:1,installation:"example-suite",origin:"https://hive.example.com",hosts:{control:{target:"local",directory:$dir}},
  components:{magnus:{host:"control"}},agents:[],inference:[],console:{host:"control"},bootstrap:{certificateFile:"/etc/hive/tls/console.crt",privateKeyFile:"/etc/hive/tls/console.key"}}' > "$temporary/config.json"
controller() { (
  export HIVE_ROOT=$ROOT; source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/magnus-gateway.sh"; source "$ROOT/scripts/suite/magnus-agent.sh"
  HIVE_CONFIG=$temporary/config.json HIVE_MANIFEST=$temporary/release.json HIVE_VERSION=9.9.9 HIVE_ID=example-suite
  HIVE_AGENT_TARGET=${HIVE_AGENT_TARGET:-} HIVE_AGENT_SSH_CONFIG='' HIVE_AGENT_SUDO_FILE='' HIVE_AGENT_INSTALL_NODE=false HIVE_AGENT_TRUST=${HIVE_AGENT_TRUST:-false} HIVE_CONFIRMED=true
  hive_magnus_agent "$@"
) < /dev/null > "$temporary/controller.log" 2>&1; }
jq -n '{components:{magnus:{agentPackage:{name:"@hivemagnus/magnus-agent",version:"2.1.1",integrity:("sha512-"+("A"*86)+"==")}}}}' > "$temporary/release.json"
if controller install; then fail 'Installed without an agent port'; fi
grep -q 'publishes no Magnus agent port' "$temporary/controller.log" || fail 'The missing agent port refusal is unclear'
jq '.console.nativeListeners=[{port:4000,component:"magnus"}]' "$temporary/config.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/config.json"
rm -f "$temporary/node-version"
if controller install; then fail 'Installed without Node.js'; fi
grep -q "Node.js was not installed. Install it yourself" "$temporary/controller.log" && grep -q 6F71F525282841EEDAF851B42F59B5F99B1BE0B4 "$temporary/controller.log" || { cat "$temporary/controller.log" >&2; fail "No manual alternative without consent"; }
jq 'del(.components.magnus.agentPackage)' "$temporary/release.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/release.json"; nodes v24.22.3
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
# With the web terminal gateway, the host key read on the host is approved; the gateway's audit
# record goes to an owner-only log, not the terminal, and remove --trust revokes it.
jq -n '{services:{"magnus-gateway":{}}}' > "$temporary/install/compose.json"
jq '.components["magnus-gateway"]={host:"control"}' "$temporary/config.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/config.json"
: > "$log"
HIVE_MAGNUS_AGENT_ROOT=$agent HIVE_AGENT_TARGET=fleet HIVE_AGENT_TRUST=true controller install || { cat "$temporary/controller.log" >&2; fail 'An install with approval failed'; }
/usr/bin/grep -q 'trust add --node-id node-1 --host node-1.example.com --fingerprint SHA256:.* --approved-by .* --approval-ref magnus-agent-install' "$log" || fail 'The host key was not approved with the gateway CLI'
/usr/bin/grep -q 'The web terminal can open sessions on this node' "$temporary/controller.log" || fail 'The approval was not reported'
fingerprint=$(sed -n 's/^Host key read on fleet: //p' "$temporary/controller.log")
! /usr/bin/grep -q '^{' "$temporary/controller.log" || fail 'A raw audit record reached the terminal'
[[ $(stat -c %a "$temporary/magnus-trust.log") == 600 ]] && /usr/bin/grep -q '^{' "$temporary/magnus-trust.log" || fail 'The audit record was not kept in the owner-only log'
# status is one JSON document, with the node's web terminal approval in it.
stub docker 'case "$*" in *"trust list"*) echo "{\"nodeId\":\"node-1\",\"host\":\"node-1.example.com\",\"port\":22,\"fingerprints\":[\"SHA256:example\"]}";;
  *) printf "{\"id\":\"node-1\",\"name\":\"node-1.example.com\",\"status\":\"ONLINE\",\"lastHeartbeatAt\":\"%s\"}\n" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)";; esac'
HIVE_MAGNUS_AGENT_ROOT=$agent HIVE_AGENT_TARGET=fleet controller status || { cat "$temporary/controller.log" >&2; fail 'status failed'; }
/usr/bin/jq -e '.service=="active" and .node.status=="ONLINE" and .webTerminalApproval.nodeId=="node-1"' "$temporary/controller.log" >/dev/null || { cat "$temporary/controller.log" >&2; fail 'status is not one JSON document with the approval'; }
# Run again unattended: nothing changes, the service keeps running, the approval is not repeated.
stub docker 'case "$*" in *"trust list"*) echo "{\"nodeId\":\"node-1\",\"host\":\"node-1.example.com\",\"port\":22,\"fingerprints\":[\"'"$fingerprint"'\"]}";;
  *) printf "{\"id\":\"node-1\",\"name\":\"node-1.example.com\",\"status\":\"ONLINE\",\"lastHeartbeatAt\":\"%s\"}\n" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)";; esac'
: > "$log"
HIVE_MAGNUS_AGENT_ROOT=$agent HIVE_AGENT_TARGET=fleet controller install || { cat "$temporary/controller.log" >&2; fail 'A repeated install failed'; }
! /usr/bin/grep -q 'systemctl restart\|trust add' "$log" || fail 'A repeated install restarted the service or approved again'
/usr/bin/grep -q 'already up to date and left running' "$temporary/controller.log" && /usr/bin/grep -q 'approval of this host key is already in place' "$temporary/controller.log" || { cat "$temporary/controller.log" >&2; fail 'A repeated install did not say nothing changed'; }
: > "$log"
HIVE_MAGNUS_AGENT_ROOT=$agent HIVE_AGENT_TARGET=fleet HIVE_AGENT_TRUST=true controller remove || { cat "$temporary/controller.log" >&2; fail 'remove with --trust failed'; }
/usr/bin/grep -q 'trust remove --node-id node-1 --approved-by .* --approval-ref magnus-agent-remove' "$log" || fail 'The approval was not revoked with the gateway CLI arguments'
[[ ! -e "$agent" ]] || fail 'remove kept the agent'
printf 'Passed: Magnus agent Node.js range and NodeSource key, pinned package integrity, root-only credentials never in arguments or output, idempotent repair and upgrade, removal with revocation, the web terminal approval kept out of the terminal, and controller refusals.\n'
