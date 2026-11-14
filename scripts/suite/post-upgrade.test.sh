#!/usr/bin/env bash
# hive.sh post-upgrade: which follow-up steps it runs or lists for an installation. The commands
# it delegates to (magnus-agent, console-clients) are replaced by recorders; no host is contacted.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
HIVE_ROOT=$ROOT
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/magnus-agent.sh"
source "$ROOT/scripts/suite/console-clients.sh"
source "$ROOT/scripts/suite/post-upgrade.sh"
source "$ROOT/scripts/suite/setup-checklist.sh"
calls=$temporary/calls
# No registry here: no checklist is recorded unless a test sets one, and marks are recorded.
recorded_checklist=''
hive_checklist_recorded() { [[ -n "$recorded_checklist" ]] && printf '%s\n' "$recorded_checklist"; }
hive_registry_write() { printf 'registry %s %s %s\n' "$1" "$2" "$3" >> "$calls"; }
hive_checklist_certificate_unit=$temporary/no-such-unit
HIVE_VERSION=9.9.9 HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/release.json.sig HIVE_TRUST_KEY=$temporary/publisher.pub
jq -n '{components:{magnus:{agentPackage:{name:"@hivemagnus/magnus-agent",version:"2.4.3",integrity:("sha512-"+("A"*86)+"==")}}}}' > "$HIVE_MANIFEST"
agent_version=''
hive_post_upgrade_run() {
  printf '%s\n' "$*" >> "$calls"
  if [[ "$*" == 'magnus-agent status' ]]; then jq -n --arg version "$agent_version" '{installedVersion:(if $version=="" then null else $version end)}'; fi
}
run() { # CONFIG-PATCH
  jq "$1" "$ROOT/examples/installation.json" > "$temporary/installation.json"
  HIVE_CONFIG=$temporary/installation.json
  : > "$calls"
  hive_post_upgrade > "$temporary/output"
}

# A single-host installer node gets a package update without enrollment; clients are checked.
agent_version=2.4.2
run '.components={magnus:{host:"control"},oathweave:{host:"control"},ingress:{host:"control"}} | .console={host:"control"} | .bootstrap={} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
grep -qx 'magnus-agent install' "$calls" || fail 'An older installer agent was not updated without enrollment'
! grep -qx 'magnus-agent enroll' "$calls" || fail 'A package update requested full-node enrollment'
grep -qx 'console-clients add' "$calls" || fail 'Missing browser clients were not checked'
grep -q 'this release pins 2.4.3' "$temporary/output" || fail 'The pinned agent version was not reported'
grep -q 'Update package' "$temporary/output" || fail 'The Ardent package step was not listed'
# Upgraded agents are left to Magnus's automatic binding of their node keys: nothing is issued.
grep -q 'Its node key: nothing to do' "$temporary/output" && grep -q 'Upgraded agents bind their node keys automatically' "$temporary/output" || fail 'The node key step of upgraded agents was not explained'

# --yes confirms a package update, never a scope expansion. The same single-host config
# can describe an intentionally LIMITED node, an Ardent-only node, or a fully enrolled node.
# Do not infer enrollment authority from topology, even when the status includes that evidence.
for scope in limited ardent-only enrolled; do
  HIVE_CONFIRMED=true
  hive_post_upgrade_run() {
    printf '%s\n' "$*" >> "$calls"
    if [[ "$*" == 'magnus-agent status' ]]; then
      jq -n --arg scope "$scope" '{installedVersion:"2.4.2",node:{enrollment:{state:$scope}}}'
    fi
  }
  run '.components={magnus:{host:"control"}} | .console={host:"control"} | .bootstrap={} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
  grep -qx 'magnus-agent install' "$calls" || fail "$scope node did not get a package update with --yes"
  ! grep -Eq 'enroll|prepare-ardent|--trust' "$calls" || fail "$scope node received new authority with --yes"
done
unset HIVE_CONFIRMED
hive_post_upgrade_run() {
  printf '%s\n' "$*" >> "$calls"
  if [[ "$*" == 'magnus-agent status' ]]; then jq -n --arg version "$agent_version" '{installedVersion:(if $version=="" then null else $version end)}'; fi
}

