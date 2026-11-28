#!/usr/bin/env bash
# uninstall --purge after the installer set up the Magnus host agent and Ardent, then a reinstall
# on the same host: the agent, its staged packages, the native account and the Ardent setup
# receipts go when the ownership record names this installation (profiles only with
# --delete-agent-profiles), so the next install and Ardent setup start clean. An agent, account or
# record that Hive cannot prove this installation created (a fleet agent, an earlier release's
# record, another installation's) is left untouched and reported. Stubbed systemd, accounts,
# npm, Node.js and Docker; the real controller and host scripts.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
bin="$temporary/bin"; mkdir -p "$bin"
log="$temporary/calls"; : > "$log"
stub() { printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "%s" "$*" >> "%s"\n%s\n' "$1" "$log" "$2" > "$bin/$1"; chmod +x "$bin/$1"; }
home="$temporary/home/hive-agent"
# The installer's account: it exists while the marker file does, with UID 1234 and its own home.
stub id 'case "$*" in -u) echo 0;; "-u hive-agent") echo 1234;; "-nG hive-agent") echo hive-agent;; hive-agent) [[ -f "'"$temporary"'/account" ]];;
  "-u fleet-owner") echo 2345;; "-nG fleet-owner") echo fleet-owner;; fleet-owner) exit 0;; *) exec /usr/bin/id "$@";; esac'
stub useradd 'touch "'"$temporary"'/account"; mkdir -p "'"$home"'"'
stub userdel 'rm -f "'"$temporary"'/account"'
stub groupdel 'exit 0'
stub getent 'case "$1 $2" in "passwd hive-agent") printf "hive-agent:x:1234:1234:Hive agent runtimes:%s:/bin/bash\n" "'"$home"'";; "group hive-agent") echo "hive-agent:x:1234:";;
  "passwd fleet-owner") printf "fleet-owner:x:2345:2345::%s:/bin/bash\n" "'"$temporary"'/home/fleet-owner";; *) exit 2;; esac'
stub stat 'if [[ "$1 $2" == "-c %u" && "${@: -1}" == "'"$home"'" ]]; then echo 1234; else exec /usr/bin/stat "$@"; fi'
stub loginctl 'exit 0'
stub pkill 'exit 0'
stub systemctl 'case "$1" in is-active) [[ -f "'"$temporary"'/active" ]] && echo active || echo inactive;; restart) touch "'"$temporary"'/active";; disable) rm -f "'"$temporary"'/active";; esac; exit 0'
stub ss 'exit 0'
stub crontab 'echo "no crontab" >&2; exit 1'
stub docker 'case "$*" in *" ps "*) printf "[]\n";; esac; exit 0'
stub npm 'case "$1" in
  pack) spec=${@: -1}; name=magnus-agent; [[ "$spec" != @hivemagnus/ardent@* ]] || name=ardent; cp "'"$temporary"'/fixtures/$name.tgz" "$name.tgz"; echo "$name.tgz";;
  ci) exit 0;; *) exit 97;; esac'
stub node 'if [[ "$1" == --version ]]; then echo v24.22.3; exit; fi
case "$2" in
  --help) echo "Usage:";;
  check) [[ -f "$4" ]];;
  install-service) dir=$4 unit=$6; v=$(jq -r .version "$dir/node_modules/@hivemagnus/magnus-agent/package.json")
    mkdir -p "$dir/versions/$v"; mv "$dir/node_modules" "$dir/versions/$v/"; ln -s "versions/$v" "$dir/current"; ln -s current/node_modules "$dir/node_modules"
    printf "[Service]\nWorkingDirectory=%s\n" "$dir" > "$unit";;
esac'
export PATH="$bin:$PATH" XDG_STATE_HOME="$temporary/state"
agent="$temporary/opt/magnus-agent"; mkdir -p "$temporary/opt"
export MAGNUS_AGENT_UNIT="$temporary/magnus-agent.service" HIVE_MAGNUS_AGENT_ROOT=$agent

