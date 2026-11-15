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
host_action() { # SERVICE
  : > "$temporary/fetch.log"
  jq -nc --arg compose "$temporary/host/compose.json" --arg service "$1" '{action:"magnus-agent-ardent-installations",magnusAgent:{compose:$compose,service:$service}}' |
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
