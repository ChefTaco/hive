#!/usr/bin/env bash
# The read-only Ardent installation check: the host action that asks Magnus for its Ardent
# installations (inside the Magnus container with its API secret, or inside the Ardent Project
# Studio container as Studio's service identity), and which source the controller picks. Docker
# and Magnus are fixtures; nothing is installed or restarted.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$temporary/bin" "$temporary/host"
printf '{"services":{"magnus":{},"ardentstudio":{}}}\n' > "$temporary/host/compose.json"

# Magnus's GET /api/v1/ardent/installations and Oathweave's token endpoint. Each request is logged
# without its credentials, only whether the expected one was sent.
cat > "$temporary/fetch.mjs" <<'EOF'
import { appendFileSync } from 'node:fs';
const installation = (nodeName, installed, version, staged, extra = {}) => ({ nodeId: 'id-' + nodeName, nodeName, hostname: nodeName + '.example.com', installed, version,
  owner: 'ardent', profiles: [{ id: nodeName, running: true }], checkedAt: '2026-11-14T00:00:00.000Z', stagedPackage: staged ? { version: staged, sha256: 'a'.repeat(64) } : null,
  stagedPackageError: null, reachable: true, error: null, ...extra });
globalThis.fetch = async (url, init = {}) => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const path = new URL(url).pathname;
  if (path === '/api/v1/oauth/token') {
    const form = new URLSearchParams(init.body);
    const valid = init.method === 'POST' && form.get('grant_type') === 'client_credentials' && form.get('client_id') === 'ardentstudio-magnus'
      && form.get('client_secret') === 'obviously-fake-studio-client-secret' && form.get('scope') === 'magnus:ardent';
    appendFileSync(process.env.FIXTURE_LOG, `token ${valid}\n`);
    return valid ? json({ access_token: 'obviously-fake-service-token', token_type: 'Bearer', expires_in: 300 }) : json({ error: 'invalid_client' }, 401);
  }
  const headers = init.headers ?? {};
  const authorized = headers['x-api-secret'] === 'obviously-fake-api-secret' || headers.authorization === 'Bearer obviously-fake-service-token';
  appendFileSync(process.env.FIXTURE_LOG, `${new URL(url).origin}${path} ${authorized}\n`);
  if (!authorized) return json({ error: { code: 'UNAUTHORIZED' } }, 401);
  if (process.env.FIXTURE_ANSWER === 'missing') return json({ error: { code: 'NOT_FOUND' } }, 404);
  if (process.env.FIXTURE_ANSWER === 'down') return json({ error: { code: 'INTERNAL' } }, 500);
  if (path === '/api/v1/ardent/dependencies') {
    if (process.env.FIXTURE_DEPENDENCIES === 'old') return json({ error: { code: 'NOT_FOUND' } }, 404);
    if (process.env.FIXTURE_DEPENDENCIES === 'method') return json({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405);
    if (process.env.FIXTURE_DEPENDENCIES === 'down') return json({ error: { code: 'INTERNAL' } }, 503);
    if (process.env.FIXTURE_DEPENDENCIES === 'unreachable') throw new TypeError('fetch failed');
    return json({ success: true, data: [
      { name: 'hivemem', status: 'usable', source: 'registry', endpoint: 'https://hivemem:18790', capabilities: ['memory.v1'] },
      { name: 'emberpath', status: 'unsupported', source: 'override', endpoint: 'https://models.example.com:9443', capabilities: ['retry-signal.v1', 'Bad Name'], reason: 'Emberpath 2.5.4 lacks\nemberpath.execution-trace.v1' },
      { name: 'hiveskills', status: 'awaiting_configuration', source: 'none', capabilities: [], reason: 'No HiveSkills credential yet' },
      { name: 'Not A Name', status: 'exploded', source: 'guess', extra: 'obviously-fake-extra-field' }] });
  }
  if (path !== '/api/v1/ardent/installations') return json({ error: { code: 'NOT_FOUND' } }, 404);
  return json({ success: true, data: [installation('alpha', true, '3.1.3', '3.1.3'), installation('bravo', true, '3.1.2', '3.1.3'),
    installation('charlie', true, null, '3.1.3', { reachable: false, error: 'private diagnostic of an offline node' }),
    installation('delta', true, '3.1.3', '3.1.3', { stagedPackageError: 'private diagnostic of a staged package' }),
    installation('fresh', false, null, '3.1.3')] });
};
EOF
# docker compose -f FILE exec -T -e HIVE_ARDENT_SOURCE=S S node --input-type=module -e SCRIPT, with the
# named container's own environment.
cat > "$temporary/bin/docker" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\${*:1:11}" >> "$temporary/docker.log"
[[ "\$1 \$2 \$4 \$5 \$6 \$9 \${10} \${11}" == "compose -f exec -T -e node --input-type=module -e" && "\$7" == "HIVE_ARDENT_SOURCE=\$8" ]] || exit 99
case "\$8" in
  magnus) exec env "\$7" API_SECRET=obviously-fake-api-secret CONTROL_API_PORT=4000 FIXTURE_LOG="$temporary/fetch.log" node --import "$temporary/fetch.mjs" --input-type=module -e "\${12}";;
  ardentstudio) exec env "\$7" ARDENT_STUDIO_MAGNUS_URL=https://magnus.example.com:4000/ ARDENT_STUDIO_OATHWEAVE_TOKEN_URL=https://oathweave:4200/api/v1/oauth/token \
    ARDENT_STUDIO_MAGNUS_CLIENT_ID=ardentstudio-magnus ARDENT_STUDIO_MAGNUS_CLIENT_SECRET=\${STUDIO_SECRET-obviously-fake-studio-client-secret} ARDENT_STUDIO_MAGNUS_SCOPE=magnus:ardent \
    FIXTURE_LOG="$temporary/fetch.log" node --import "$temporary/fetch.mjs" --input-type=module -e "\${12}";;
  *) exit 98;;