# A locked agent package that pins an Ardent package, as the signed release does.
mkdir -p "$temporary/fixtures" "$temporary/ardent/package" "$temporary/agent/package/dist"
printf '{"name":"@hivemagnus/ardent","version":"1.0.0"}\n' > "$temporary/ardent/package/package.json"
tar -czf "$temporary/fixtures/ardent.tgz" -C "$temporary/ardent" package
ardent_integrity="sha512-$(openssl dgst -sha512 -binary "$temporary/fixtures/ardent.tgz" | base64 -w0)"
jq -n '{name:"@hivemagnus/magnus-agent",version:"2.1.1",dependencies:{"@hivemagnus/ardent":"1.0.0"}}' > "$temporary/agent/package/package.json"
jq -n --arg integrity "$ardent_integrity" --slurpfile package "$temporary/agent/package/package.json" \
  '{name:$package[0].name,version:$package[0].version,lockfileVersion:3,packages:{"":$package[0],"node_modules/@hivemagnus/ardent":{version:"1.0.0",resolved:"https://registry.npmjs.org/@hivemagnus/ardent/-/ardent-1.0.0.tgz",integrity:$integrity}}}' > "$temporary/agent/package/npm-shrinkwrap.json"
touch "$temporary/agent/package/dist/index.js"
tar -czf "$temporary/fixtures/magnus-agent.tgz" -C "$temporary/agent" package
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj /CN=hive.example.com -addext subjectAltName=DNS:hive.example.com \
  -keyout "$temporary/console.key" -out "$temporary/console.crt" 2>/dev/null
printf 'NODE_MANAGER_SECRET=%s\nRESULT_SIGNING_SECRET=%s\n' "obviously-fake-node-secret-$(printf 'n%.0s' {1..20})" "obviously-fake-result-secret-$(printf 'r%.0s' {1..20})" > "$temporary/magnus.env"

host() { # ACTION REQUEST [INSTALLATION]
  jq -nc --arg action "$1" --argjson request "$2" --arg installation "${3-purge-proof}" '{action:$action,magnusAgent:$request}+(if $installation!="" then {installation:$installation} else {} end)' |
    bash "$ROOT/scripts/suite/magnus-agent-host.sh" > "$temporary/out" 2> "$temporary/err"
}
install_request() {
  jq -nc --arg root "$agent" --arg integrity "sha512-$(openssl dgst -sha512 -binary "$temporary/fixtures/magnus-agent.tgz" | base64 -w0)" --arg env "$temporary/magnus.env" --arg cert "$temporary/console.crt" --arg key "$temporary/console.key" \
    '{root:$root,package:{name:"@hivemagnus/magnus-agent",version:"2.1.1",integrity:$integrity},controlApiUrl:"https://hive.example.com:4000",hostFqdn:"hive.example.com",certificate:{certificate:$cert,key:$key,renewal:"console"},magnusEnvironment:$env}'
}
remove_request() { jq -nc --arg root "$agent" --argjson profiles "${1:-false}" '{root:$root,deleteProfiles:$profiles}'; }

