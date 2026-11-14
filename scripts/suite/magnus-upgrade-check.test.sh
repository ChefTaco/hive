#!/usr/bin/env bash
# The check before an upgrade moves a suite-managed Magnus 2.x to a release pinning Magnus 3: the
# controller's decision with a recorded host answer (no host is contacted), then the Magnus host's
# side with a stubbed Docker that runs the readiness script against a fixture Magnus API.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
HIVE_ROOT=$ROOT
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/magnus-agent.sh"
calls=$temporary/calls
HIVE_VERSION=9.9.9 HIVE_MANIFEST=$temporary/release.json
jq -n '{components:{magnus:{version:"3.0.1"}}}' > "$HIVE_MANIFEST"
answer_json=
hive_magnus_agent_action() { printf '%s %s %s\n' "$1" "$2" "$3" >> "$calls"; [[ -n "$answer_json" ]] && printf "%s\n" "$answer_json"; }
answer() { # FLEET-PATCH MODE-SET MODE-VALUE
  answer_json=$(jq -nc --argjson set "${2:-false}" --arg value "${3:-}" '{installed:true,release:"3.8.1",pinned:"2.10.2",running:true,mode:{set:$set,value:$value},
    fleet:{version:"2.10.2",supported:true,mode:"compat",nodes:3,blockers:[],warnings:[]},error:null}' | jq -c "$1")
}
check() { # CONFIG-PATCH -> status in $status, output in $temporary/output
  jq "$1" "$ROOT/examples/installation.json" > "$temporary/installation.json"
  HIVE_CONFIG=$temporary/installation.json
  : > "$calls"
  if (hive_magnus_upgrade_check) > "$temporary/output" 2>&1; then status=0; else status=$?; fi
}
local_magnus='.components={magnus:{host:"control"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'

# A clean fleet passes, and the request names the Magnus host's directory and configuration.
answer .
check "$local_magnus"
[[ $status == 0 ]] || { cat "$temporary/output" >&2; fail 'A fleet without blockers was refused'; }
grep -qx 'control magnus-agent-upgrade-readiness {"directory":"/opt/hive","magnusEnvironment":"/opt/hive/config/magnus.env"}' "$calls" || { cat "$calls" >&2; fail 'The Magnus host was not asked'; }
grep -q 'ready for Magnus 3.0.1; every one of the 3 node(s) has an active key' "$temporary/output" || fail 'A ready fleet was not reported'
# Blockers that do not stop Magnus 3 from starting are named, and do not refuse.
answer '.fleet.warnings=[{code:"RECENT_SHARED_SECRET_USE",count:1}]'
check "$local_magnus"
[[ $status == 0 ]] && grep -q 'Not blocking the start: RECENT_SHARED_SECRET_USE (1)' "$temporary/output" || fail 'A warning-only blocker refused or was not named'

# With NODE_AUTH_MODE unset, each start-up blocker refuses, named with both ways out.
answer '.fleet.blockers=[{code:"NODES_WITHOUT_KEY",count:2},{code:"NODES_REVOKED",count:1},{code:"NODES_NOT_SIGNING_EVIDENCE",count:1},{code:"AGENTS_NEED_UPGRADE",count:3},{code:"SERVER_KEY_UNAVAILABLE",count:1}]'
check "$local_magnus"
[[ $status != 0 ]] || fail 'A fleet with blockers was accepted'
for expected in '2 node(s) without a node key' '1 node(s) whose node keys were all revoked' '1 node(s) whose agent does not sign its evidence' \
  '3 node(s) running agent 2.10.0 or 2.10.1' 'the server signing key cannot be read' 'magnus-agent install --config' 'set NODE_AUTH_MODE=compat explicitly' 'Nothing was changed'; do
  grep -qF -- "$expected" "$temporary/output" || { cat "$temporary/output" >&2; fail "The refusal does not say: $expected"; }
done
# An explicit compat or warn passes with the deprecation note and the remaining blockers; an
# explicit enforce passes and names what it will refuse; a value Magnus does not accept refuses.
for mode in compat warn; do
  answer '.fleet.blockers=[{code:"NODES_WITHOUT_KEY",count:2}]' true "$mode"
  check "$local_magnus"
  [[ $status == 0 ]] || fail "An explicit $mode was refused"
  grep -q "NODE_AUTH_MODE=$mode is set explicitly" "$temporary/output" && grep -q 'deprecated and removed in its next major' "$temporary/output" && grep -q '2 node(s) without a node key' "$temporary/output" || fail "An explicit $mode got no deprecation note"