esac
EOF
chmod +x "$temporary/bin/docker"
host_action() { # SERVICE [ACTION]
  : > "$temporary/fetch.log"
  jq -nc --arg compose "$temporary/host/compose.json" --arg service "$1" --arg action "${2:-magnus-agent-ardent-installations}" '{action:$action,magnusAgent:{compose:$compose,service:$service}}' |
    PATH="$temporary/bin:$PATH" bash "$ROOT/scripts/suite/magnus-agent-host.sh"
}
expected='{"supported":true,"installations":[{"name":"alpha","version":"3.1.3","staged":"3.1.3","stagedError":false,"reachable":true},{"name":"bravo","version":"3.1.2","staged":"3.1.3","stagedError":false,"reachable":true},{"name":"charlie","version":null,"staged":"3.1.3","stagedError":false,"reachable":false},{"name":"delta","version":"3.1.3","staged":"3.1.3","stagedError":true,"reachable":true}]}'

# Inside the Magnus container, with its API secret, on its own port.
result=$(host_action magnus 2> "$temporary/err") || { cat "$temporary/err" >&2; fail 'The Magnus container read failed'; }
[[ $(jq -c . <<< "$result") == "$expected" ]] || fail "The Magnus read was misreported: $result"
grep -qx 'https://localhost:4000/api/v1/ardent/installations true' "$temporary/fetch.log" || fail 'The Magnus container did not read its own API with its secret'
grep -q 'HIVE_ARDENT_SOURCE=magnus magnus node' "$temporary/docker.log" || fail 'The read did not run in the Magnus container'
# Inside the Studio container, as Studio's service identity: a client_credentials token, then the read.
result=$(host_action ardentstudio 2> "$temporary/err") || { cat "$temporary/err" >&2; fail 'The Studio container read failed'; }
[[ $(jq -c . <<< "$result") == "$expected" ]] || fail "The Studio read was misreported: $result"
[[ $(cat "$temporary/fetch.log") == $'token true\nhttps://magnus.example.com:4000/api/v1/ardent/installations true' ]] || { cat "$temporary/fetch.log" >&2; fail 'Studio did not read the external Magnus with its own token'; }
# Nothing but the fields above leaves a container: no secret, token, host name or diagnostic.
! grep -q 'obviously-fake\|example.com\|private diagnostic\|fresh' <<< "$result" || fail 'A credential, host name, diagnostic or uninstalled node left the container'
! grep -q 'obviously-fake' "$temporary/docker.log" || fail 'A credential was a docker argument'
# Refusals: a wrong Studio secret, a Magnus that fails, a Magnus without the list, an unknown source.
if STUDIO_SECRET=wrong host_action ardentstudio 2> "$temporary/err" >/dev/null; then fail 'A refused Studio token was used'; fi
grep -q 'Oathweave refused the Studio service token: HTTP 401' "$temporary/err" && ! grep -q 'wrong' "$temporary/err" || fail 'The refused token was not reported, or echoed the secret'
if FIXTURE_ANSWER=down host_action magnus 2> "$temporary/err" >/dev/null; then fail 'A failing Magnus was read as an answer'; fi
grep -q 'Magnus refused the Ardent installations: HTTP 500 INTERNAL' "$temporary/err" || fail 'A failing Magnus was not reported'
[[ $(FIXTURE_ANSWER=missing host_action magnus) == '{"supported":false}' ]] || fail 'A Magnus without the installation list was not reported unsupported'
if host_action hivemem 2>/dev/null; then fail 'An unknown container was used'; fi
printf 'Passed: the Ardent installations are read only, in the Magnus or Studio container, and only versions and node names leave it.\n'