# One installation, as setup leaves it: its directory, its file, the agent the installer set up
# and the Ardent setup receipt of the default profile, whose profile lives in the agent account.
directory="$temporary/install"
config_directory="$temporary/config/purge-proof"; config="$config_directory/installation.json"
installation() {
  rm -rf -- "$directory"; mkdir -p "$directory/data/magnus" "$config_directory"
  printf '{"installation":"purge-proof","host":"control","uuid":"synthetic"}' > "$directory/installation.json"
  printf '{"services":{"magnus":{}}}' > "$directory/compose.json"
  printf '{"phase":"complete"}\n' > "$directory/transaction.json"
  jq -n --arg dir "$directory" '{schema:1,installation:"purge-proof",release:"0.1.0",origin:"https://hive.example.com",hosts:{control:{target:"local",directory:$dir}},
    components:{magnus:{host:"control"}},console:{host:"control",nativeListeners:[{component:"magnus",port:4000}]},agents:[],inference:[]}' > "$config"
  [[ "$1" == without-agent ]] || host magnus-agent-install "$(install_request)" || { cat "$temporary/err" >&2; fail "The agent could not be installed ($1)"; }
}
ardent_setup() { # NODE
  mkdir -p "$home/.ardent/profiles/assistant" "$home/.config/systemd/user"
  printf '[Unit]\n' > "$home/.config/systemd/user/ardent@assistant.service"
  install -d -m 700 "$config_directory/ardent-setup"
  jq -n --arg node "$1" '{schema:1,installation:"purge-proof",nodeId:$node,profile:"assistant",phase:"complete"}' > "$config_directory/ardent-setup/assistant.json"
  : > "$config_directory/ardent-setup/assistant.lock"; chmod 600 "$config_directory/ardent-setup/"*
}
# The receipt check of ardent setup, for a new Magnus node of the same installation.
ardent_receipt_check() ( # NODE
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/ardent-setup.sh"
  HIVE_ARDENT_STATE_FILE=$config_directory/ardent-setup/assistant.json HIVE_ARDENT_NODE=$1 HIVE_ARDENT_PROFILE=assistant
  hive_ardent_load_state purge-proof
)
uninstall() { # PURGE DELETE_PROFILES
  (
    source "$ROOT/scripts/suite/controller.sh"
    for file in magnus-agent retention-schedule entry-point uninstall; do source "$ROOT/scripts/suite/$file.sh"; done
    HIVE_ROOT=$ROOT HIVE_CONFIG=$config HIVE_OPERATOR_CONFIG=$config HIVE_ID=purge-proof HIVE_VERSION=0.1.0 HIVE_CONFIRMED=true
    HIVE_UNINSTALL_PURGE=$1 HIVE_AGENT_DELETE_PROFILES=$2
    hive_uninstall
  ) > "$temporary/uninstall.log" 2>&1
}
account_exists() { [[ -f "$temporary/account" ]]; }

# 1. Install with the agent and Ardent. The record names the installation and the directory it created.
installation first
account_exists && grep -q '^useradd ' "$log" || fail 'The installer did not create the native account'
jq -e --arg root "$agent" --arg home "$home" '.installation=="purge-proof" and .phase=="complete" and .uid==1234 and .home==$home and .agentRoot==$root' "$agent.native-owner.json" >/dev/null ||
  { cat "$agent.native-owner.json" >&2; fail 'The ownership record does not name the installation and what it created'; }
[[ -d "$agent-artifacts" && -n $(ls -A "$agent-artifacts") ]] || fail 'No Ardent package was staged'
ardent_setup node-1
if ardent_receipt_check node-2 2> "$temporary/receipt.err"; then fail 'The receipt check accepted another node'; fi
grep -q 'belongs to a different installation or node' "$temporary/receipt.err" || fail 'The leftover receipt failure changed'

# 2. --purge without --delete-agent-profiles: the agent and its packages go, the account keeps its
#    profiles (and the record guarding it), and the Ardent setup receipts go.
printf 'purge-proof\n' | uninstall true false || { cat "$temporary/uninstall.log" >&2; fail 'The purge failed'; }
grep -q 'an account that holds Ardent profiles stays with them (--delete-agent-profiles deletes them)' "$temporary/uninstall.log" || { cat "$temporary/uninstall.log" >&2; fail 'The plan does not say the profiles stay'; }
[[ ! -e "$agent" && ! -e "$MAGNUS_AGENT_UNIT" && ! -e "$agent-artifacts" && ! -e "$directory" ]] || fail 'The purge left the agent, its packages or the directory'
account_exists && [[ -d "$home/.ardent/profiles/assistant" && -f "$agent.native-owner.json" ]] || fail 'The purge deleted profiles without --delete-agent-profiles'
jq -e '.agentRemovedAt|type=="string"' "$agent.native-owner.json" >/dev/null || fail 'The kept record does not say the agent was removed'
grep -q 'Kept the hive-agent account and its home .*: it holds 2 Ardent profile entries' "$temporary/uninstall.log" || { cat "$temporary/uninstall.log" >&2; fail 'The kept profiles were not reported'; }
[[ ! -e "$config_directory" ]] || { ls -la "$config_directory" >&2; fail 'The purge kept the Ardent setup receipts or the installation directory beside the file'; }
! grep -q '^userdel ' "$log" || fail 'The account was deleted with its profiles'

