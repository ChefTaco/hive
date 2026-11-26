#!/usr/bin/env bash
# hive.sh add cindertrace against synthetic installed suites (a fresh installation and one moved
# with migrate-native) and a stubbed Docker. The host step runs for real on this machine; the
# backup and the upgrade that applies the change are recorded instead of run (their lifecycle has
# its own tests, including a component added by upgrade in new-component.test.sh). Checks the
# generated configuration, the edits to existing files, the rewritten installation file, the
# journal, resumption after an interruption at each step, and the refusals.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then fail "Accepted: $*"; fi
  grep -q -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}
user="$(id -u):$(id -g)"
install="$temporary/install"
configuration="$temporary/operator/hive/installation.json"
mkdir -p "$temporary/bin" "$temporary/operator/hive"

# The release: the installed components and Cindertrace with its datastores, every service as this
# account (a non-root installation), Cindertrace with a signed schema initialization.
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
base='["hive-registry","oathweave","oathweave-redis","hivexui","ingress","emberpath","hivemem","hivemem-qdrant","hiveskills"]'
jq -n --argjson base "$base" --arg user "$user" '{schema:1,version:"0.1.0",profiles:{core:$base,full:($base+["cindertrace","cindertrace-postgres","cindertrace-redis","chattermost","chattermost-postgres"])},
  components:(($base+["cindertrace","cindertrace-postgres","cindertrace-redis","cindertrace-collector","chattermost","chattermost-postgres"])|map({key:.,value:{image:("example.com/"+.+"@sha256:"+("0"*64)),service:{user:$user,healthcheck:{test:["CMD","true"]}}}})|from_entries)} |
  .components.hivexui.kind="static-ui" | .components.ingress.kind="ingress" | .components["cindertrace-postgres"].kind="datastore" | .components["cindertrace-redis"].kind="datastore" | .components["chattermost-postgres"].kind="datastore" | .components["cindertrace-collector"].requiresLocal=["cindertrace"] |
  .components.chattermost.initialization={image:("example.com/chattermost-migrator@sha256:"+("0"*64)),command:["migrate"],verificationCommand:["validate-current"]} |
  .components.cindertrace.initialization={image:("example.com/cindertrace@sha256:"+("0"*64)),command:["node","scripts/apply-migrations.mjs"],verificationCommand:["node","scripts/apply-migrations.mjs","--verify-current"]}' > "$temporary/release.json"
source "$ROOT/scripts/suite/test-catalog.sh"; hive_test_catalog "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"

# hive.sh with the lifecycle recorded: the online backup and the upgrade that applies the change.
# HIVE_TEST_FAIL_UPGRADE makes the next upgrade fail once, as an interrupted one would.
{
  printf 'HIVE_ROOT=%q\n' "$ROOT"
  grep -vE '^(HIVE_ROOT=|hive_main )' "$ROOT/hive.sh"
  cat <<'SH'
hive_lifecycle() {
  printf '%s %s %s %s %s\n' "$1" "$HIVE_OPERATION" "${HIVE_ALLOW_MIGRATIONS:-false}" "${HIVE_ARCHIVE:-none}" "$(jq -c '.components|keys' "$HIVE_CONFIG")" >> "$HIVE_TEST_LIFECYCLE"
  if [[ "$1" == upgrade && -e "$HIVE_TEST_FAIL_UPGRADE" ]]; then rm -f -- "$HIVE_TEST_FAIL_UPGRADE"; hive_die 'Suite held for recovery (test)'; fi
}
hive_main "$@"
SH
} > "$temporary/hive.sh"
chmod 700 "$temporary/hive.sh"
hive() { "$temporary/hive.sh" "$@" --config "$configuration" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive; }