# The agent dependencies, read the same way: name, status, source, endpoint, capabilities, reason.
dependencies='{"supported":true,"dependencies":[{"name":"hivemem","status":"usable","source":"registry","endpoint":"https://hivemem:18790","capabilities":["memory.v1"],"reason":null},{"name":"emberpath","status":"unsupported","source":"override","endpoint":"https://models.example.com:9443","capabilities":["retry-signal.v1"],"reason":"Emberpath 2.5.4 lacks emberpath.execution-trace.v1"},{"name":"hiveskills","status":"awaiting_configuration","source":"none","endpoint":null,"capabilities":[],"reason":"No HiveSkills credential yet"},{"name":"unknown","status":"unknown","source":"unknown","endpoint":null,"capabilities":[],"reason":null}]}'
result=$(host_action magnus magnus-agent-ardent-dependencies 2> "$temporary/err") || { cat "$temporary/err" >&2; fail 'The Magnus dependency read failed'; }
[[ $(jq -c . <<< "$result") == "$dependencies" ]] || fail "The Magnus dependency read was misreported: $result"
grep -qx 'https://localhost:4000/api/v1/ardent/dependencies true' "$temporary/fetch.log" || fail 'The Magnus container did not read its dependencies with its secret'
result=$(host_action ardentstudio magnus-agent-ardent-dependencies 2> "$temporary/err") || { cat "$temporary/err" >&2; fail 'The Studio dependency read failed'; }
[[ $(jq -c . <<< "$result") == "$dependencies" ]] || fail "The Studio dependency read was misreported: $result"
[[ $(cat "$temporary/fetch.log") == $'token true\nhttps://magnus.example.com:4000/api/v1/ardent/dependencies true' ]] || fail 'Studio did not read the external Magnus dependencies with its own token'
! grep -q 'obviously-fake' <<< "$result" || fail 'A credential or unknown field left the container'
for answer in old method; do
  [[ $(FIXTURE_DEPENDENCIES=$answer host_action magnus magnus-agent-ardent-dependencies) == '{"supported":false}' ]] || fail "A Magnus without the dependency report ($answer) was not reported unsupported"
done
if FIXTURE_DEPENDENCIES=down host_action magnus magnus-agent-ardent-dependencies 2> "$temporary/err" >/dev/null; then fail 'A failing Magnus was read as a dependency report'; fi
grep -qx 'Magnus refused the agent dependencies: HTTP 503 INTERNAL' "$temporary/err" || fail 'A failing Magnus dependency read was not reported'
if FIXTURE_DEPENDENCIES=unreachable host_action magnus magnus-agent-ardent-dependencies 2> "$temporary/err" >/dev/null; then fail 'An unreachable Magnus was read as a dependency report'; fi
grep -qx 'Magnus did not answer the agent dependencies request' "$temporary/err" || fail 'An unreachable Magnus was not reported'
printf 'Passed: the agent dependencies are read only, in the Magnus or Studio container, bounded to their documented fields.\n'

# The controller's source: a suite-managed Magnus on its host; an external Magnus through Studio on
# Studio's host; an external Magnus without Studio cannot be asked from here.
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/magnus-agent.sh"
hive_magnus_agent_action() { printf '%s %s %s\n' "$1" "$2" "$3" > "$temporary/action"; printf '{"supported":true,"installations":[]}\n'; }
source_of() { # CONFIG
  rm -f "$temporary/action"; printf '%s\n' "$1" > "$temporary/config.json"
  HIVE_CONFIG=$temporary/config.json hive_magnus_ardent_installations > /dev/null || return 1
  cat "$temporary/action"
}
[[ $(source_of '{"components":{"magnus":{"host":"data"},"ardentstudio":{"host":"console"}},"hosts":{"data":{"directory":"/opt/data"},"console":{"directory":"/opt/console"}}}') == \
  'data magnus-agent-ardent-installations {"compose":"/opt/data/compose.json","service":"magnus"}' ]] || fail 'A suite-managed Magnus was not read on its host'
[[ $(source_of '{"components":{"ardentstudio":{"host":"console"}},"external":{"magnus":{"url":"https://magnus.example.com:4000"}},"hosts":{"console":{"directory":"/opt/console"}}}') == \
  'console magnus-agent-ardent-installations {"compose":"/opt/console/compose.json","service":"ardentstudio"}' ]] || fail 'An external Magnus was not read through Studio'