# 3. Reinstall: the same account and its profiles are taken over by the same installation, and
#    Ardent setup starts without a receipt from the old Magnus.
: > "$log"
installation second
! grep -q '^useradd ' "$log" || fail 'The reinstall created a second account'
jq -e --arg root "$agent" '.agentRoot==$root and (has("agentRemovedAt")|not)' "$agent.native-owner.json" >/dev/null || fail 'The reinstall did not record the agent directory again'
ardent_receipt_check node-2 || fail 'Ardent setup refused the reinstall'

# 4. --purge --delete-agent-profiles: everything this installation created goes.
ardent_setup node-2
printf 'purge-proof\n' | uninstall true true || { cat "$temporary/uninstall.log" >&2; fail 'The purge with --delete-agent-profiles failed'; }
grep -q 'the account goes with its home and every Ardent profile in it' "$temporary/uninstall.log" || fail 'The plan does not say the profiles are deleted'
! account_exists && [[ ! -e "$home" && ! -e "$agent.native-owner.json" && ! -e "$agent" && ! -e "$agent-artifacts" && ! -e "$MAGNUS_AGENT_UNIT" ]] ||
  { cat "$temporary/uninstall.log" >&2; ls -la "$temporary/opt" >&2; fail 'The purge left something the installation created'; }
grep -q '^userdel hive-agent$' "$log" && grep -q '^loginctl disable-linger hive-agent$' "$log" && grep -q '^systemctl stop user@1234.service$' "$log" || fail 'The account was not stopped and deleted'
grep -q 'Removed the ownership record' "$temporary/uninstall.log" || fail 'The removed record was not reported'
[[ ! -e "$config_directory" ]] || fail 'The purge kept the receipts beside the file'

# 5. Reinstall from nothing: a new account and record, as on a fresh host.
: > "$log"
installation third
account_exists && grep -q '^useradd ' "$log" || fail 'The reinstall did not create the account again'
jq -e '.installation=="purge-proof" and .phase=="complete"' "$agent.native-owner.json" >/dev/null || fail 'The reinstall has no ownership record'

# 6. uninstall without --purge keeps data: an account without profiles is no data, so it goes
#    with the agent; one with profiles stays.
uninstall false false < /dev/null || { cat "$temporary/uninstall.log" >&2; fail 'uninstall failed'; }
! account_exists && [[ ! -e "$agent" && ! -e "$agent.native-owner.json" && -d "$directory/data/magnus" ]] || fail 'uninstall left the agent, or deleted the data'
installation fourth
ardent_setup node-3
uninstall false false < /dev/null || { cat "$temporary/uninstall.log" >&2; fail 'uninstall with profiles failed'; }
account_exists && [[ -d "$home/.ardent/profiles/assistant" && -f "$config_directory/ardent-setup/assistant.json" && ! -e "$agent" ]] || fail 'uninstall without --purge deleted profiles or receipts'
printf 'purge-proof\n' | uninstall true true || { cat "$temporary/uninstall.log" >&2; fail 'The final purge failed'; }
! account_exists && [[ ! -e "$agent.native-owner.json" ]] || fail 'A purge after uninstall left the account'

