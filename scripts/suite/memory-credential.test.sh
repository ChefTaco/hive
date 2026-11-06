#!/usr/bin/env bash
# The Emberpath memory credential step on fresh, migrated and upgraded configurations:
# what it writes, that it keeps everything else, that a repeat changes nothing, and that
# the client secret is never printed. No containers are started.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
script="$ROOT/scripts/suite/memory-credential-host.sh"
run_step() { # DIRECTORY ACTION INPUT_JSON [NATIVE_MIGRATION_JSON]
  jq -nc --arg directory "$1" --arg action "$2" --argjson memoryCredential "$3" --argjson native "${4:-null}" \
    '{directory:$directory,action:$action,memoryCredential:$memoryCredential,nativeMigration:$native,placements:{oathweave:{},emberpath:{},hivemem:{}}}' | bash "$script"
}
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then fail "Accepted: $*"; fi
  grep -q -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}
value() { # FILE KEY: the effective value, quotes removed
  sed -n "s/^$2=//p" "$1" | tail -1 | sed "s/^'\(.*\)'$/\1/"
}
endpoints='{"identityOrigin":"https://oathweave:4200","memoryOrigin":"https://hivemem:18790"}'
b64url() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
legacy_token="$(b64url '{"alg":"HS256","typ":"JWT"}').$(b64url '{"sub":"hive-router","role":"admin","exp":1795392000}').fake-signature"