# Docker: the product image hashes the browser password into its /data mount (or fails once with
# HIVE_TEST_FAIL_HASH); the console-clients transaction answers as Oathweave would.
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HIVE_TEST_DOCKER"
case "$1" in
  info|pull) exit 0;;
  run)
    [[ "$*" == *hash-password.js* ]] || exit 99
    if [[ -e "$HIVE_TEST_FAIL_HASH" ]]; then rm -f -- "$HIVE_TEST_FAIL_HASH"; exit 1; fi
    for argument in "$@"; do
      if [[ "$argument" =~ ^type=bind,source=([^,]+),target=/data$ ]]; then
        printf '{"schema":1,"passwordHash":"$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2g"}\n' > "${BASH_REMATCH[1]}/browser-admin.json"
      fi
    done;;
  compose)
    [[ "$4 $5 $6" == "exec -T oathweave" ]] || exit 99
    # The last four arguments are the client list, the mode, the owned clients and the console
    # callback: add applies, it never only checks.
    [[ "${@: -3:1}" == apply ]] || exit 98
    printf '%s\n' "${@: -4:1}" > "$HIVE_TEST_CLIENTS"
    printf '{"createdClients":["hivexui-cindertrace"],"addedPermissions":["cindertrace:view"],"existingRecordsUnchanged":true}\n';;
  *) exit 99;;
esac
SH
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH" HIVE_TEST_LIFECYCLE="$temporary/lifecycle.log" HIVE_TEST_DOCKER="$temporary/docker.log" \
  HIVE_TEST_CLIENTS="$temporary/clients.json" HIVE_TEST_FAIL_UPGRADE="$temporary/fail-upgrade" HIVE_TEST_FAIL_HASH="$temporary/fail-hash"