# ---- What Hive did not create is never touched. ----
untouched() { # WHAT
  [[ -f "$agent/.env" && -f "$MAGNUS_AGENT_UNIT" && -d "$agent-artifacts" ]] || fail "$1: the agent, its unit or its packages were removed"
  ! grep -Eq '^(userdel|groupdel|pkill|systemctl disable|loginctl disable-linger)' "$log" || fail "$1: something was stopped or deleted"
}
foreign_agent() { # OWNER
  rm -rf -- "$agent" "$agent-artifacts" "$agent.native-owner.json"; mkdir -p "$agent" "$agent-artifacts/1.0.0-0123456789abcdef"
  printf 'ARDENT_OWNER_USER=%s\nCONTROL_API_URL=https://magnus.example.com:4000\n' "$1" > "$agent/.env"
  printf '[Service]\nWorkingDirectory=%s\n' "$agent" > "$MAGNUS_AGENT_UNIT"; : > "$log"
}
# A fleet agent installed by other tooling: no ownership record.
foreign_agent fleet-owner
host magnus-agent-remove "$(remove_request true)" || { cat "$temporary/err" >&2; fail 'remove of a fleet agent failed outright'; }
jq -e '(.removed|length)==0 and any(.kept[]; .code=="agent" and (.reason|test("no ownership record")))' "$temporary/out" >/dev/null || { cat "$temporary/out" >&2; fail 'The fleet agent was not reported as kept'; }
untouched 'A fleet agent'
# The controller fails, says what is left and where the manual steps are; a purge still finishes.
installation without-agent; foreign_agent fleet-owner
if printf 'purge-proof\n' | uninstall true true; then fail 'A purge beside a fleet agent reported success'; fi
grep -q 'Kept the Magnus agent at .*no ownership record' "$temporary/uninstall.log" && grep -q 'deployment/README.md#uninstalling' "$temporary/uninstall.log" || { cat "$temporary/uninstall.log" >&2; fail 'The kept fleet agent was not explained'; }
[[ ! -e "$directory" ]] || fail 'The purge stopped at the fleet agent'
untouched 'A fleet agent during a purge'
# A record from an earlier release names no installation: Hive cannot prove it, so it stays.
foreign_agent hive-agent; touch "$temporary/account"
jq -n '{schema:1,username:"hive-agent",phase:"complete",uid:1234}' > "$agent.native-owner.json"; chmod 600 "$agent.native-owner.json"
host magnus-agent-remove "$(remove_request true)" || fail 'remove beside an earlier record failed outright'
jq -e 'any(.kept[]; .code=="agent" and (.reason|test("names no installation"))) and any(.kept[]; .code=="record")' "$temporary/out" >/dev/null || { cat "$temporary/out" >&2; fail 'The earlier record was not reported'; }
untouched 'An earlier release'"'"'s agent'
account_exists && [[ -f "$agent.native-owner.json" ]] || fail 'The account of an earlier release was deleted'
# A request without an installation (an older controller) proves nothing either.
host magnus-agent-remove "$(remove_request true)" '' || fail 'remove without an installation failed outright'
untouched 'A request without an installation'
# Another installation's record: its agent, account and record stay, and an install refuses its account.
jq '.installation="other-suite" | .agentRoot=$root' --arg root "$agent" <<< '{"schema":1,"username":"hive-agent","phase":"complete","uid":1234}' > "$agent.native-owner.json"
host magnus-agent-remove "$(remove_request true)" || fail 'remove beside another installation failed outright'
jq -e 'any(.kept[]; .code=="agent" and (.reason|test("names Hive installation other-suite")))' "$temporary/out" >/dev/null || { cat "$temporary/out" >&2; fail 'Another installation'"'"'s agent was not reported'; }
untouched 'Another installation'"'"'s agent'
rm -rf -- "$agent" "$MAGNUS_AGENT_UNIT"
if host magnus-agent-install "$(install_request)"; then fail 'An install took over another installation'"'"'s account'; fi
grep -q 'belongs to Hive installation other-suite' "$temporary/err" || { cat "$temporary/err" >&2; fail 'The refusal of another installation'"'"'s account is unclear'; }
# Our record, but the agent directory was there before the installer (it repaired an existing
# agent): the agent stays, and so does the account it uses.
foreign_agent hive-agent; touch "$temporary/account"; mkdir -p "$home"
jq -n --arg home "$home" '{schema:1,username:"hive-agent",phase:"complete",uid:1234,installation:"purge-proof",home:$home}' > "$agent.native-owner.json"; chmod 600 "$agent.native-owner.json"
host magnus-agent-remove "$(remove_request true)" || fail 'remove of a repaired agent failed outright'
jq -e 'any(.kept[]; .code=="agent") and any(.kept[]; .code=="account" and (.reason|test("still uses it")))' "$temporary/out" >/dev/null || { cat "$temporary/out" >&2; fail 'The repaired agent or its account was not kept'; }
untouched 'A repaired agent'
# Our account and our agent, but another agent on this host names the account: the account stays.
jq --arg root "$agent" --arg inode "$(stat -c %d:%i -- "$agent")" '.agentRoot=$root | .agentRootCreated=true | .agentRootInode=$inode' "$agent.native-owner.json" > "$temporary/next.json"; mv "$temporary/next.json" "$agent.native-owner.json"
mkdir -p "$temporary/opt/second-agent"; printf 'ARDENT_OWNER_USER=hive-agent\n' > "$temporary/opt/second-agent/.env"
host magnus-agent-remove "$(remove_request true)" || fail 'remove beside a second agent failed outright'
jq -e 'any(.kept[]; .code=="account" and (.reason|test("second-agent/.env names it too")))' "$temporary/out" >/dev/null || { cat "$temporary/out" >&2; fail 'An account another agent names was not kept'; }
account_exists && [[ ! -e "$agent" && -f "$agent.native-owner.json" ]] || fail 'The account another agent names was deleted, or our agent was kept'
! grep -q '^userdel ' "$log" || fail 'userdel ran for an account another agent names'
# ---- A directory that existed before the installer stays the operator's. ----
fresh_host() { rm -rf -- "$agent" "$agent-artifacts" "$agent.native-owner.json" "$agent.hive-creating.json" "$MAGNUS_AGENT_UNIT" "$temporary/opt/second-agent" "$home"; rm -f "$temporary/account"; }
fresh_host
# A directory that already holds files: the install uses it but never records it as its own,
# and neither uninstall --purge --delete-agent-profiles nor magnus-agent remove deletes the file.
mkdir -p "$agent"; printf 'operator data\n' > "$agent/unrelated.txt"
installation preexisting
jq -e --arg root "$agent" '(.agentRoot // "") != $root and (has("agentRootCreated")|not)' "$agent.native-owner.json" >/dev/null ||
  { cat "$agent.native-owner.json" >&2; fail 'The install claimed a directory that already held files'; }