done
answer '.fleet.blockers=[{code:"AGENTS_NEED_UPGRADE",count:1}]' true enforce
check "$local_magnus"
[[ $status == 0 ]] && grep -q 'It will refuse:' "$temporary/output" && grep -q '1 node(s) running agent 2.10.0 or 2.10.1' "$temporary/output" || fail 'An explicit enforce was not accepted with its warning'
answer . true Compat
check "$local_magnus"
[[ $status != 0 ]] && grep -q 'NODE_AUTH_MODE=Compat in config/magnus.env is not compat, warn or enforce' "$temporary/output" || fail 'An invalid mode was accepted'
# An empty value is unset, as for Magnus.
answer '.fleet.blockers=[{code:"NODES_WITHOUT_KEY",count:1}]' true ''
check "$local_magnus"
[[ $status != 0 ]] || fail 'An empty NODE_AUTH_MODE was taken as explicit'

# A Magnus that does not answer is refused unless the mode is explicit.
answer '.fleet=null | .error="Magnus did not answer"'
check "$local_magnus"
[[ $status != 0 ]] && grep -q 'could not be checked before its upgrade to 3.0.1 (Magnus did not answer)' "$temporary/output" || fail 'An unreadable fleet was accepted'
answer '.fleet=null | .error="Magnus did not answer"' true compat
check "$local_magnus"
[[ $status == 0 ]] || fail 'An explicit compat was refused while Magnus was down'
# Magnus 3 upgrades from 2.10.2 only, whatever the mode.
answer '.pinned="2.9.4" | .fleet.version="2.9.4"' true compat
check "$local_magnus"
[[ $status != 0 ]] && grep -q 'Magnus 2.9.4 cannot move to 3.0.1 directly: Magnus 3 upgrades from 2.10.2 only' "$temporary/output" || fail 'A Magnus older than 2.10.2 was moved to 3'
# Nothing to check: a new installation, Magnus added by this upgrade, or a Magnus already on 3.
for patch in '.installed=false | .running=false' '.running=false | .pinned=null | .fleet=null' '.pinned="3.0.0" | .fleet=null'; do
  answer "$patch | .fleet.blockers=[{code:\"NODES_WITHOUT_KEY\",count:1}]"
  [[ "$patch" != *'.fleet=null'* ]] || answer "$patch"
  check "$local_magnus"
  [[ $status == 0 ]] || { cat "$temporary/output" >&2; fail "The check refused: $patch"; }
done
# An external Magnus is only warned, and no host is asked.
answer_json=
check '.components={hivemem:{host:"control"}} | .external={magnus:{url:"https://magnus.example.com:4000"}} | .hosts={control:{target:"local",directory:"/opt/hive"}}'
[[ $status == 0 && ! -s "$calls" ]] && grep -q 'warning: this release pins Magnus 3.0.1' "$temporary/output" && grep -q 'https://magnus.example.com:4000 is upgraded outside this installation' "$temporary/output" || fail 'An external Magnus was not only warned'
# A release pinning Magnus 2.x checks nothing.
jq -n '{components:{magnus:{version:"2.10.2"}}}' > "$HIVE_MANIFEST"
answer '.fleet.blockers=[{code:"NODES_WITHOUT_KEY",count:1}]'
check "$local_magnus"
[[ $status == 0 && ! -s "$calls" && ! -s "$temporary/output" ]] || fail 'A Magnus 2 release ran the check'
printf 'Passed: the upgrade to a Magnus 3 release refuses a fleet that Magnus 3 would not start on, and names the ways out.\n'