if source_of '{"components":{"hivemem":{"host":"console"}},"external":{"magnus":{"url":"https://magnus.example.com:4000"}},"hosts":{"console":{"directory":"/opt/console"}}}'; then fail 'An external Magnus without Studio was read'; fi
[[ ! -e "$temporary/action" ]] || fail 'A host action ran without a source'
printf 'Passed: the controller reads a suite-managed Magnus on its host and an external Magnus through Studio.\n'

# doctor's "Agent dependencies" section: only for an installed suite with a Magnus it can ask; an
# old Magnus is named, and a Magnus that does not answer is a warning, never a failure.
printf '%s\n' '{"components":{"magnus":{"host":"data"}},"hosts":{"data":{"directory":"/opt/data"}}}' > "$temporary/config.json"
doctor() { HIVE_CONFIG=$temporary/config.json HIVE_REGISTRY_STATE=${STATE-in-sync} hive_agent_dependencies_doctor > "$temporary/doctor.out" 2> "$temporary/doctor.err"; }
hive_magnus_agent_action() { printf '%s\n' "$2" >> "$temporary/actions"; [[ -n ${ANSWER:-} ]] || { printf 'Magnus refused the agent dependencies: HTTP 503 INTERNAL\n' >&2; return 1; }; printf '%s\n' "$ANSWER"; }
ANSWER=$dependencies doctor || fail 'Doctor failed on a dependency report'
diff -u <(printf '%s\n' 'Agent dependencies:' '  hivemem: usable (source: registry)' '  emberpath: unsupported (source: override) - Emberpath 2.5.4 lacks emberpath.execution-trace.v1' \
  '  hiveskills: awaiting_configuration (source: none) - No HiveSkills credential yet' '  unknown: unknown (source: unknown)') "$temporary/doctor.out" || fail 'Doctor printed the dependencies wrongly'
[[ $(cat "$temporary/actions") == magnus-agent-ardent-dependencies ]] || fail 'Doctor did not read the dependencies with their host action'
ANSWER='{"supported":false}' doctor || fail 'Doctor failed on a Magnus before 3.3.0'
diff -u <(printf '%s\n' 'Agent dependencies:' '  Magnus is too old to report agent dependencies (needs 3.3.0)') "$temporary/doctor.out" || fail 'Doctor did not name the Magnus version'
ANSWER='{"supported":true,"dependencies":[]}' doctor; grep -qx '  Magnus reports no agent dependencies' "$temporary/doctor.out" || fail 'Doctor did not report an empty list'
ANSWER='' doctor || fail 'Doctor failed on a Magnus that did not answer'
grep -qx 'WARNING: Agent dependencies: Magnus did not answer (Magnus refused the agent dependencies: HTTP 503 INTERNAL). Check Magnus with ./hive.sh status.' "$temporary/doctor.err" || { cat "$temporary/doctor.err" >&2; fail 'Doctor did not warn about a Magnus that did not answer'; }
ANSWER='not json' doctor || fail 'Doctor failed on a malformed reply'
grep -q '^WARNING: Agent dependencies: Magnus did not answer' "$temporary/doctor.err" || fail 'Doctor accepted a malformed reply'
rm -f "$temporary/actions"
for state in not-active drift ''; do STATE=$state ANSWER=$dependencies doctor; [[ ! -s "$temporary/doctor.out" && ! -e "$temporary/actions" ]] || fail "Doctor read Magnus on an installation that is $state"; done
printf '%s\n' '{"components":{"hivemem":{"host":"data"}},"hosts":{"data":{"directory":"/opt/data"}}}' > "$temporary/config.json"
ANSWER=$dependencies doctor; [[ ! -s "$temporary/doctor.out" && ! -e "$temporary/actions" ]] || fail 'Doctor read dependencies without a Magnus'
printf '%s\n' '{"components":{"hivemem":{"host":"data"}},"external":{"magnus":{"url":"https://magnus.example.com:4000"}},"hosts":{"data":{"directory":"/opt/data"}}}' > "$temporary/config.json"
ANSWER=$dependencies doctor; grep -q '^Agent dependencies: not checked; the external Magnus is read through Ardent Project Studio' "$temporary/doctor.out" && [[ ! -e "$temporary/actions" ]] || fail 'Doctor did not explain an external Magnus without Studio'
printf 'Passed: doctor prints the agent dependencies, names a Magnus too old to report them, and only warns when Magnus does not answer.\n'