[[ ! -e "$agent.hive-creating.json" ]] || fail 'The install wrote a creation note for a directory it did not make'
printf 'purge-proof\n' | uninstall true true || true
[[ -f "$agent/unrelated.txt" && $(cat "$agent/unrelated.txt") == 'operator data' ]] || { cat "$temporary/uninstall.log" >&2; fail 'uninstall --purge deleted a file in a directory the installer did not create'; }
grep -q 'Kept the Magnus agent at' "$temporary/uninstall.log" || { cat "$temporary/uninstall.log" >&2; fail 'The kept pre-existing directory was not reported'; }
host magnus-agent-remove "$(remove_request true)" || fail 'remove beside a pre-existing directory failed outright'
[[ -f "$agent/unrelated.txt" ]] || fail 'magnus-agent remove deleted a file in a directory the installer did not create'
# An empty directory that was there before is not the installer's either.
fresh_host; mkdir -p "$agent"
installation empty-preexisting
jq -e --arg root "$agent" '(.agentRoot // "") != $root' "$agent.native-owner.json" >/dev/null || fail 'The install claimed an empty directory it did not make'
# A record an earlier release wrote, naming the directory without proof that it was created:
# removal keeps the directory and says why.
jq --arg root "$agent" '.agentRoot=$root' "$agent.native-owner.json" > "$temporary/next.json"; mv "$temporary/next.json" "$agent.native-owner.json"
printf 'operator data\n' > "$agent/unrelated.txt"
host magnus-agent-remove "$(remove_request true)" || fail 'remove beside an unproven claim failed outright'
jq -e 'any(.kept[]; .code=="agent" and (.reason|test("3.15.2 or earlier")))' "$temporary/out" >/dev/null || { cat "$temporary/out" >&2; fail 'An unproven earlier claim was not reported'; }
[[ -f "$agent/unrelated.txt" ]] || fail 'remove trusted an unproven earlier claim'
# An install that stopped after making the directory (its certificate already in it), before
# claiming it: the rerun still claims that directory, and removal then deletes it.
fresh_host; mkdir -p "$agent/certs"; : > "$agent/certs/agent.crt"
jq -n --arg root "$agent" --arg inode "$(stat -c %d:%i -- "$agent")" '{schema:1,installation:"purge-proof",root:$root,inode:$inode}' > "$agent.hive-creating.json"
installation resumed
jq -e --arg root "$agent" '.agentRoot==$root and .agentRootCreated==true' "$agent.native-owner.json" >/dev/null || { cat "$agent.native-owner.json" >&2; fail 'The rerun did not claim the directory its interrupted install made'; }
[[ ! -e "$agent.hive-creating.json" ]] || fail 'The creation note was kept after the claim'
host magnus-agent-remove "$(remove_request true)" || fail 'remove of a resumed install failed outright'
[[ ! -e "$agent" ]] || fail 'remove kept a directory this installation created'
# A directory the installer created, then replaced at the same path (another device or inode):
# neither magnus-agent remove nor uninstall --purge deletes the replacement or what it holds.
fresh_host
installation replaced-later
jq -e --arg root "$agent" --arg inode "$(stat -c %d:%i -- "$agent")" '.agentRoot==$root and .agentRootCreated==true and .agentRootInode==$inode' "$agent.native-owner.json" >/dev/null ||
  { cat "$agent.native-owner.json" >&2; fail 'The claim does not record the device and inode of the directory created'; }