env_value() { jq -Rrs --arg key "$2" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$1"; }

# An installed suite running release 0.1.0. FLAVOR fresh: set up by fresh setup, with its
# initializer record and authority. FLAVOR migrated: moved with migrate-native, with the
# migration's authority, its operator account and a renamed Oathweave environment.
fixture() { # FLAVOR
  local flavor=$1 oath_env authority
  rm -rf -- "$install" "$temporary/operator/hive/additions" "$temporary"/*.log "$HIVE_TEST_CLIENTS"
  mkdir -p "$install/config/ingress" "$install/config/oathweave" "$install/data"
  oath_env="$install/config/oathweave.env"; [[ "$flavor" == fresh ]] || oath_env="$install/config/oathweave-renamed.env"
  jq --arg root "$install" --arg env "$oath_env" --arg flavor "$flavor" '.hosts.control.directory=$root |
    .components|=with_entries(.key as $name|.value=({host:"control"}+(if $name=="hivexui" then {} elif ($name|test("-(redis|postgres|qdrant)$")) then {configDirectory:($root+"/config/"+$name)} else {envFile:($root+"/config/"+$name+".env"),configDirectory:($root+"/config/"+$name)} end))) |
    .components.oathweave.envFile=$env | .console.runtimeFile=($root+"/config/runtime.json") |
    if $flavor=="fresh" then . else del(.bootstrap) | .profile="custom" | .console.networkSubnet="10.240.0.0/24" | .console.nativeListeners=[{port:4200,component:"oathweave"}] |
      .nativeMigration={schema:1,expectedHost:"control-host",machineIdSHA256:("a"*64),source:{root:"/",serviceManager:"systemd"},browserIssuer:"https://hive.example.com/api/oathweave",
        adminAccount:{subject:"cm0migratedoperator",username:"operator",tokenFile:"/secure/hive/reset-token"}} end' "$ROOT/examples/installation.json" > "$configuration"
  chmod 600 "$configuration"
  printf '{"services":{"oathweave":{},"ingress":{},"hivexui":{}}}\n' > "$install/compose.json"
  jq -n --arg digest "$(sha256sum "$temporary/release.json" | cut -d ' ' -f1)" '{schema:1,version:"0.1.0",digest:$digest}' > "$install/receipt.json"
  # Fresh setup records a format for every release component, selected or not.
  printf '{"oathweave":"oathweave-v1","cindertrace":"cindertrace-v0","cindertrace-postgres":"cindertrace-postgres-17"}\n' > "$install/data-formats.json"
  printf 'JWT_ISSUER=oathweave-example\nIAM_BROWSER_ISSUER=https://hive.example.com/api/oathweave\nIAM_BROWSER_CLIENT_POLICIES={"hivexui-oathweave":{"audience":"oathweave","permissions":["iam:users:read"]}}\nCOOKIE_SECRET=0000\n' > "$oath_env"
  printf 'HIVE_CONSOLE_HOST=hive.example.com\nOATHWEAVE_ENDPOINT=https://oathweave:4200\n' > "$install/config/ingress.env"
  chmod 600 "$oath_env" "$install/config/ingress.env"
  jq -n '{schema:1,mode:"suite",products:{oathweave:"/api/oathweave",hivemem:"/api/hivemem"},identity:{issuer:"https://hive.example.com/api/oathweave",apiPrefix:"/api/oathweave",clients:{oathweave:"hivexui-oathweave",hivemem:"hivexui-hivemem"}}}' > "$install/config/runtime.json"
  chmod 644 "$install/config/runtime.json"
  if [[ "$flavor" == fresh ]]; then
    mkdir -p "$install/config/.initializer/keys" "$install/config/.initializer/certificates" "$install/config/.initializer/secrets"
    authority="$install/config/.initializer/keys/authority.pem"
    openssl rand -hex 32 > "$install/config/.initializer/secrets/identity-id"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$authority" >/dev/null 2>&1
    openssl req -new -x509 -key "$authority" -out "$install/config/.initializer/certificates/authority.pem" -days 30 -subj /CN=example-authority -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
    cp "$install/config/.initializer/certificates/authority.pem" "$install/config/ingress/backend-ca.pem"
    jq -n --arg o "$oath_env" --arg i "$install/config/ingress.env" --arg r "$install/config/runtime.json" '{schema:1,phase:"complete",files:{($o):"0",($i):"0",($r):"0"}}' > "$install/config/.initializer/receipt.json"
  else
    mkdir -p "$install/config/.migration/secrets"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$install/config/.migration/ca.key" >/dev/null 2>&1
    openssl req -new -x509 -key "$install/config/.migration/ca.key" -out "$install/config/.migration/ca.pem" -days 30 -subj /CN=example-authority -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
    cp "$install/config/.migration/ca.pem" "$install/config/ingress/backend-ca.pem"
  fi
  cp "$configuration" "$temporary/original.json"
}
state() { printf '%s/config/.additions/cindertrace\n' "$install"; }
journal="$temporary/operator/hive/additions/cindertrace.json"

# Unattended use needs --yes; an unknown product or a bad request is refused before anything runs.
fixture fresh
refused 'Unattended use needs --yes' hive add cindertrace
refused 'add supports chattermost, cindertrace' hive add magnus --yes
refused 'Use: add PRODUCT' hive add --yes
refused 'Use: add PRODUCT' hive add cindertrace magnus --yes
[[ ! -e "$journal" && ! -e "$HIVE_TEST_LIFECYCLE" && ! -d "$(state)" ]] && cmp -s "$configuration" "$temporary/original.json" || fail 'A refused add changed something'

# A fresh installation.
before_inode=$(stat -c %i "$install/config/runtime.json")
hive add cindertrace --yes > "$temporary/add.log" 2>&1 || { cat "$temporary/add.log" >&2; fail 'add failed'; }
mapfile -t calls < "$HIVE_TEST_LIFECYCLE"
((${#calls[@]} == 2)) || fail "Expected a backup and an upgrade: ${calls[*]}"
[[ "${calls[0]}" =~ ^backup\ backup\ false\ pre-add-cindertrace-[0-9]{14}-[0-9a-f]{8}\ \[ ]] && [[ "${calls[0]}" != *cindertrace\"* ]] || fail "The backup did not come first, before any change: ${calls[0]}"
[[ "${calls[1]}" == 'upgrade upgrade true none ["cindertrace","cindertrace-postgres","cindertrace-redis",'* ]] || fail "The change was not applied as an upgrade with migrations allowed: ${calls[1]}"
jq -e --arg root "$install" '.components.cindertrace=={host:"control",envFile:($root+"/config/cindertrace.env"),configDirectory:($root+"/config/cindertrace")} and
  .components["cindertrace-postgres"]=={host:"control",configDirectory:($root+"/config/cindertrace-postgres")} and .components["cindertrace-redis"]=={host:"control",configDirectory:($root+"/config/cindertrace-redis")}' "$configuration" >/dev/null || fail 'The installation file did not gain the components'
cmp -s <(jq 'del(.components.cindertrace,.components["cindertrace-postgres"],.components["cindertrace-redis"])' "$configuration") <(jq . "$temporary/original.json") || fail 'The installation file changed otherwise'
[[ $(stat -c %a "$configuration") == 600 ]] && cmp -s "$temporary/operator/hive/additions/cindertrace.installation-before.json" "$temporary/original.json" || fail 'The installation file is not owner-only, or its previous copy is missing'
jq -e '.phase=="complete" and .release=="0.1.0" and (.backup|startswith("pre-add-cindertrace-")) and .operator=="admin" and (.passwordFile|endswith("/secrets/security-admin-password"))' "$journal" >/dev/null || fail 'The journal is incomplete'
[[ $(stat -c %a "$journal") == 600 && $(stat -c %a "$(dirname "$journal")") == 700 ]] || fail 'The journal is not protected'
secrets="$(state)/secrets"
env="$install/config/cindertrace.env"
[[ $(stat -c %a "$env") == 600 && $(stat -c %a "$secrets/security-admin-password") == 600 ]] || fail 'Generated files are not owner-only'
[[ $(env_value "$env" CINDERTRACE_BROWSER_AUTH_ENABLED) == true && $(env_value "$env" DASHBOARD_ADMIN_USERNAME) == admin && $(env_value "$env" DASHBOARD_PUBLIC_ORIGIN) == https://hive.example.com ]] || fail 'Native browser sign-in is not configured'
[[ $(env_value "$env" DASHBOARD_ADMIN_ACCOUNT_ID) == "$(cat "$secrets/security-id")" && $(env_value "$env" DASHBOARD_ADMIN_PASSWORD_HASH) == '$argon2id$'* ]] || fail 'The local administrator is not the generated account'
env_value "$env" CINDERTRACE_OATHWEAVE_IDENTITIES_JSON | jq -e --rawfile subject "$install/config/.initializer/secrets/identity-id" --rawfile id "$secrets/security-id" \
  '.==[{issuer:"https://hive.example.com/api/oathweave",subject:($subject|rtrimstr("\n")),localUserId:($id|rtrimstr("\n")),role:"ADMIN"}]' >/dev/null || fail 'The operator link is not the explicit issuer/subject link'
[[ $(env_value "$env" DATABASE_URL) == "postgresql://cindertrace:$(cat "$secrets/security-db")@cindertrace-postgres:5432/cindertrace" && $(env_value "$env" OATHWEAVE_JWKS_URL) == https://oathweave:4200/api/v1/oauth/jwks ]] || fail 'The datastore or Oathweave settings are wrong'
[[ $(cat "$install/config/cindertrace-postgres/password") == "$(cat "$secrets/security-db")" ]] && grep -qx "requirepass $(cat "$secrets/security-redis")" "$install/config/cindertrace-redis/redis.conf" || fail 'The private datastores are not configured'
openssl verify -CAfile "$install/config/ingress/backend-ca.pem" -verify_hostname cindertrace "$install/config/cindertrace/tls.crt" >/dev/null 2>&1 || fail 'The internal certificate is not trusted by the ingress authority'
cmp -s "$install/config/cindertrace/authority.pem" "$install/config/ingress/backend-ca.pem" || fail 'Cindertrace does not trust the installation authority'
oath="$install/config/oathweave.env"
env_value "$oath" IAM_BROWSER_CLIENT_POLICIES | jq -e '.=={"hivexui-oathweave":{"audience":"oathweave","permissions":["iam:users:read"]},"hivexui-cindertrace":{"audience":"cindertrace","permissions":["cindertrace:view","cindertrace:investigate","cindertrace:admin"]}}' >/dev/null || fail 'The browser policy was not added beside the existing one'
grep -qx 'COOKIE_SECRET=0000' "$oath" && grep -qx 'JWT_ISSUER=oathweave-example' "$oath" && [[ $(stat -c %a "$oath") == 600 ]] || fail 'Other Oathweave settings changed'
[[ $(env_value "$install/config/ingress.env" CINDERTRACE_ENDPOINT) == https://cindertrace:4101 && $(env_value "$install/config/ingress.env" CINDERTRACE_TLS_NAME) == cindertrace ]] && grep -qx 'OATHWEAVE_ENDPOINT=https://oathweave:4200' "$install/config/ingress.env" || fail 'The ingress route is wrong'
jq -e '.products.cindertrace=="/api/cindertrace" and .identity.clients.cindertrace=="hivexui-cindertrace" and .products.hivemem=="/api/hivemem"' "$install/config/runtime.json" >/dev/null || fail 'runtime.json does not list Cindertrace'
[[ $(stat -c %i "$install/config/runtime.json") == "$before_inode" && $(stat -c %a "$install/config/runtime.json") == 644 ]] || fail 'runtime.json was replaced instead of rewritten in place'
for file in "$oath" "$install/config/ingress.env" "$install/config/runtime.json"; do
  jq -e --arg path "$file" --arg sha "$(sha256sum "$file" | cut -d ' ' -f1)" '.files[$path]==$sha' "$install/config/.initializer/receipt.json" >/dev/null || fail "The initializer record of $file was not moved"
done
jq -e '.=={"oathweave":"oathweave-v1"}' "$install/data-formats.json" >/dev/null || fail 'Stale formats of the new components were not removed, or others changed'
jq -e '.staleFormats=={"cindertrace":"cindertrace-v0","cindertrace-postgres":"cindertrace-postgres-17"}' "$(state)/receipt.json" >/dev/null || fail 'The removed formats are not journaled'
jq -e '.[0].id=="hivexui-cindertrace" and .[0].redirectUris==["https://hive.example.com/auth/callback"] and .[0].firstParty==true and length==1' "$HIVE_TEST_CLIENTS" >/dev/null || fail 'The console client was not created'
for name in security-admin-password security-db security-session; do
  ! grep -qF "$(cat "$secrets/$name")" "$temporary/add.log" "$journal" "$HIVE_TEST_DOCKER" || fail "A secret ($name) was printed or journaled"
done
grep -qF "$secrets/security-admin-password" "$temporary/add.log" || fail 'add did not say where the recovery password is'
# Done: a repeat is refused and changes nothing.
snapshot=$(find "$install/config" -type f -exec sha256sum {} + | sort)
refused 'Cindertrace is already installed' hive add cindertrace --yes
[[ $(find "$install/config" -type f -exec sha256sum {} + | sort) == "$snapshot" && $(wc -l < "$HIVE_TEST_LIFECYCLE") == 2 ]] || fail 'A repeated add changed something'

# Interrupted while configuring the host: nothing applied, the backup is not repeated, and the
# secrets already generated are kept.
fixture fresh
touch "$HIVE_TEST_FAIL_HASH"
refused 'could not be configured' hive add cindertrace --yes
jq -e '.phase=="backed-up"' "$journal" >/dev/null && cmp -s "$configuration" "$temporary/original.json" || fail 'A failed host step changed the installation file'
database=$(cat "$(state)/secrets/security-db")
hive add cindertrace --yes > "$temporary/resume.log" 2>&1 || { cat "$temporary/resume.log" >&2; fail 'The interrupted add did not continue'; }
grep -q 'Continue adding Cindertrace' "$temporary/resume.log" || fail 'The continuation was not announced'
[[ $(grep -c '^backup ' "$HIVE_TEST_LIFECYCLE") == 1 && $(grep -c '^upgrade ' "$HIVE_TEST_LIFECYCLE") == 1 ]] || fail 'The continuation repeated the backup'
[[ $(cat "$(state)/secrets/security-db") == "$database" && $(env_value "$install/config/cindertrace.env" DATABASE_URL) == *"$database"* ]] || fail 'The continuation rotated a secret'

# Interrupted while applying: the installation file already names Cindertrace; the repeat applies
# the same upgrade plan again, without a second backup or host step.
fixture fresh
touch "$HIVE_TEST_FAIL_UPGRADE"
refused 'Repeat the same add command' hive add cindertrace --yes
jq -e '.phase=="configured"' "$journal" >/dev/null && jq -e '.components.cindertrace!=null' "$configuration" >/dev/null || fail 'The journal does not record the configured step'
env_before=$(sha256sum "$install/config/cindertrace.env")
hive add cindertrace --yes > "$temporary/resume.log" 2>&1 || { cat "$temporary/resume.log" >&2; fail 'The interrupted upgrade did not continue'; }
[[ $(grep -c '^backup ' "$HIVE_TEST_LIFECYCLE") == 1 && $(grep -c '^upgrade upgrade true ' "$HIVE_TEST_LIFECYCLE") == 2 ]] || fail 'The continuation did not repeat exactly the upgrade'
[[ $(sha256sum "$install/config/cindertrace.env") == "$env_before" ]] && jq -e '.phase=="complete"' "$journal" >/dev/null || fail 'The continuation changed the configuration or did not complete'

# The host refuses an installation that runs another release, a store that already holds data, a
# changed generated file, and an Oathweave or ingress already set up for another Cindertrace.
fixture fresh
jq '.version="0.0.9"' "$install/receipt.json" > "$install/receipt.next"; mv "$install/receipt.next" "$install/receipt.json"
refused 'not 0.1.0' hive add cindertrace --yes
cmp -s "$configuration" "$temporary/original.json" && [[ ! -e "$install/config/cindertrace.env" ]] || fail 'A host on another release was changed'
fixture fresh
mkdir -p "$install/data/cindertrace-postgres"; touch "$install/data/cindertrace-postgres/PG_VERSION"
refused 'already holds data' hive add cindertrace --yes
fixture fresh
printf 'CINDERTRACE_ENDPOINT=https://cindertrace.example.com:4101\n' >> "$install/config/ingress.env"
refused 'routes cindertrace elsewhere' hive add cindertrace --yes
jq -e '.phase=="backed-up"' "$journal" >/dev/null && cmp -s "$configuration" "$temporary/original.json" || fail 'A refused host step was not held before the installation file'
sed -i '/^CINDERTRACE_ENDPOINT=/d' "$install/config/ingress.env"
printf 'tampered\n' >> "$install/config/cindertrace.env"
refused 'changed since an earlier attempt' hive add cindertrace --yes
fixture fresh
jq '.bootstrap.productEndpoints={}' "$configuration" > "$configuration.next"; mv "$configuration.next" "$configuration"; chmod 600 "$configuration"
refused 'istributed' hive add cindertrace --yes
fixture fresh
jq '.components.cindertrace={host:"control"}' "$configuration" > "$configuration.next"; mv "$configuration.next" "$configuration"; chmod 600 "$configuration"
refused 'already installed' hive add cindertrace --yes

# The collector the installation runs: refused until cindertrace-collector add --run prepared it,
# then recorded and applied like any other component, without a schema or console client.
fixture fresh
refused 'needs cindertrace in this installation' hive add cindertrace-collector --yes
hive add cindertrace --yes > /dev/null 2>&1 || fail 'add cindertrace failed before the collector'
jq '.services.cindertrace={}' "$install/compose.json" > "$install/compose.next"; mv "$install/compose.next" "$install/compose.json"
: > "$HIVE_TEST_LIFECYCLE"; rm -f -- "$HIVE_TEST_CLIENTS"
refused 'Prepare the collector first' hive add cindertrace-collector --yes
store="$install/config/.credentials/cindertrace-collectors"
mkdir -p "$store" "$install/config/cindertrace-collector"
cp "$install/config/cindertrace/authority.pem" "$install/config/cindertrace-collector/authority.pem"
printf "SECURITY_FUSION_COLLECTOR_ID='logs'\nLOKI_URL='https://logs.example.com:3443'\n" > "$install/config/cindertrace-collector.env"; chmod 600 "$install/config/cindertrace-collector.env"
printf '{"schema":1,"id":"logs","allowedSources":["unifi_ids"]}\n' > "$store/logs.json"
refused 'Prepare the collector first' hive add cindertrace-collector --yes
printf '{"schema":1,"id":"logs","allowedSources":["unifi_ids"],"runs":true}\n' > "$store/logs.json"
hive add cindertrace-collector --yes > "$temporary/collector.log" 2>&1 || { cat "$temporary/collector.log" >&2; fail 'add cindertrace-collector failed'; }
mapfile -t calls < "$HIVE_TEST_LIFECYCLE"
[[ "${calls[0]}" == 'backup backup false pre-add-cindertrace-collector-'* && "${calls[1]}" == 'upgrade upgrade true none '*'"cindertrace-collector"'* ]] || fail "The collector was not backed up and applied: ${calls[*]}"
jq -e --arg root "$install" '.components["cindertrace-collector"]=={host:"control",envFile:($root+"/config/cindertrace-collector.env"),configDirectory:($root+"/config/cindertrace-collector")}' "$configuration" >/dev/null || fail 'The installation file did not gain the collector'
jq -e '.phase=="complete" and .collector=="logs"' "$temporary/operator/hive/additions/cindertrace-collector.json" >/dev/null && [[ ! -e "$HIVE_TEST_CLIENTS" ]] || fail 'The collector add did not complete without a console client'
grep -q 'logs runs as component cindertrace-collector' "$temporary/collector.log" || fail 'The collector summary is missing'
refused 'Cindertrace collector is already installed' hive add cindertrace-collector --yes

# An installation moved with migrate-native: the migration's authority, the operator account it
# names and its renamed Oathweave environment; no initializer record.
fixture migrated
hive add cindertrace --yes > "$temporary/migrated.log" 2>&1 || { cat "$temporary/migrated.log" >&2; fail 'add failed on a migrated installation'; }
env_value "$install/config/cindertrace.env" CINDERTRACE_OATHWEAVE_IDENTITIES_JSON | jq -e --rawfile id "$(state)/secrets/security-id" \
  '.==[{issuer:"https://hive.example.com/api/oathweave",subject:"cm0migratedoperator",localUserId:($id|rtrimstr("\n")),role:"ADMIN"}]' >/dev/null || fail 'The migrated operator account is not linked'
[[ $(env_value "$install/config/cindertrace.env" DASHBOARD_ADMIN_USERNAME) == operator ]] || fail 'The local administrator is not the migrated operator'
env_value "$install/config/oathweave-renamed.env" IAM_BROWSER_CLIENT_POLICIES | jq -e '.["hivexui-cindertrace"].audience=="cindertrace"' >/dev/null || fail 'The renamed Oathweave environment did not gain the policy'
openssl verify -CAfile "$install/config/.migration/ca.pem" -verify_hostname cindertrace "$install/config/cindertrace/tls.crt" >/dev/null 2>&1 || fail 'The certificate is not from the migration authority'
[[ ! -e "$install/config/.initializer" ]] || fail 'add created an initializer record on a migrated installation'
# ChatterMost: its secrets, internal certificate, private PostgreSQL and environment as fresh setup
# writes them, the operator as its administrator with an Oathweave link, the browser policy, the
# ingress route and the runtime.json entry, then the same upgrade and console client.
fixture fresh
cm_state="$install/config/.additions/chattermost"; cm_journal="$temporary/operator/hive/additions/chattermost.json"
hive add chattermost --yes > "$temporary/chat.log" 2>&1 || { cat "$temporary/chat.log" >&2; fail 'add chattermost failed'; }
mapfile -t calls < "$HIVE_TEST_LIFECYCLE"
[[ "${calls[0]}" == 'backup backup false pre-add-chattermost-'* && "${calls[1]}" == 'upgrade upgrade true none ["chattermost","chattermost-postgres",'* ]] || fail "ChatterMost was not backed up and applied: ${calls[*]}"
jq -e --arg root "$install" '.components.chattermost=={host:"control",envFile:($root+"/config/chattermost.env"),configDirectory:($root+"/config/chattermost")} and .components["chattermost-postgres"]=={host:"control",configDirectory:($root+"/config/chattermost-postgres")}' "$configuration" >/dev/null || fail 'The installation file did not gain ChatterMost'
chat_env="$install/config/chattermost.env"
[[ $(env_value "$chat_env" DATABASE_URL) == "postgresql://chattermost_app:$(cat "$cm_state/secrets/chat-db")@chattermost-postgres:5432/chattermost?schema=public" ]] || fail 'The ChatterMost database setting is wrong'
[[ $(env_value "$chat_env" ADMIN_USERNAME) == admin && $(env_value "$chat_env" ADMIN_EMAIL) == admin@example.com && $(env_value "$chat_env" ADMIN_PASSWORD) == "$(cat "$cm_state/secrets/chat-admin-password")" && $(env_value "$chat_env" SERVER_URL) == https://hive.example.com ]] || fail 'The ChatterMost administrator or origin is wrong'
env_value "$chat_env" OATHWEAVE_CHAT_IDENTITIES_JSON | jq -e --rawfile id "$cm_state/secrets/chat-id" --rawfile subject "$install/config/.initializer/secrets/identity-id"   '.==[{issuer:"https://hive.example.com/api/oathweave",subject:($subject|rtrimstr("\n")),localUserId:($id|rtrimstr("\n"))}]' >/dev/null || fail 'The operator account is not linked to ChatterMost'
cmp -s "$chat_env" "$install/config/chattermost/runtime.env" && [[ $(cat "$install/config/chattermost/postgres-password") == "$(cat "$cm_state/secrets/chat-db")" && $(cat "$install/config/chattermost-postgres/password") == "$(cat "$cm_state/secrets/chat-db")" ]] || fail 'The ChatterMost datastore files are wrong'
openssl verify -CAfile "$install/config/ingress/backend-ca.pem" -verify_hostname chattermost "$install/config/chattermost/tls.crt" >/dev/null 2>&1 || fail 'The ChatterMost certificate is not trusted by the ingress authority'
env_value "$install/config/oathweave.env" IAM_BROWSER_CLIENT_POLICIES | jq -e '.["hivexui-chattermost"]=={"audience":"chattermost","permissions":["chattermost:session"]} and .["hivexui-oathweave"]!=null' >/dev/null || fail 'The ChatterMost browser policy was not added'
[[ $(env_value "$install/config/ingress.env" CHATTERMOST_ENDPOINT) == https://chattermost:8065 && $(env_value "$install/config/ingress.env" CHATTERMOST_TLS_NAME) == chattermost ]] || fail 'The ChatterMost ingress route is wrong'
jq -e '.products.chattermost=="/api/chattermost" and .identity.clients.chattermost=="hivexui-chattermost"' "$install/config/runtime.json" >/dev/null || fail 'runtime.json does not list ChatterMost'
jq -e '.[0].id=="hivexui-chattermost" and length==1' "$HIVE_TEST_CLIENTS" >/dev/null || fail 'The ChatterMost console client was not created'
jq -e '.phase=="complete" and (.passwordFile|endswith("/secrets/chat-admin-password"))' "$cm_journal" >/dev/null || fail 'The ChatterMost journal is incomplete'
! grep -q 'cindertrace-collector add' "$temporary/chat.log" || fail 'The ChatterMost summary names the Cindertrace collector'
for secret in chat-db chat-cookie chat-token chat-admin-password chat-bot; do ! grep -q -- "$(cat "$cm_state/secrets/$secret")" "$temporary/chat.log" || fail "add printed $secret"; done
refused 'ChatterMost is already installed' hive add chattermost --yes
# A migrated installation without the operator's email cannot give ChatterMost its administrator.
fixture migrated
refused 'ChatterMost needs the operator email' hive add chattermost --yes
jq '.nativeMigration.adminAccount.email="operator@example.com"' "$configuration" > "$configuration.next"; mv "$configuration.next" "$configuration"; chmod 600 "$configuration"
hive add chattermost --yes > "$temporary/chat-migrated.log" 2>&1 || { cat "$temporary/chat-migrated.log" >&2; fail 'add chattermost failed on a migrated installation'; }
[[ $(env_value "$install/config/chattermost.env" ADMIN_EMAIL) == operator@example.com && $(env_value "$install/config/chattermost.env" ADMIN_USERNAME) == operator ]] || fail 'The migrated operator is not the ChatterMost administrator'

printf 'Passed: add cindertrace and add chattermost back up first, configures the product as fresh setup does with an explicit operator link and native sign-in, edits existing files in place, records the components and applies them as an upgrade, creates the console client, resumes after interruptions without repeating finished steps or rotating secrets, refuses unsafe states, and works on fresh and migrated installations.\n'
