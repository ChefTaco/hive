#!/usr/bin/env bash
# The setup checklist on the controller: which items each configuration and operation records,
# how recorded statuses carry over, which registries receive it, and hive.sh setup. No container
# is started; the registry client is a recorder.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
export HIVE_ROOT=$ROOT
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/registry.sh"
source "$ROOT/scripts/suite/setup-checklist.sh"

core=$temporary/core.json full=$temporary/full.json
jq . "$ROOT/examples/installation.json" > "$core"
jq '.profile="full" | .components.magnus={host:"control"} | .console.nativeListeners=[{component:"magnus",port:4100}]' "$core" > "$full"
items() { # CONFIG OPERATION [PREVIOUS] [PREVIOUS_RELEASE] [CERTIFICATE]
  HIVE_CONFIG=$1 HIVE_VERSION=${HIVE_VERSION:-3.6.0} hive_checklist_items "$2" "${3:-null}" "${4:-}" "${5:-false}"
}
ids() { items "$@" | jq -c 'map([.id,.status])'; }
expect() { # ACTUAL EXPECTED MESSAGE
  [[ "$1" == "$2" ]] || fail "$3: expected $2, got $1"
}

# Fresh installs: the steps fresh setup leaves to a person. Bootstrap seeds the browser clients
# and there are no Ardent packages yet, so neither is listed.
expect "$(ids "$core" install)" '[["certificate-renewal","pending"],["first-admin","pending"]]' 'Core install'
expect "$(ids "$full" install)" '[["magnus-agent-enrolled","pending"],["certificate-renewal","pending"],["first-admin","pending"]]' 'Full install'
expect "$(ids "$full" install null '' true)" '[["magnus-agent-enrolled","pending"],["certificate-renewal","done"],["first-admin","pending"]]' 'A scheduled renewal is found done'
# Magnus without a host agent port cannot run the agent command, so it is not listed.
jq 'del(.console.nativeListeners)' "$full" > "$temporary/no-port.json"
expect "$(ids "$temporary/no-port.json" install)" '[["certificate-renewal","pending"],["first-admin","pending"]]' 'Magnus without an agent port'
# A console on another host: the controller cannot see a renewal timer there, and does not list it.
jq '.hosts.control.target="deploy@console.example.com"' "$full" > "$temporary/remote.json"
expect "$(ids "$temporary/remote.json" install)" '[["magnus-agent-enrolled","pending"],["first-admin","pending"]]' 'Remote console host'
# Without fresh setup there is no initial operator and no certificate the installer copied.
jq 'del(.bootstrap)' "$full" > "$temporary/adopted.json"
expect "$(ids "$temporary/adopted.json" install)" '[["magnus-agent-enrolled","pending"]]' 'Install without bootstrap'

# Upgrades: the release steps, recorded for the first time on a registry that had no checklist.
expect "$(ids "$full" upgrade)" '[["magnus-agent-enrolled","pending"],["oathweave-console-clients","pending"],["ardent-packages-updated","pending"],["certificate-renewal","pending"]]' 'Full upgrade'
expect "$(ids "$core" upgrade)" '[["certificate-renewal","pending"]]' 'Core upgrade'
jq 'del(.components.magnus,.console.nativeListeners) | .external={magnus:{url:"https://magnus.example.com:4000"}}' "$full" > "$temporary/external.json"
expect "$(ids "$temporary/external.json" upgrade)" '[["oathweave-console-clients","pending"],["ardent-packages-updated","pending"],["certificate-renewal","pending"]]' 'External Magnus upgrade'
jq '.bootstrap.magnusGateway={grantTerminalToInitialOperator:true}' "$full" > "$temporary/terminal.json"
expect "$(ids "$temporary/terminal.json" upgrade | jq -c 'map(.[0])')" '["magnus-agent-enrolled","ardent-packages-updated","certificate-renewal"]' 'Fresh setup owns the clients with the terminal grant'