# The pinned agent needs nothing, and a distributed Magnus host is upgraded with install.
agent_version=2.4.3
run '.components={magnus:{host:"control"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
! grep -q 'enroll\|magnus-agent install' "$calls" || fail 'A current agent was changed'
grep -q 'Magnus agent: 2.4.3, as this release pins' "$temporary/output" || fail 'A current agent was not reported'
agent_version=2.4.0
run '.components={magnus:{host:"control"}} | .hosts={control:{target:"local",directory:"/opt/hive"},data:{target:"deploy@data.example.com",directory:"/opt/hive"}}'
grep -qx 'magnus-agent install' "$calls" || fail 'An older agent outside installer enrollment was not reinstalled'
! grep -qx 'magnus-agent enroll' "$calls" || fail 'A distributed installation was enrolled as a single-host node'

# No agent installed, no Magnus, and no Oathweave: nothing is changed.
agent_version=''
run '.components={magnus:{host:"control"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
grep -q 'not installed on the Magnus host' "$temporary/output" || fail 'A missing agent was not reported'
run '.components={hivemem:{host:"control"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
[[ ! -s "$calls" ]] || fail 'An installation without Magnus or Oathweave ran a step'
! grep -q 'Ardent' "$temporary/output" || fail 'Ardent was listed without Magnus'
printf 'Passed: post-upgrade agent upgrade paths, browser clients and the remaining-steps list.\n'

# The setup checklist: each step post-upgrade finds done is marked done at once, and only items
# the registry recorded with another status. Manual items stay pending and are listed.
checklist_item() { jq -nc --arg id "$1" --arg status "$2" '{id:$id,title:("Item "+$id),status:$status,command:"./hive.sh post-upgrade",docs:"deployment/FULL.md#setup-checklist"}'; }
recorded_checklist=$(jq -sc . <(checklist_item magnus-agent-enrolled pending) <(checklist_item oathweave-console-clients pending) <(checklist_item ardent-packages-updated pending) <(checklist_item certificate-renewal pending))
touch "$temporary/unit"; hive_checklist_certificate_unit=$temporary/unit
agent_version=2.4.2
run '.components={magnus:{host:"control"},oathweave:{host:"control"},ingress:{host:"control"}} | .console={host:"control",nativeListeners:[{component:"magnus",port:4100}]} | .bootstrap={} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
for id in magnus-agent-enrolled oathweave-console-clients certificate-renewal; do
  grep -qx "registry PUT /v1/setup/items/$id {\"status\":\"done\"}" "$calls" || { cat "$calls" >&2; fail "post-upgrade did not mark $id done"; }
done
[[ $(grep -c '^registry ' "$calls") == 3 ]] || fail 'post-upgrade marked an item it did not complete'
# The agent install is marked only after it ran.
[[ $(grep -n 'magnus-agent install' "$calls" | cut -d: -f1) -lt $(grep -n 'setup/items/magnus-agent-enrolled' "$calls" | cut -d: -f1) ]] || fail 'The agent was marked before its install'
grep -q 'Setup checklist: 1 pending' "$temporary/output" || { cat "$temporary/output" >&2; fail 'The remaining checklist item was not listed'; }
grep -q 'ardent-packages-updated' "$temporary/output" || fail 'The Ardent item was not listed as pending'
# A failed step is not marked; an item already done or skipped by hand is not rewritten as done twice.
hive_post_upgrade_run() {
  printf '%s\n' "$*" >> "$calls"
  if [[ "$*" == 'magnus-agent status' ]]; then jq -n '{installedVersion:"2.4.2"}'; fi
  [[ "$*" != 'magnus-agent install' && "$*" != 'console-clients add' ]]
}
recorded_checklist=$(jq -sc . <(checklist_item magnus-agent-enrolled pending) <(checklist_item oathweave-console-clients pending) <(checklist_item certificate-renewal done))
run '.components={magnus:{host:"control"},oathweave:{host:"control"},ingress:{host:"control"}} | .console={host:"control"} | .bootstrap={} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
! grep -q '^registry ' "$calls" || { cat "$calls" >&2; fail 'A failed step or a done item was marked'; }
grep -q 'Setup checklist: 2 pending' "$temporary/output" || fail 'The failed steps were not listed as pending'
# A registry without a checklist: nothing is written, and the output is as before.
recorded_checklist=''
run '.components={magnus:{host:"control"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
! grep -q '^registry ' "$calls" || fail 'post-upgrade wrote to a registry without a checklist'
! grep -q 'Setup checklist' "$temporary/output" || fail 'A checklist was listed without one recorded'
printf 'Passed: post-upgrade marks the checklist items it completes, and only those.\n'
hive_post_upgrade_run() {
  printf '%s\n' "$*" >> "$calls"
  if [[ "$*" == 'magnus-agent status' ]]; then jq -n --arg version "$agent_version" '{installedVersion:(if $version=="" then null else $version end)}'; fi
}