# ---- A migrated installation: quoted values, native machine clients and a static token. ----
migrated="$temporary/migrated"; mkdir -p -m 700 "$migrated/config"
cat > "$migrated/config/oathweave.env" <<'ENV'
COOKIE_SECRET='fake-cookie-secret-0123456789abcdef0123'
IAM_MACHINE_CLIENT_POLICIES='{"fake-portal":{"audience":"fake-portal","permissions":["fake-portal:read"],"lifetimeSeconds":3600,"rotationOwner":"fake-owner"}}'
JWT_ISSUER='hive-iam'
ENV
cat > "$migrated/config/emberpath.env" <<ENV
HIVEMEM_CA_CERT_PATH='/config/authority.pem'
HIVEMEM_INTERNAL_URL='https://hivemem:18790'
HIVE_ROUTER_MEMORY_PROXY_TOKEN='$legacy_token'
HIVE_ROUTER_SECRET='fake-router-secret-0123456789abcdef0123'
ENV
cat > "$migrated/config/hivemem.env" <<'ENV'
HIVEMEM_JWT_SECRET='fake-memory-secret-0123456789abcdef0123'
OATHWEAVE_JWKS_URL='https://oathweave:4200/api/v1/oauth/jwks'
ENV
chmod 600 "$migrated/config/"*.env
cp "$migrated/config/emberpath.env" "$temporary/ember.before"
identity=$(run_step "$migrated" memory-credential-identity "$endpoints") || fail 'The identity step failed on a migrated configuration'
jq -e '.clientId=="emberpath-hivemem" and .issuer=="hive-iam" and .localId=="hive-router" and (.changed|sort)==["emberpath.env","oathweave.env"]' <<< "$identity" >/dev/null || fail "Unexpected identity result: $identity"
secret=$(cat "$migrated/config/.credentials/emberpath-hivemem")
[[ "$secret" =~ ^[a-f0-9]{64}$ ]] || fail 'A strong secret is generated'
[[ $(stat -c %a "$migrated/config/.credentials/emberpath-hivemem") == 600 && $(stat -c %a "$migrated/config/.credentials") == 700 ]] || fail 'The secret is owner-only'
! grep -q "$secret" <<< "$identity" || fail 'The secret was printed'
[[ $(value "$migrated/config/emberpath.env" EMBERPATH_HIVEMEM_CLIENT_SECRET) == "$secret" ]] || fail 'Emberpath has the secret'
[[ $(value "$migrated/config/emberpath.env" EMBERPATH_HIVEMEM_CLIENT_ID) == emberpath-hivemem ]] || fail 'Emberpath has the client ID'
[[ $(value "$migrated/config/emberpath.env" EMBERPATH_HIVEMEM_TOKEN_URL) == https://oathweave:4200/api/v1/oauth/token ]] || fail 'Emberpath has the token endpoint'
jq -e --arg secret "$secret" '.["emberpath-hivemem"]==$secret and (keys==["emberpath-hivemem"])' <<< "$(value "$migrated/config/oathweave.env" IAM_MACHINE_CLIENT_SECRETS)" >/dev/null || fail 'Oathweave has the secret'
jq -e '.["fake-portal"].audience=="fake-portal" and .["emberpath-hivemem"]=={audience:"hivemem",permissions:["hivemem:admin:all"],lifetimeSeconds:300,rotationOwner:"hive-suite"}' <<< "$(value "$migrated/config/oathweave.env" IAM_MACHINE_CLIENT_POLICIES)" >/dev/null || fail 'The policy is added beside the native ones'
# Everything else stays, including the static token, which remains a fallback until it expires.
diff <(grep -vE '^EMBERPATH_HIVEMEM_' "$migrated/config/emberpath.env" | sort) <(sort "$temporary/ember.before") >/dev/null || fail 'Other Emberpath settings changed'
grep -q "^COOKIE_SECRET='fake-cookie-secret-0123456789abcdef0123'$" "$migrated/config/oathweave.env" || fail 'Other Oathweave settings changed'
[[ $(grep -c '^IAM_MACHINE_CLIENT_POLICIES=' "$migrated/config/oathweave.env") == 1 ]] || fail 'A setting is assigned once'
for file in oathweave emberpath; do [[ $(stat -c %a "$migrated/config/$file.env") == 600 && $(stat -c %u "$migrated/config/$file.env") == "$(id -u)" ]] || fail "$file.env keeps its owner and mode"; done
link=$(run_step "$migrated" memory-credential-link "$(jq -c '{clientId,issuer,localId}' <<< "$identity")") || fail 'The link step failed'
jq -e '.changed==["hivemem.env"]' <<< "$link" >/dev/null || fail "Unexpected link result: $link"
jq -e '.==[{issuer:"hive-iam",clientId:"emberpath-hivemem",localId:"hive-router",scopes:["admin:all"]}]' <<< "$(value "$migrated/config/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON)" >/dev/null || fail 'HiveMem links exactly this client'
! grep -rq "$secret" "$migrated/config/hivemem.env" || fail 'The memory host never receives the secret'

# A repeat, as on every later upgrade, changes nothing.
sums=$(sha256sum "$migrated/config/"*.env)
again=$(run_step "$migrated" memory-credential-identity "$endpoints")
jq -e '.changed==[] and .localId=="hive-router"' <<< "$again" >/dev/null || fail "A repeat changed something: $again"
jq -e '.changed==[]' <<< "$(run_step "$migrated" memory-credential-link "$(jq -c '{clientId,issuer,localId}' <<< "$again")")" >/dev/null || fail 'A repeated link changed something'
[[ $(sha256sum "$migrated/config/"*.env) == "$sums" ]] || fail 'A repeat rewrote a file'
# A configuration rewritten by a later migration prepare gets the same secret and principal back.
sed -i '/^EMBERPATH_HIVEMEM_/d; /^HIVE_ROUTER_MEMORY_PROXY_TOKEN=/d' "$migrated/config/emberpath.env"
sed -i '/^IAM_MACHINE_CLIENT_SECRETS=/d' "$migrated/config/oathweave.env"
restored=$(run_step "$migrated" memory-credential-identity "$endpoints" '{"schema":1}')
jq -e '.localId=="hive-router"' <<< "$restored" >/dev/null || fail 'The principal is stable'
[[ $(value "$migrated/config/emberpath.env" EMBERPATH_HIVEMEM_CLIENT_SECRET) == "$secret" ]] || fail 'The secret is stable'

# ---- A fresh installation: Emberpath serves no HiveMem-backed endpoints, so nothing is added. ----
fresh="$temporary/fresh"; mkdir -p -m 700 "$fresh/config/.initializer"
printf 'JWT_ISSUER=oathweave-fake\nIAM_BROWSER_CLIENT_POLICIES={"hivexui-hivemem":{"audience":"hivemem","permissions":["hivemem:admin:all"]}}\n' > "$fresh/config/oathweave.env"
printf 'NODE_ENV=production\nNODE_EXTRA_CA_CERTS=/config/authority.pem\n' > "$fresh/config/emberpath.env"
printf 'OATHWEAVE_JWKS_URL=https://oathweave:4200/api/v1/oauth/jwks\nHIVEMEM_OATHWEAVE_SERVICES_JSON=[{"issuer":"oathweave-other","clientId":"fake-service","localId":"fake-service","scopes":["memories:read"]}]\n' > "$fresh/config/hivemem.env"
chmod 600 "$fresh/config/"*.env
sums=$(sha256sum "$fresh/config/"*.env)
jq -e '.skipped==true' <<< "$(run_step "$fresh" memory-credential-identity "$endpoints")" >/dev/null || fail 'A fresh Emberpath gets no HiveMem identity'
[[ $(sha256sum "$fresh/config/"*.env) == "$sums" && ! -e "$fresh/config/.credentials" ]] || fail 'A skipped step changes nothing'
# ---- An operator-configured static token: unquoted values and an initializer receipt. ----
printf 'HIVE_ROUTER_MEMORY_PROXY_TOKEN=%s\n' "$(b64url '{"alg":"HS256"}').$(b64url '{"sub":"bad id","exp":1}').fake-signature" >> "$fresh/config/emberpath.env"
jq -n --arg o "$fresh/config/oathweave.env" --arg e "$fresh/config/emberpath.env" --arg m "$fresh/config/hivemem.env" '{schema:1,phase:"complete",files:{($o):"stale",($e):"stale",($m):"stale"}}' > "$fresh/config/.initializer/receipt.json"
identity=$(run_step "$fresh" memory-credential-identity "$endpoints")
jq -e '.issuer=="oathweave-fake" and .localId=="emberpath"' <<< "$identity" >/dev/null || fail "An unusable token subject falls back to emberpath: $identity"
[[ $(value "$fresh/config/emberpath.env" HIVEMEM_INTERNAL_URL) == https://hivemem:18790 && $(value "$fresh/config/emberpath.env" HIVEMEM_CA_CERT_PATH) == /config/authority.pem ]] || fail 'A fresh Emberpath learns where HiveMem is'
[[ $(value "$fresh/config/oathweave.env" IAM_BROWSER_CLIENT_POLICIES) == '{"hivexui-hivemem":{"audience":"hivemem","permissions":["hivemem:admin:all"]}}' ]] || fail 'An unquoted value is kept as it was'
run_step "$fresh" memory-credential-link "$(jq -c '{clientId,issuer,localId}' <<< "$identity")" >/dev/null
jq -e 'length==2 and .[0].clientId=="fake-service" and .[1]=={issuer:"oathweave-fake",clientId:"emberpath-hivemem",localId:"emberpath",scopes:["admin:all"]}' <<< "$(value "$fresh/config/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON)" >/dev/null || fail 'Other service links are kept'
for file in oathweave emberpath hivemem; do
  [[ $(jq -r --arg path "$fresh/config/$file.env" '.files[$path]' "$fresh/config/.initializer/receipt.json") == "$(sha256sum "$fresh/config/$file.env" | cut -d ' ' -f1)" ]] || fail "The initializer receipt records the new $file.env"
done

# ---- Refusals. ----
refused 'Product endpoints must be HTTPS' run_step "$fresh" memory-credential-identity '{"identityOrigin":"http://oathweave:4200","memoryOrigin":"https://hivemem:18790"}'
refused 'Unexpected client' run_step "$fresh" memory-credential-link '{"clientId":"another-client","issuer":"oathweave-fake","localId":"emberpath"}'
refused 'Invalid credential link' run_step "$fresh" memory-credential-link '{"clientId":"emberpath-hivemem","issuer":"oathweave-fake","localId":"bad id"}'
sed -i '/^OATHWEAVE_JWKS_URL=/d' "$fresh/config/hivemem.env"
refused 'no OATHWEAVE_JWKS_URL' run_step "$fresh" memory-credential-link '{"clientId":"emberpath-hivemem","issuer":"oathweave-fake","localId":"emberpath"}'
chmod 644 "$fresh/config/emberpath.env"
refused 'must be owner-only' run_step "$fresh" memory-credential-identity "$endpoints"
chmod 600 "$fresh/config/emberpath.env"
mv "$fresh/config/emberpath.env" "$temporary/real.env"; ln -s "$temporary/real.env" "$fresh/config/emberpath.env"
refused 'environment is missing' run_step "$fresh" memory-credential-identity "$endpoints"
rm "$fresh/config/emberpath.env"; mv "$temporary/real.env" "$fresh/config/emberpath.env"
printf 'x\n' > "$fresh/config/.credentials/emberpath-hivemem"
refused 'Invalid protected client secret' run_step "$fresh" memory-credential-identity "$endpoints"
printf "IAM_MACHINE_CLIENT_SECRETS='[]'\n" >> "$fresh/config/oathweave.env"; rm "$fresh/config/.credentials/emberpath-hivemem"
refused 'is not a JSON object' run_step "$fresh" memory-credential-identity "$endpoints"
jq -nc --arg d "$fresh" '{directory:$d,action:"memory-credential-identity",nativeMigration:{},memoryCredential:{"identityOrigin":"https://oathweave:4200","memoryOrigin":"https://hivemem:18790"},placements:{oathweave:{}}}' | bash "$script" > "$temporary/result" 2>&1 && fail 'Accepted a split identity host'
grep -q 'must share this host' "$temporary/result" || fail 'A split identity host is refused clearly'

# ---- The controller runs it on install, upgrade, migration prepare and fresh initialization. ----
grep -q 'install|upgrade) hive_memory_credential_provision' "$ROOT/scripts/suite/lifecycle.sh" || fail 'Install and upgrade provision the credential'
grep -q 'hive_memory_credential_provision' "$ROOT/scripts/suite/initialize.sh" || fail 'Fresh initialization provisions the credential'
grep -A3 'native-configure' "$ROOT/scripts/suite/migrate-native.sh" | grep -q 'hive_memory_credential_provision' || fail 'Migration provisions the credential'
grep -q 'scripts/suite/memory-credential-host.sh' "$ROOT/scripts/suite/controller.sh" || fail 'The host step is part of the controller bundle'
printf 'memory credential tests passed\n'