# Recorded statuses carry over. A release item done for another release is due again; skipped
# stays skipped; installation items stay settled; items a newer controller recorded are kept;
# an item whose product left the configuration is dropped.
previous=$(items "$full" install | jq -c '(.[]|select(.id=="magnus-agent-enrolled")).status="done" | (.[]|select(.id=="first-admin")).status="done" | (.[]|select(.id=="certificate-renewal")).status="skipped" |
  .+[{id:"some-future-step",title:"A step a newer controller knows",status:"pending",command:"./hive.sh post-upgrade",docs:"README.md",check:"future.probe"}]')
upgraded=$(items "$full" upgrade "$previous" 3.5.0)
expect "$(jq -c 'map([.id,.status])' <<< "$upgraded")" '[["magnus-agent-enrolled","pending"],["oathweave-console-clients","pending"],["ardent-packages-updated","pending"],["certificate-renewal","skipped"],["first-admin","done"],["some-future-step","pending"]]' 'Upgrade to another release'
jq -e '.[-1]=={id:"some-future-step",title:"A step a newer controller knows",status:"pending",command:"./hive.sh post-upgrade",docs:"README.md",check:"future.probe"}' <<< "$upgraded" >/dev/null || fail 'An unknown item was changed'
# A retried upgrade (the registry already records the new release) keeps what was done since.
retried=$(jq -c 'map(if .id=="ardent-packages-updated" then .status="done" else . end)' <<< "$upgraded")
expect "$(items "$full" upgrade "$retried" 3.6.0 | jq -c 'map(select(.status=="done")|.id)')" '["ardent-packages-updated","first-admin"]' 'Retried upgrade'
# A pending renewal found scheduled since is done; a skipped one is left as the operator chose.
expect "$(items "$full" upgrade "$previous" 3.6.0 true | jq -r '.[]|select(.id=="certificate-renewal").status')" skipped 'A skipped renewal'
expect "$(items "$full" upgrade "$(items "$full" install)" 3.6.0 true | jq -r '.[]|select(.id=="certificate-renewal").status')" done 'A renewal scheduled since'
expect "$(items "$core" upgrade "$previous" 3.5.0 | jq -c 'map(.id)')" '["certificate-renewal","first-admin","some-future-step"]' 'Magnus left the configuration'

# Every item the controller can record passes the registry's rules, and every docs link resolves
# to a heading in this repository.
anchor() { sed -n 's/^#\{1,6\} //p' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 -]//g; s/ /-/g'; }
all=$(jq -s 'add|unique_by(.id)' <(items "$full" install) <(items "$full" upgrade))
expect "$(jq -c 'map(.id)|sort' <<< "$all")" '["ardent-packages-updated","certificate-renewal","first-admin","magnus-agent-enrolled","oathweave-console-clients"]' 'The fixed item ids'
while IFS=$'\t' read -r id title command docs product check; do
  [[ "$id" =~ ^[a-z][a-z0-9-]{0,63}$ && ${#title} -le 160 ]] || fail "$id: invalid id or title"
  [[ ${#command} -le 200 ]] && grep -Eq '^(sudo )?(\./)?(hive\.sh|scripts/[a-z][a-z0-9-]*\.sh)( [A-Za-z0-9_=:-]{1,64}){0,12}$' <<< "$command" || fail "$id: command '$command' is not a plain hive.sh line"
  [[ "$check" == '' || "$check" =~ ^[a-z][a-z0-9.-]{0,63}$ ]] || fail "$id: invalid check"
  [[ "$product" == '' ]] || jq -e --arg product "$product" '.components[$product]!=null' "$ROOT/releases/3.5.0.json" >/dev/null || fail "$id: unknown product $product"
  file=${docs%%#*} fragment=${docs#*#}
  [[ -f "$ROOT/$file" ]] || fail "$id: $file does not exist"
  [[ "$docs" != *'#'* ]] || anchor "$ROOT/$file" | grep -qx -- "$fragment" || fail "$id: $docs has no such heading"
done < <(jq -r '.[]|[.id,.title,.command,.docs,(.product // ""),(.check // "")]|@tsv' <<< "$all")
expect "$(jq -c '[.[]|select(.check)|[.id,.check]]' <<< "$all")" '[["first-admin","iam.first-admin"],["magnus-agent-enrolled","magnus.agent"],["oathweave-console-clients","oathweave.console-client"]]' 'Readiness checks'
printf 'Passed: checklist items per profile, configuration and operation, and carried statuses.\n'

# Only a registry from 1.3.0 receives the checklist, only an install or upgrade sends one, and a
# sync without it keeps what the registry recorded.
manifest() { jq -n --arg version "$1" '{components:{"hive-registry":{version:$version}}}' > "$temporary/manifest.json"; HIVE_MANIFEST=$temporary/manifest.json hive_checklist_supported; }
for version in 1.3.0 1.10.2 2.0.0 1.3.0-rc.1; do manifest "$version" || fail "Registry $version should record the checklist"; done
for version in 1.2.0 1.0.0 0.9.0 ''; do if manifest "$version"; then fail "Registry '$version' cannot record the checklist"; fi; done
manifest 1.3.0
reads=$temporary/reads
hive_registry_action() { printf '%s %s\n' "$2" "$3" >> "$reads"; [[ ! -e "$temporary/unavailable" ]] || return 1; cat "$temporary/recorded.json"; }
jq -n --argjson items "$previous" '{schema:1,id:"example-suite",release:{version:"3.5.0"},setup:{items:$items,updatedAt:"2026-11-01T00:00:00.000Z"}}' > "$temporary/recorded.json"
prepare() { HIVE_CONFIG=$full HIVE_MANIFEST=$temporary/manifest.json HIVE_VERSION=3.6.0 HIVE_OPERATION=$1 hive_checklist_prepare; }
hive_checklist_certificate_unit=$temporary/no-such-unit
: > "$reads"; prepare upgrade
grep -qx 'registry-read {"path":"/v1/installation"}' "$reads" || fail 'The recorded checklist was not read'
expect "$HIVE_CHECKLIST" "$(items "$full" upgrade "$previous" 3.5.0)" 'Prepared checklist'
for operation in rollback adopt restore rehearse migrate-native; do
  : > "$reads"; prepare "$operation"
  [[ -z "$HIVE_CHECKLIST" && ! -s "$reads" ]] || fail "$operation recorded a checklist"
done
HIVE_MANIFEST=$temporary/old.json; jq -n '{components:{"hive-registry":{version:"1.2.0"}}}' > "$HIVE_MANIFEST"
: > "$reads"; HIVE_CONFIG=$full HIVE_OPERATION=install hive_checklist_prepare
[[ -z "$HIVE_CHECKLIST" && ! -s "$reads" ]] || fail 'A registry before 1.3.0 was sent a checklist'
touch "$temporary/unavailable"; prepare upgrade 2> "$temporary/err"; rm "$temporary/unavailable"
[[ -z "$HIVE_CHECKLIST" ]] && grep -q 'checklist was not updated' "$temporary/err" || fail 'An unanswered read replaced the recorded checklist'
# The sync body carries the prepared list, and nothing when there is none.
jq -n '{schema:1,version:"3.6.0",components:{"hive-registry":{image:("example.com/hive-registry@sha256:"+("a"*64)),version:"1.3.0",catalog:{displayName:"Registry",connection:{nativeApis:{},internalEndpoints:{}}}}}}' > "$temporary/release.json"
body() { HIVE_CONFIG=$temporary/body-config.json HIVE_MANIFEST=$temporary/release.json HIVE_VERSION=3.6.0 HIVE_MANIFEST_DIGEST=d HIVE_PLAN_DIGEST=p hive_registry_body complete installed; }
jq '.components={"hive-registry":{host:"control"}}' "$core" > "$temporary/body-config.json"
HIVE_CHECKLIST='[{"id":"first-admin","title":"T","status":"pending","command":"./hive.sh setup done first-admin","docs":"README.md"}]'
body | jq -e '.setup=={items:[{id:"first-admin",title:"T",status:"pending",command:"./hive.sh setup done first-admin",docs:"README.md"}]}' >/dev/null || fail 'The sync did not carry the checklist'
HIVE_CHECKLIST=''
body | jq -e 'has("setup")|not' >/dev/null || fail 'A sync without a prepared checklist carried one'
unset HIVE_CHECKLIST
body | jq -e 'has("setup")|not' >/dev/null || fail 'A sync without a prepared checklist carried one'
printf 'Passed: the checklist goes only to registries from 1.3.0, with install and upgrade.\n'

# Install and upgrade end with the pending items; nothing is printed without a checklist.
HIVE_CHECKLIST=$(items "$full" install)
hive_checklist_report > "$temporary/report"
grep -q 'Setup checklist: 3 pending' "$temporary/report" && grep -q '  - magnus-agent-enrolled: Install the Magnus agent on the Magnus host' "$temporary/report" &&
  grep -qF './hive.sh magnus-agent install' "$temporary/report" && grep -q 'See deployment/FULL.md#installing-the-agent' "$temporary/report" || { cat "$temporary/report" >&2; fail 'The install did not list its pending items'; }
HIVE_CHECKLIST=$(jq -c 'map(.status="done")' <<< "$HIVE_CHECKLIST"); [[ -z $(hive_checklist_report | tr -d '\n') ]] || fail 'Settled items were listed as pending'
HIVE_CHECKLIST=''; [[ -z $(hive_checklist_report) ]] || fail 'A report was printed without a checklist'

# hive.sh setup: list, done and skip through the registry container client.
directory=$temporary/install
mkdir -p "$directory" "$temporary/bin"
jq --arg base "$directory" '.hosts.control.directory=$base | .console.runtimeFile=($base+"/config/runtime.json") | .components["hive-registry"]+={envFile:($base+"/config/hive-registry.env"),configDirectory:($base+"/config/hive-registry")}' "$full" > "$temporary/config.json"
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
[[ " $* " == *' exec '* ]] || exit 1
printf '%s\n' "$*" >> "$SETUP_FIXTURE/client.log"
if [[ " $* " == *' write '* ]]; then cat >> "$SETUP_FIXTURE/client.log"; printf '\n{"schema":1,"changes":1,"revision":3}\n'; exit 0; fi
[[ " $* " == *' GET /v1/installation '* ]] && cat "$SETUP_FIXTURE/installation.json"
SH
chmod 700 "$temporary/bin/docker"
export SETUP_FIXTURE=$temporary
setup() { PATH="$temporary/bin:$PATH" "$ROOT/hive.sh" setup "$@" --config "$temporary/config.json"; }
refused() { # MESSAGE ARGUMENTS...
  local message=$1; shift
  if setup "$@" > "$temporary/result" 2>&1; then fail "Accepted: setup $*"; fi
  grep -q -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}
jq -n --argjson items "$(items "$full" install)" '{schema:1,id:"example-suite",setup:{items:$items,updatedAt:"2026-11-01T00:00:00.000Z"}}' > "$temporary/installation.json"
: > "$temporary/client.log"
setup done first-admin > "$temporary/result"
grep -qx 'Recorded setup item first-admin as done.' "$temporary/result" || fail 'setup done did not confirm'
grep -q 'exec -T hive-registry node /app/dist/cli.js request PUT /v1/setup/items/first-admin write' "$temporary/client.log" || { cat "$temporary/client.log" >&2; fail 'setup done did not use the write credential'; }
grep -qx '{"status":"done"}' "$temporary/client.log" || fail 'setup done sent the wrong status'
: > "$temporary/client.log"
setup skip certificate-renewal >/dev/null
grep -q 'PUT /v1/setup/items/certificate-renewal write' "$temporary/client.log" && grep -qx '{"status":"skipped"}' "$temporary/client.log" || fail 'setup skip'
setup list > "$temporary/list"
[[ $(cut -f1,2 "$temporary/list" | tr '\t' ' ' | paste -sd,) == 'pending magnus-agent-enrolled,pending certificate-renewal,pending first-admin' ]] || { cat "$temporary/list" >&2; fail 'setup list'; }
[[ $(setup) == $(cat "$temporary/list") ]] || fail 'setup without a subcommand does not list'
: > "$temporary/client.log"
refused 'No setup item ardent-packages-updated is recorded' done ardent-packages-updated
refused 'needs an item ID' done
refused 'needs an item ID' skip 'Bad;Id'
refused 'Use: setup' finish first-admin
! grep -q ' write' "$temporary/client.log" || fail 'A refused setup command wrote to the registry'
printf '{"schema":1,"id":"example-suite"}\n' > "$temporary/installation.json"
refused 'older than 1.3.0' done first-admin
refused 'older than 1.3.0' list
"$ROOT/hive.sh" --help | grep -q 'setup \[list\] | setup done ID | setup skip ID' || fail 'Usage omits setup'
printf 'Passed: hive.sh setup lists the checklist and settles one recorded item at a time.\n'

# Magnus 3.0.0 or later accepts node keys only: an upgrade lists the node-key step, found done when
# Magnus's fleet summary has no blockers, and nothing changes for a release pinning an older Magnus.
node_ids() { HIVE_CONFIG=$full HIVE_VERSION=3.9.0 hive_checklist_items upgrade null 3.8.1 false "$1" | jq -c 'map(select(.id=="magnus-node-keys"))|map([.id,.status,.docs])'; }
expect "$(node_ids absent)" '[]' 'Node keys before Magnus 3'
expect "$(node_ids blocked)" '[["magnus-node-keys","pending","UPGRADING.md#magnus-300-node-keys-only"]]' 'Node keys with blockers'
expect "$(node_ids unknown)" '[["magnus-node-keys","pending","UPGRADING.md#magnus-300-node-keys-only"]]' 'Node keys not readable'
expect "$(node_ids ready)" '[["magnus-node-keys","done","UPGRADING.md#magnus-300-node-keys-only"]]' 'Node keys without blockers'
expect "$(HIVE_CONFIG=$full hive_checklist_items install null '' false ready | jq -c 'map(select(.id=="magnus-node-keys"))')" '[]' 'Node keys on a fresh install'
# Which readiness the controller finds: from the summary of a Magnus it runs, for a 3.x pin only.
jq -n '{components:{magnus:{version:"3.0.0"}}}' > "$temporary/magnus3.json"; jq -n '{components:{magnus:{version:"2.10.2"}}}' > "$temporary/magnus2.json"
summary_fixture=''
hive_magnus_node_summary() { [[ -n "$summary_fixture" ]] && printf '%s\n' "$summary_fixture"; }
node_keys() { HIVE_CONFIG=$1 HIVE_MANIFEST=$2 hive_checklist_node_keys; }
summary_fixture='{"supported":true,"mode":"compat","modeDeprecated":true,"enforceReady":false,"blockers":[{"code":"NODES_WITHOUT_KEY","count":2}]}'
expect "$(node_keys "$full" "$temporary/magnus2.json")" absent 'A Magnus 2 pin'
expect "$(node_keys "$core" "$temporary/magnus3.json")" absent 'No Magnus of its own'
expect "$(node_keys "$full" "$temporary/magnus3.json")" blocked 'A summary with blockers'
summary_fixture='{"supported":true,"mode":"enforce","modeDeprecated":false,"enforceReady":true,"blockers":[]}'
expect "$(node_keys "$full" "$temporary/magnus3.json")" ready 'A summary without blockers'
summary_fixture=''
expect "$(node_keys "$full" "$temporary/magnus3.json")" unknown 'No summary'
printf 'Passed: the Magnus node-key step for releases pinning Magnus 3.0.0 or later.\n'