# A release pinning Magnus 3.0.0 accepts node keys only: post-upgrade reads Magnus's fleet summary,
# lists its blockers or marks the node-key step done, and says agents get no shared secret.
jq '.components.magnus.version="3.0.0"' "$HIVE_MANIFEST" > "$temporary/magnus3.json"; cp "$HIVE_MANIFEST" "$temporary/magnus2.json"; cp "$temporary/magnus3.json" "$HIVE_MANIFEST"
summary_fixture='{"supported":true,"mode":"compat","modeDeprecated":true,"enforceReady":false,"blockers":[{"code":"NODES_WITHOUT_KEY","count":2},{"code":"RECENT_SHARED_SECRET_USE","count":1}]}'
hive_magnus_node_summary() { printf 'summary\n' >> "$calls"; [[ -n "$summary_fixture" ]] && printf '%s\n' "$summary_fixture"; }
recorded_checklist=$(jq -sc . <(checklist_item magnus-node-keys pending))
agent_version=2.4.2
run '.components={magnus:{host:"control"}} | .console={host:"control"} | .bootstrap={} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
grep -q 'Magnus node keys: NODES_WITHOUT_KEY (2), RECENT_SHARED_SECRET_USE (1)' "$temporary/output" || { cat "$temporary/output" >&2; fail 'The node-key blockers were not listed'; }
grep -q 'explicit NODE_AUTH_MODE=compat, which is deprecated' "$temporary/output" || fail 'The deprecated mode was not reported'
grep -q 'an agent without a key is enrolled with a one-time token' "$temporary/output" && grep -q 'No fleet-wide node secret is copied' "$temporary/output" || fail 'The node-key steps of a Magnus 3 release were not explained'
! grep -q 'bind their node keys automatically\|binds its own key automatically' "$temporary/output" || fail 'A Magnus 3 release promised the automatic binding'
! grep -q 'setup/items/magnus-node-keys' "$calls" || fail 'The node-key step was marked done with blockers'
summary_fixture='{"supported":true,"mode":"enforce","modeDeprecated":false,"enforceReady":true,"blockers":[]}'
run '.components={magnus:{host:"control"}} | .console={host:"control"} | .bootstrap={} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
grep -q 'Magnus node keys: no blockers; every agent authenticates with its own key (mode enforce)' "$temporary/output" || fail 'A clean summary was not reported'
grep -qx 'registry PUT /v1/setup/items/magnus-node-keys {"status":"done"}' "$calls" || fail 'A clean summary did not mark the node-key step done'
! grep -q 'deprecated' "$temporary/output" || fail 'An enforce server was called deprecated'
# Not readable here (no answer, or an external Magnus): a note that points at the summary.
summary_fixture=''
run '.components={magnus:{host:"control"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
grep -q 'Check its fleet summary, GET /api/v1/node-credentials/summary' "$temporary/output" || fail 'An unreadable summary got no note'
: > "$temporary/calls-external"
run '.components={hivemem:{host:"control"}} | .external={magnus:{url:"https://magnus.example.com:4000"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
grep -q 'Check its fleet summary' "$temporary/output" && ! grep -qx summary "$calls" || fail 'An external Magnus was not pointed at its summary'
# A release pinning Magnus 2.x never reads the summary and prints no node-key step.
cp "$temporary/magnus2.json" "$HIVE_MANIFEST"; recorded_checklist=''
run '.components={magnus:{host:"control"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
! grep -qx summary "$calls" && ! grep -q 'Magnus node keys' "$temporary/output" || fail 'A Magnus 2 release read the node-key summary'
printf 'Passed: post-upgrade reports Magnus 3 node-key readiness and marks it done only without blockers.\n'

# The real runner passes the installation, release and confirmation to its own controller process.
unset -f hive_post_upgrade_run
source "$ROOT/scripts/suite/post-upgrade.sh"
mkdir -p "$temporary/root"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "%s"\n' "$temporary/arguments" > "$temporary/root/hive.sh"
HIVE_ROOT=$temporary/root HIVE_CONFIRMED=true HIVE_REGISTRY_ORIGINAL_CONFIG='' hive_post_upgrade_run magnus-agent enroll
grep -qx "magnus-agent enroll --config $HIVE_CONFIG --release 9.9.9 --manifest $HIVE_MANIFEST --signature $temporary/release.json.sig --trust-key $temporary/publisher.pub --yes" "$temporary/arguments" || { cat "$temporary/arguments" >&2; fail 'The delegated command lost its installation, release or confirmation'; }
printf 'Passed: delegated commands keep their installation, release and confirmation.\n'
