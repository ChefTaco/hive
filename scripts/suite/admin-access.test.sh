#!/usr/bin/env bash
# The real guided coordinator with fixture host actions and the real policy planner. No root,
# Docker, SSH or product service is used. State changes below belong only to temporary fixtures.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cat > "$temporary/fixture.sh" <<'FIXTURE'
#!/usr/bin/env bash
set -Eeuo pipefail
source "$TEST_ROOT/scripts/suite/controller.sh"
source "$TEST_ROOT/scripts/suite/admin-access.sh"
HIVE_ROOT=$TEST_ROOT HIVE_CONFIG=$TEST_CASE/installation.json HIVE_ID=example-suite
HIVE_CONFIRMED=${TEST_CONFIRMED:-true} HIVE_ADMIN_ACCESS_INTERACTIVE=false
hive_admin_access_action() {
  local request='{}'
  (($#<3)) || request=$3
  node "$TEST_ACTION" "$1" "$2" "$request"
}
hive_checklist_recorded() { return 1; }
hive_admin_access "$@"
FIXTURE

cat > "$temporary/action.mjs" <<'ACTION'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { planAdminAccess } = await import(pathToFileURL(process.env.TEST_ROOT + '/scripts/suite/admin-access-data.mjs').href);
const file = process.env.TEST_CASE + '/model.json', log = process.env.TEST_CASE + '/calls.jsonl';
const model = JSON.parse(readFileSync(file, 'utf8'));
const [host, mode, raw] = process.argv.slice(2), request = JSON.parse(raw);
const record = (event, data = {}) => appendFileSync(log, JSON.stringify({ event, host, mode, ...data }) + '\n');
record('action', { request });
const save = () => writeFileSync(file, JSON.stringify(model, null, 2) + '\n');
const answer = value => process.stdout.write(JSON.stringify(value) + '\n');
const matchingState = () => {
  assert(model.state && request.state, 'A confirmed retained operation must own this mutation');
  for (const key of ['installation', 'identity', 'operationId', 'localIds', 'hostIdentities']) {
    assert.deepEqual(request.state[key], model.state[key], 'Retained operation changed: ' + key);
  }
  assert.equal(request.state.hostIdentities[host], model.hosts[host].uuid, 'Installation host UUID changed');
};
try {
  switch (mode) {
    case 'list':
      assert.equal(host, 'identity'); answer({ administrators: [model.identity] }); break;
    case 'status':
    case 'resolve': {
      assert.equal(host, 'identity'); assert.equal(request.username, model.identity.username);
      if (request.plan?.nativeProvisioningVerified && process.env.TEST_DISABLED_IDENTITY === 'true') throw new Error('Administrator disabled');
      const identity = request.plan?.nativeProvisioningVerified && process.env.TEST_CHANGED_IDENTITY === 'true'
        ? { ...model.identity, subject: 'different-person-id' } : model.identity;
      answer({ identity, terminalPermissionAfterSetup: process.env.TEST_TERMINAL === 'true' }); break;
    }
    case 'inspect':
      answer({ state: host === 'identity' ? model.state : null, installationUUID: model.hosts[host].uuid,
        environments: model.hosts[host].environments }); break;
    case 'preview':
      assert.equal(host, 'identity'); answer(planAdminAccess(request.plan, { preview: true })); break;
    case 'init':
      assert.equal(host, 'identity'); assert.deepEqual(request.identity, model.identity);
      if (model.state) matchingState();
      else { model.state = request.state; record('write.init'); save(); }
      answer(model.state); break;
    case 'recover':
      matchingState(); answer({ recovered: true }); break;
    case 'secrets':
      matchingState();
      if (!model.hosts[host].secretsReady) { model.hosts[host].secretsReady = true; record('write.secrets'); save(); }
      answer({ purposeCredentialsReady: true }); break;
    case 'native': {
      matchingState(); const component = request.component;
      assert.equal(model.components[component].host, host); assert(model.hosts[host].secretsReady);
      record('native.get', { component });
      let normalized = model.nativeReceipts[component];
      if (!normalized) {
        normalized = { issuer: model.identity.issuer, subject: model.identity.subject,
          localId: model.state.localIds[component], owned: true,
          ...(component === 'hivemem' ? { active: true, credentialGeneration: 0 } : {}) };
        model.nativeReceipts[component] = normalized; record('native.post', { component }); save();
      }
      if (process.env.TEST_NATIVE_UNPROVEN === 'true') normalized = { ...normalized, owned: false };
      answer({ normalized }); break;
    }
    case 'merge': {
      matchingState(); const plan = planAdminAccess(request.plan);
      if (process.env.TEST_MERGE_UNVERIFIED === 'true') plan.nativeProvisioningVerified = false;
      record('plan.delta', { count: plan.changes.length }); answer(plan); break;
    }
    case 'apply': {
      matchingState(); const entries = Object.entries(request.plan.environments)
        .filter(([component]) => model.components[component].host === host);
      const changes = request.plan.changes.filter(change => model.components[change.component].host === host);
      if (process.env.TEST_APPLY_FAILURE_HOST === host) throw new Error('Synthetic interrupted product publication');
      record('publication', { count: changes.length });
      for (const [component, environment] of entries) model.hosts[host].environments[component] = environment;
      model.appliedHosts[host] = true; save(); answer({ healthy: true }); break;
    }
    case 'grant':
      matchingState(); assert.equal(host, 'identity');
      if (!model.suiteAdministrator) { model.suiteAdministrator = true; record('write.role'); save(); }
      answer({ suiteAdministrator: true }); break;
    case 'complete':
      matchingState(); assert.equal(host, 'identity'); model.state.phase = 'complete'; save();
      answer({ complete: true }); break;
    default: throw new Error('Unexpected fixture action: ' + mode);
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
ACTION

fixture() {
  case_directory=$temporary/$1
  mkdir -m 700 "$case_directory"
  TEST_CASE=$case_directory node --input-type=module <<'SEED'
import { writeFileSync } from 'node:fs';
const base = process.env.TEST_CASE, issuer = 'https://console.example.com/api/oathweave';
const components = { oathweave: { host: 'identity' }, hivemem: { host: 'identity' }, magnus: { host: 'product' } };
const config = { installation: 'example-suite', origin: 'https://console.example.com', bootstrap: { adminUsername: 'initial-operator' },
  console: { host: 'identity' }, hosts: { identity: { target: 'local', directory: '/opt/example-suite' }, product: { target: 'fixture-ssh', directory: '/opt/example-suite' } }, components };
const model = { components, identity: { issuer, subject: 'alice-person-id', username: 'alice', email: 'alice@example.com', displayName: 'Alice Example' },
  state: null, nativeReceipts: {}, appliedHosts: {}, suiteAdministrator: false, hosts: {
    identity: { uuid: 'a'.repeat(48), environments: { hivemem: { OATHWEAVE_ISSUER: issuer, UNRELATED_SETTING: 'retained-memory-value',
      HIVEMEM_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([{ issuer, subject: 'retained-operator', localId: 'retained-memory', credentialGeneration: 0 }]) } } },
    product: { uuid: 'b'.repeat(48), environments: { magnus: { OATHWEAVE_ISSUER: issuer, UNRELATED_SETTING: 'retained-fleet-value',
      MAGNUS_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([{ issuer, subject: 'retained-operator', localUserId: 'retained-fleet-user', role: 'ADMIN' },
        { issuer, subject: 'retained-service', localUserId: 'retained-service-user', role: 'ARDENT_SERVICE' }]) } } },
  } };
writeFileSync(base + '/installation.json', JSON.stringify(config) + '\n');
writeFileSync(base + '/model.json', JSON.stringify(model, null, 2) + '\n');
writeFileSync(base + '/calls.jsonl', '');
SEED
}
run() { # EXPECTED_EXIT [ENV=VALUE ...] -- COMMAND [USERNAME]
  local expected=$1 result=0; shift
  local -a settings=()
  while [[ ${1:-} != -- ]]; do settings+=("$1"); shift; done; shift
  timeout 30 env TEST_ROOT="$ROOT" TEST_CASE="$case_directory" TEST_ACTION="$temporary/action.mjs" "${settings[@]}" \
    bash "$temporary/fixture.sh" "$@" > "$case_directory/result" 2>&1 || result=$?
  if [[ "$expected" == failure ]]; then
    if [[ "$result" == 0 || "$result" == 124 || "$result" == 137 ]]; then cat "$case_directory/result" >&2; fail "Expected refusal, got exit $result"; fi
  elif [[ "$result" != "$expected" ]]; then cat "$case_directory/result" >&2; fail "Expected exit $expected, got $result"; fi
}
assert_model() { jq -e "$1" "$case_directory/model.json" >/dev/null || fail "$2"; }
no_mutations() {
  jq -es 'all(.[]; (.event|startswith("write.") or .=="publication" or .=="native.post")|not)
    and all(.[]|select(.event=="action"); .mode|IN("init","secrets","native","apply","grant","complete")|not)' "$case_directory/calls.jsonl" >/dev/null ||
    fail 'An unapproved or refused operation reached a mutation';
}

fixture read-only
before=$(sha256sum "$case_directory/model.json")
run 0 TEST_CONFIRMED=false -- list
grep -q 'alice@example.com' "$case_directory/result" || fail 'Administrator list omitted the exact account'
run 0 TEST_CONFIRMED=false -- status alice
jq -e '.identity.subject=="alice-person-id" and .setup==null' "$case_directory/result" >/dev/null || fail 'Unconfigured status was not read-only JSON'
[[ $(sha256sum "$case_directory/model.json") == "$before" ]] || fail 'List/status changed retained state'
no_mutations

fixture declined
run failure TEST_CONFIRMED=false -- setup alice
grep -q -- '--yes' "$case_directory/result" || fail 'Unattended refusal did not explain confirmation'
assert_model '.state==null and .nativeReceipts=={} and .suiteAdministrator==false' 'Declined setup created state or access'
no_mutations

fixture initial-operator
run failure -- setup initial-operator
[[ ! -s "$case_directory/calls.jsonl" ]] || fail 'The initial operator reached account resolution or provisioning'

fixture complete
run 0 TEST_TERMINAL=true -- setup alice
grep -q 'WEB TERMINAL:' "$case_directory/result" || fail 'The existing terminal permission was not disclosed before approval'
assert_model '.state.phase=="complete" and .suiteAdministrator and (.state.hostIdentities|keys)==["identity","product"]
  and (.state.localIds|keys)==["hivemem","magnus"] and .state.localIds.hivemem!=.state.localIds.magnus
  and .hosts.identity.environments.hivemem.UNRELATED_SETTING=="retained-memory-value"
  and .hosts.product.environments.magnus.UNRELATED_SETTING=="retained-fleet-value"' 'Completed setup changed identity/host ownership or unrelated policy'
TEST_CASE=$case_directory node --input-type=module <<'ASSERT'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = process.env.TEST_CASE, model = JSON.parse(readFileSync(base + '/model.json', 'utf8'));
const calls = readFileSync(base + '/calls.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const post = calls.findIndex(row => row.event === 'native.post');
const publications = calls.flatMap((row, index) => row.event === 'publication' ? [index] : []);
const role = calls.findIndex(row => row.event === 'write.role');
assert.equal(publications.length, 2); assert(post >= 0 && publications.every(index => index > post && index < role));
assert.deepEqual(calls.filter(row => row.event === 'action' && row.mode === 'apply').map(row => row.host), ['identity', 'product']);
assert.equal(calls.filter(row => row.event === 'action' && row.mode === 'complete').length, 1);
const memory = JSON.parse(model.hosts.identity.environments.hivemem.HIVEMEM_OATHWEAVE_IDENTITIES_JSON);
const fleet = JSON.parse(model.hosts.product.environments.magnus.MAGNUS_OATHWEAVE_IDENTITIES_JSON);
assert.deepEqual(memory[0], { issuer: model.identity.issuer, subject: 'retained-operator', localId: 'retained-memory', credentialGeneration: 0 });
assert.deepEqual(fleet.slice(0, 2), [{ issuer: model.identity.issuer, subject: 'retained-operator', localUserId: 'retained-fleet-user', role: 'ADMIN' },
  { issuer: model.identity.issuer, subject: 'retained-service', localUserId: 'retained-service-user', role: 'ARDENT_SERVICE' }]);
assert.equal(memory[1].localId, model.nativeReceipts.hivemem.localId);
assert.equal(fleet[2].localUserId, model.state.localIds.magnus);
ASSERT
state_before=$(jq -c .state "$case_directory/model.json")
environments_before=$(jq -Sc '.hosts|map_values(.environments)' "$case_directory/model.json")
: > "$case_directory/calls.jsonl"
run 0 -- setup alice
[[ $(jq -c .state "$case_directory/model.json") == "$state_before" ]] || fail 'A repeat changed the retained operation or product IDs'
[[ $(jq -Sc '.hosts|map_values(.environments)' "$case_directory/model.json") == "$environments_before" ]] || fail 'A repeat changed effective product policy'
jq -es 'all(.[]; .event!="native.post" and .event!="write.init" and .event!="write.role")
  and ([.[]|select(.event=="plan.delta")|.count]==[0])
  and ([.[]|select(.event=="publication")|.count]==[0,0])' "$case_directory/calls.jsonl" >/dev/null || fail 'A repeat recreated accounts, reapplied access deltas or reassigned a role'
: > "$case_directory/calls.jsonl"
run 0 TEST_CONFIRMED=false -- status alice
no_mutations
jq -e '.setup.phase=="complete"' "$case_directory/result" >/dev/null || fail 'Completed status lost its retained operation'

# The host UUID belongs to the retained operation, even when the path and user still match.
jq '.hosts.product.uuid=("c"*48)' "$case_directory/model.json" > "$case_directory/changed.json"
mv "$case_directory/changed.json" "$case_directory/model.json"
: > "$case_directory/calls.jsonl"
run failure -- setup alice
no_mutations
[[ $(jq -c .state "$case_directory/model.json") == "$state_before" ]] || fail 'A changed host replaced the operation identity'

for kind in changed disabled; do
  fixture "$kind-account"
  if [[ "$kind" == changed ]]; then setting=TEST_CHANGED_IDENTITY=true; else setting=TEST_DISABLED_IDENTITY=true; fi
  run failure "$setting" -- setup alice
  assert_model '.state.phase=="planned" and .suiteAdministrator==false' 'An unavailable account was completed or granted a suite role'
  jq -es 'all(.[]|select(.event=="action"); .mode|IN("apply","grant","complete")|not)' "$case_directory/calls.jsonl" >/dev/null || fail 'A changed/disabled account reached grant publication'
done

for setting in TEST_NATIVE_UNPROVEN=true TEST_MERGE_UNVERIFIED=true; do
  fixture "native-proof-${setting%%=*}"
  run failure "$setting" -- setup alice
  assert_model '.state!=null and .suiteAdministrator==false' 'Missing native proof granted access'
  jq -es 'all(.[]|select(.event=="action"); .mode|IN("apply","grant","complete")|not)' "$case_directory/calls.jsonl" >/dev/null || fail 'Unverified native ownership reached grant publication'
done

fixture interrupted-publication
run failure TEST_APPLY_FAILURE_HOST=product -- setup alice
assert_model '.state.phase=="planned" and .suiteAdministrator==false and .appliedHosts.identity==true
  and .appliedHosts.product==null' 'A partial host publication granted or completed the administrator'
jq -es 'all(.[]|select(.event=="action"); .mode|IN("grant","complete")|not)' "$case_directory/calls.jsonl" >/dev/null || fail 'A failed host publication was treated as complete'
state_before=$(jq -Sc '.state|{operationId,localIds,hostIdentities}' "$case_directory/model.json")
: > "$case_directory/calls.jsonl"
run 0 -- setup alice
assert_model '.state.phase=="complete" and .suiteAdministrator and .appliedHosts.product==true' 'A retained interrupted publication could not resume'
[[ $(jq -Sc '.state|{operationId,localIds,hostIdentities}' "$case_directory/model.json") == "$state_before" ]] || fail 'Resume replaced the interrupted operation or account IDs'
jq -es 'all(.[]; .event!="native.post" and .event!="write.init")' "$case_directory/calls.jsonl" >/dev/null || fail 'Resume replayed account creation instead of verifying its existing receipt'

fixture conflicting-policy
jq '.hosts.product.environments.magnus.MAGNUS_OATHWEAVE_IDENTITIES_JSON |=
  (fromjson+[{issuer:"https://console.example.com/api/oathweave",subject:"alice-person-id",localUserId:"foreign-existing-owner",role:"VIEWER"}]|tojson)' \
  "$case_directory/model.json" > "$case_directory/changed.json"
mv "$case_directory/changed.json" "$case_directory/model.json"
before=$(sha256sum "$case_directory/model.json")
run failure -- setup alice
[[ $(sha256sum "$case_directory/model.json") == "$before" ]] || fail 'A conflicting existing grant was overwritten or enrolled'
no_mutations

printf 'Passed: guided administrator confirmation, read-only status/list, exact host and account ownership, native proof before publication, all-host publication before IAM role grant, stable retries and policy-conflict refusal.\n'
