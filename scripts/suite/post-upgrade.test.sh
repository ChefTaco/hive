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
calls=$temporary/calls
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

# The real runner passes the installation, release and confirmation to its own controller process.
unset -f hive_post_upgrade_run
source "$ROOT/scripts/suite/post-upgrade.sh"
mkdir -p "$temporary/root"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "%s"\n' "$temporary/arguments" > "$temporary/root/hive.sh"
HIVE_ROOT=$temporary/root HIVE_CONFIRMED=true HIVE_REGISTRY_ORIGINAL_CONFIG='' hive_post_upgrade_run magnus-agent enroll
grep -qx "magnus-agent enroll --config $HIVE_CONFIG --release 9.9.9 --manifest $HIVE_MANIFEST --signature $temporary/release.json.sig --trust-key $temporary/publisher.pub --yes" "$temporary/arguments" || { cat "$temporary/arguments" >&2; fail 'The delegated command lost its installation, release or confirmation'; }
printf 'Passed: delegated commands keep their installation, release and confirmation.\n'