# The Magnus host's side: the active release, the mode in magnus.env and the fleet as Magnus 3
# counts it, from a fixture of Magnus 2.10.2's API.
directory=$temporary/host; mkdir -p "$directory/config" "$directory/releases/3.8.1" "$temporary/bin"
printf '{"version":"3.8.1","plan":"%s"}\n' "$(printf 'a%.0s' {1..64})" > "$directory/receipt.json"
printf '{"components":{"magnus":{"version":"2.10.2"}}}\n' > "$directory/releases/3.8.1/manifest"
printf '{"services":{"magnus":{}}}\n' > "$directory/compose.json"
printf 'API_SECRET=obviously-fake-api-secret\nNODE_AUTH_MODE=warn\nNODE_AUTH_MODE=" compat "\n' > "$directory/config/magnus.env"
# The fixture API: the internal log sources, a decommissioned node and five real ones, on two pages.
cat > "$temporary/fetch.mjs" <<'EOF'
const node = (id, status, credential, version) => ({ id, name: id, status, agent: version ? { version } : null, nodeCredential: credential });
const pages = [
  [node('__control-api__', 'ONLINE', { state: 'none' }), node('__dashboard__', 'ONLINE', { state: 'none' }), node('retired', 'DECOMMISSIONED', { state: 'none' }, '2.9.0'),
   node('keyless', 'ONLINE', { state: 'none' }, '2.10.2')],
  [node('revoked', 'OFFLINE', { state: 'revoked', evidenceSigning: false }, '2.10.2'), node('quiet', 'ONLINE', { state: 'active', evidenceSigning: false }, '2.10.2'),
   node('old', 'ONLINE', { state: 'active', evidenceSigning: true }, '2.10.1'), node('ready', 'ONLINE', { state: 'active', evidenceSigning: true }, '2.10.3')],
];
globalThis.fetch = async (url, init) => {
  if (init?.headers?.['x-api-secret'] !== 'obviously-fake-api-secret') return new Response('{}', { status: 401 });
  const path = new URL(url).pathname + new URL(url).search;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (process.env.FIXTURE_DOWN) return json({ error: { code: 'INTERNAL' } }, 500);
  if (path === '/api/v1/self-update/version') return json({ data: { controlApiVersion: '2.10.2', agentVersion: '2.10.2' } });
  if (path === '/api/v1/node-credentials/summary') return json({ data: { mode: 'warn', enforceReady: false,
    blockers: [{ code: 'NODES_WITHOUT_KEY', count: 4, nodes: [] }, { code: 'RECENT_SHARED_SECRET_USE', count: 1, nodes: [] }] } });
  const page = /^\/api\/v1\/nodes\?pageSize=100&page=([12])$/.exec(path);
  if (page) return json({ data: pages[page[1] - 1], meta: { hasMore: page[1] === '1' } });
  return json({ error: { code: 'NOT_FOUND' } }, 404);
};
EOF
# docker compose -f FILE exec -T magnus node --input-type=module -e SCRIPT, in a fixture container.
printf '#!/usr/bin/env bash\n[[ "$1 $2 $4 $5 $6 $7 $8 $9" == "compose -f exec -T magnus node --input-type=module -e" ]] || exit 99\nexec env API_SECRET=obviously-fake-api-secret node --import "%s" --input-type=module -e "${10}"\n' "$temporary/fetch.mjs" > "$temporary/bin/docker"
chmod +x "$temporary/bin/docker"
host_action() { # REQUEST-PATCH
  jq -nc --arg directory "$directory" --arg file "$directory/config/magnus.env" '{action:"magnus-agent-upgrade-readiness",magnusAgent:{directory:$directory,magnusEnvironment:$file}}' | jq -c "${1:-.}" |
    PATH="$temporary/bin:$PATH" bash "$ROOT/scripts/suite/magnus-agent-host.sh"
}
result=$(host_action)
jq -e '.installed==true and .release=="3.8.1" and .pinned=="2.10.2" and .running==true and .mode=={set:true,value:"compat"} and .error==null' <<< "$result" >/dev/null || fail "The active release or mode was misread: $result"
jq -e '.fleet.version=="2.10.2" and .fleet.supported==true and .fleet.nodes==5' <<< "$result" >/dev/null || fail "The internal or decommissioned nodes were counted: $result"
jq -e '.fleet.blockers==[{code:"NODES_WITHOUT_KEY",count:1},{code:"NODES_REVOKED",count:1},{code:"NODES_NOT_SIGNING_EVIDENCE",count:1},{code:"AGENTS_NEED_UPGRADE",count:1}]' <<< "$result" >/dev/null || fail "The blockers differ from Magnus 3's: $result"
jq -e '.fleet.warnings==[{code:"RECENT_SHARED_SECRET_USE",count:1}]' <<< "$result" >/dev/null || fail "The summary's other blockers were not kept as warnings: $result"
! grep -q 'obviously-fake-api-secret\|keyless\|quiet' <<< "$result" || fail 'A secret or a node name left the Magnus host'
# The decision on that answer: an explicit compat passes; unset, it refuses.
jq -n '{components:{magnus:{version:"3.0.1"}}}' > "$HIVE_MANIFEST"
hive_magnus_upgrade_decide "$result" 2> "$temporary/output" || fail 'An explicit compat from magnus.env was refused'
if (hive_magnus_upgrade_decide "$(jq -c '.mode={set:false,value:""}' <<< "$result")") 2> "$temporary/output"; then fail 'The fixture fleet was accepted with the mode unset'; fi
# No mode, a Magnus that does not answer, and an installation without a Magnus or a receipt.
printf 'API_SECRET=obviously-fake-api-secret\n' > "$directory/config/magnus.env"
result=$(FIXTURE_DOWN=1 host_action)
jq -e '.mode=={set:false,value:""} and .fleet==null and (.error|startswith("Magnus refused its version: HTTP 500"))' <<< "$result" >/dev/null || fail "An unreachable Magnus was not reported: $result"
printf '{"components":{"magnus":{"version":"3.0.0"}}}\n' > "$directory/releases/3.8.1/manifest"
jq -e '.pinned=="3.0.0" and .fleet==null and .error==null' <<< "$(FIXTURE_DOWN=1 host_action)" >/dev/null || fail 'A Magnus 3 host was read'
rm "$directory/receipt.json"; printf '{"services":{}}\n' > "$directory/compose.json"
jq -e '.installed==false and .running==false and .fleet==null' <<< "$(host_action)" >/dev/null || fail 'A new installation was read'
if host_action '.magnusAgent.directory="relative/path"' 2>/dev/null; then fail 'A relative directory was accepted'; fi
printf 'Passed: the Magnus host reads the active release, the explicit mode and the fleet as Magnus 3 counts it, and names no node.\n'