mv -T -- "$agent" "$temporary/created-agent"; mkdir -p "$agent"; printf 'operator data\n' > "$agent/unrelated.txt"
[[ $(stat -c %d:%i -- "$agent") != $(jq -r .agentRootInode "$agent.native-owner.json") ]] || fail 'The replacement directory reused the inode; the test proves nothing'
host magnus-agent-remove "$(remove_request true)" || fail 'remove beside a replaced directory failed outright'
jq -e 'any(.kept[]; .code=="agent" and (.reason|test("device and inode")))' "$temporary/out" >/dev/null || { cat "$temporary/out" >&2; fail 'A replaced directory was not kept with its reason'; }
[[ -f "$agent/unrelated.txt" ]] || fail 'magnus-agent remove deleted a directory made again after the install'
printf 'purge-proof\n' | uninstall true true || true
[[ -f "$agent/unrelated.txt" && $(cat "$agent/unrelated.txt") == 'operator data' ]] || { cat "$temporary/uninstall.log" >&2; fail 'uninstall --purge deleted a directory made again after the install'; }
grep -q 'Kept the Magnus agent at' "$temporary/uninstall.log" || { cat "$temporary/uninstall.log" >&2; fail 'The kept replacement directory was not reported'; }
rm -rf -- "$temporary/created-agent"
# A note for a directory made again in its place (another inode), or another installation's
# note, proves nothing.
fresh_host; mkdir -p "$agent"; printf 'x\n' > "$agent/unrelated.txt"
jq -n --arg root "$agent" '{schema:1,installation:"purge-proof",root:$root,inode:"0:0"}' > "$agent.hive-creating.json"
installation replaced-directory
jq -e --arg root "$agent" '(.agentRoot // "") != $root' "$agent.native-owner.json" >/dev/null || fail 'A note for another directory let the install claim this one'
fresh_host; mkdir -p "$agent"; printf 'x\n' > "$agent/unrelated.txt"
jq -n --arg root "$agent" --arg inode "$(stat -c %d:%i -- "$agent")" '{schema:1,installation:"other-suite",root:$root,inode:$inode}' > "$agent.hive-creating.json"
installation foreign-note
jq -e --arg root "$agent" '(.agentRoot // "") != $root' "$agent.native-owner.json" >/dev/null || fail 'Another installation'"'"'s creation note let the install claim the directory'
[[ -f "$agent/unrelated.txt" ]] || fail 'A foreign note cost a file'

printf 'Passed: a directory the installer did not make (with files, empty, claimed by an earlier release, noted for another directory or installation, or made again in place of the one created) is never deleted, and an interrupted install still claims its own; uninstall --purge removes the agent, its staged packages, the Ardent setup receipts and (with --delete-agent-profiles, or without profiles) the native account and its record that this installation created; reinstall and Ardent setup then succeed; fleet agents, earlier releases'"'"' records, other installations'"'"' accounts and shared accounts are left untouched and reported.\n'
