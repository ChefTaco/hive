#!/usr/bin/env bash
# Host side of hive.sh migrate-native, transported verbatim. Only JSON crosses the SSH
# boundary. Native files are only read until the owner runs cutover, and are never changed.
set -Eeuo pipefail
umask 077
read -r input
get() { jq -r "$1" <<< "$input"; }
directory=$(get .directory)
installation=$(get .installation)
action=$(get .action)
plan=$(get .plan)
origin=$(get .origin)
native=$(get '.nativeMigration|tojson')
nget() { jq -r "$1" <<< "$native"; }
die() { printf 'Hive migrate-native: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*" >&2; }
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ! -L "$directory" ]] || die 'Invalid installation path'
[[ "$native" != null ]] || die 'This configuration has no nativeMigration block'
root=$(nget '.source.root // "/"'); root=${root%/}
rehearsal=$(nget '.rehearsal // false')
manager=$(nget '.source.serviceManager // "systemd"')
control=$(nget '.source.controlCommand // empty')
expected_host=$(nget .expectedHost)
expected_machine=$(nget .machineIdSHA256)
fqdn=${origin#https://}; fqdn=${fqdn%%:*}
state="$directory/migration"
steps="$state/steps"
utility_image='node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54'
candidate="$directory/candidate.$plan.json"
marker="$root/etc/hive/native-retired-to-suite"
systemd_dir="$root/etc/systemd/system"
units_stop=(hive-router hive-skills hive-iam hivemem)
units_start=(hivemem hive-iam hive-router hive-skills)
has_component() { jq -e --arg name "$1" '.placements[$name]!=null' <<< "$input" >/dev/null; }
sha() { sha256sum -- "$1" | cut -d ' ' -f1; }
atomic() { local file=$1 pending; pending=$(mktemp "$file.XXXXXX"); cat > "$pending"; chmod 600 "$pending"; sync -f "$pending"; mv -T -- "$pending" "$file"; }
step_done() { [[ -f "$steps/$1.json" ]]; }
mark_step() { jq -n --arg step "$1" --arg at "$(date -u +%FT%TZ)" --arg plan "$plan" --argjson detail "${2:-null}" '{schema:1,step:$step,at:$at,plan:$plan,detail:$detail}' | atomic "$steps/$1.json"; }

# Systemd EnvironmentFile semantics: the last assignment of a name wins and one pair of
# surrounding quotes is removed. A duplicated secret therefore keeps its effective value.
env_json() {
  local file
  for file in "$@"; do [[ -f "$file" ]] || die "Missing native environment file: ${file#"$root"}"; cat -- "$file"; printf '\n'; done |
    jq -Rs --arg sq "'" 'split("\n")|map(select(test("^[ \t]*[A-Za-z_][A-Za-z0-9_]*="))|sub("^[ \t]+";"")|index("=") as $i|{key:.[:$i],value:(.[$i+1:]|sub("[ \t]+$";"")|if test("^\".*\"$") then .[1:-1]|gsub("\\\\\"";"\"") elif (startswith($sq) and endswith($sq) and length>1) then .[1:-1] else . end)})|from_entries'
}
native_path() { printf '%s%s\n' "$root" "$1"; }
iam_env() { env_json "$(native_path /opt/hive-iam/.env)" "$(native_path /var/lib/hive-iam-keyring/current/keyring.env)"; }
router_env() { env_json "$(native_path /opt/hive-router/shared/.env)"; }
memory_env() { jq -n '{HIVEMEM_STORAGE_PATH:"/var/opt/hivemem",HIVEMEM_TS_TLS_CERT_FILE:"/opt/hivemem/certs/server.crt",HIVEMEM_TS_TLS_KEY_FILE:"/opt/hivemem/certs/server.key"}' | jq -c --argjson file "$(env_json "$(native_path /opt/hivemem/.env)")" '.+$file'; }
skills_present() { [[ -f "$(native_path /opt/hive-skills/shared/.env)" ]]; }
skills_env() { env_json "$(native_path /opt/hive-skills/shared/.env)"; }
# Native relative paths resolve from each unit's working directory.
resolve_from() { case "$2" in /*) native_path "$2";; *) native_path "$1/${2#./}";; esac; }

check_binding() {
  local actual_host actual_machine archive
  if [[ "$rehearsal" == true ]]; then
    # source.root is the restored state/ tree; its recovery/ manifest sits beside it.
    [[ -n "$root" && -f "$(dirname -- "$root")/recovery/manifest.json" ]] || die 'A rehearsal source needs a restored recovery tree'
    actual_host=$(jq -r .host "$(dirname -- "$root")/recovery/manifest.json")
    actual_machine=$(jq -r .machineId "$(dirname -- "$root")/recovery/manifest.json")
  else
    [[ -z "$root" ]] || die 'Production migration reads the native files in place; source.root must be /'
    [[ "$manager" == systemd ]] || die 'Production migration manages systemd units'
    actual_host=$(hostname -s)
    actual_machine=$(cat /etc/machine-id)
  fi
  [[ "${actual_host,,}" == "${expected_host,,}" ]] || die "This configuration is for $expected_host, but the source is $actual_host. Refusing: independent installations are never mixed."
  [[ $(printf '%s' "$actual_machine" | sha256sum | cut -d ' ' -f1) == "$expected_machine" ]] || die 'The source machine identity differs from this configuration. Refusing: independent installations are never mixed.'
  archive=$(nget '.source.archive // empty')
  if [[ -n "$archive" ]]; then
    [[ $(tar -xOzf "$archive" recovery/manifest.json | jq -r .host) == "$actual_host" ]] || die 'This archive belongs to another installation. Refusing.'
  fi
  if [[ -f "$state/binding.json" ]]; then
    jq -e --arg host "$actual_host" --arg machine "$expected_machine" --arg id "$installation" '.host==$host and .machineIdSHA256==$machine and .installation==$id' "$state/binding.json" >/dev/null || die 'This installation directory was prepared for another source. Refusing.'
  fi
  if [[ -f "$directory/installation.json" ]]; then
    jq -e --arg id "$installation" '.installation==$id' "$directory/installation.json" >/dev/null || die 'This installation directory belongs to another installation. Refusing.'
  fi
}

# ---- Native service control. Nothing here runs before cutover or rollback. ----
service() {
  local verb=$1 unit=$2
  if [[ "$manager" == command ]]; then
    [[ "$rehearsal" == true && -x "$control" ]] || die 'A control command is accepted only for rehearsals'
    "$control" "$verb" "$unit"; return
  fi
  systemctl "$verb" "$unit"
}
service_active() {
  if [[ "$manager" == command ]]; then "$control" is-active "$1" >/dev/null 2>&1; else systemctl is-active --quiet "$1"; fi
}
installed_units() {
  local unit
  for unit in "$@"; do
    if [[ "$unit" == hive-skills ]]; then skills_present && printf '%s\n' "$unit"; else printf '%s\n' "$unit"; fi
  done
  return 0
}
qdrant_control() {
  local name; name=$(nget '.source.qdrantContainer // empty')
  if [[ "$manager" == command ]]; then "$control" "$1" qdrant; return; fi
  [[ -n "$name" ]] || die 'source.qdrantContainer is required'
  docker "$1" "$name" >/dev/null
}
# Every native start path stays closed while the suite owns the ports: a boot, a timer,
# a fleet renewal restart or an operator. The units keep their exact content and removing
# the marker reopens them.
retire_units() {
  [[ "$manager" == systemd ]] || return 0
  local unit
  install -d -m 755 "$(dirname -- "$marker")"
  printf 'installation=%s\n' "$installation" > "$marker"
  for unit in $(installed_units "${units_stop[@]}"); do
    install -d -m 755 "$systemd_dir/$unit.service.d"
    printf '[Unit]\nConditionPathExists=!%s\n' "${marker#"$root"}" > "$systemd_dir/$unit.service.d/90-retired-to-suite.conf"
    systemctl disable --quiet "$unit"
  done
  if systemctl is-enabled --quiet hive-iam-tls.timer 2>/dev/null; then
    printf 'enabled\n' > "$state/iam-tls-timer.state"
    systemctl disable --now --quiet hive-iam-tls.timer
  fi
  systemctl daemon-reload
}
restore_units() {
  [[ "$manager" == systemd ]] || return 0
  local unit
  rm -f -- "$marker"
  for unit in $(installed_units "${units_stop[@]}"); do
    rm -f -- "$systemd_dir/$unit.service.d/90-retired-to-suite.conf"
    systemctl enable --quiet "$unit"
  done
  if [[ -f "$state/iam-tls-timer.state" ]]; then
    systemctl enable --now --quiet hive-iam-tls.timer
    rm -f -- "$state/iam-tls-timer.state"
  fi
  systemctl daemon-reload
}
native_store_files() {
  local base
  for base in /opt/hive-iam/prisma/iam.db /opt/hive-router/shared/data/router.db /opt/hive-skills/shared/data/registry.sqlite; do
    [[ -f "$(native_path "$base")" ]] || continue
    native_path "$base"; [[ ! -s "$(native_path "$base-wal")" ]] || native_path "$base-wal"
  done
}
native_hashes() { native_store_files | while IFS= read -r file; do jq -n --arg name "${file#"$root"}" --arg sha "$(sha "$file")" '{key:$name,value:$sha}'; done | jq -s from_entries; }

# ---- Pinned data helper. ----
data_tool() {
  # data_tool NETWORK USER REQUEST_JSON [docker mount arguments...]
  local network=$1 user=$2 request=$3; shift 3
  docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --network "$network" --user "$user" \
    --tmpfs /tmp:mode=1777 "$@" --entrypoint node "$utility_image" --no-warnings --input-type=module -e "$(get .dataTool | base64 -d)" "$request"
}
# Credentials reach the helper through a protected file, never its command line.
data_tool_secret() {
  # data_tool_secret VARIABLE SECRET_FILE NETWORK USER REQUEST_JSON [docker arguments...]
  local variable=$1 secret=$2 network=$3 user=$4 request=$5 file result=0; shift 5
  file=$(mktemp "$state/tool-env.XXXXXX")
  { printf '%s=' "$variable"; cat -- "$secret"; } > "$file"
  data_tool "$network" "$user" "$request" --env-file "$file" "$@" || result=$?
  rm -f -- "$file"
  return "$result"
}
service_user() { jq -er --arg name "$1" '.bootstrapServiceUsers[$name]' <<< "$input"; }
image_of() { jq -er --arg name "$1" '.bootstrapImages[$name]' <<< "$input"; }

# ---- Inventory and plan. ----
listener_owner() {
  ss -H -ltnp "sport = :$1" 2>/dev/null | sed -nE 's/.*\(\("([^"]+)".*/\1/p' | head -1
}
unit_of_port() {
  local pid; pid=$(ss -H -ltnp "sport = :$1" 2>/dev/null | sed -nE 's/.*pid=([0-9]+).*/\1/p' | head -1)
  [[ -z "$pid" ]] || ps -o unit= -p "$pid" 2>/dev/null | head -1
}
certificate_json() {
  local file=$1
  [[ -f "$file" ]] || { jq -n --arg path "${file#"$root"}" '{path:$path,present:false}'; return; }
  jq -n --arg path "${file#"$root"}" --arg subject "$(openssl x509 -in "$file" -noout -subject 2>/dev/null | sed 's/^subject=//')" \
    --arg issuer "$(openssl x509 -in "$file" -noout -issuer 2>/dev/null | sed 's/^issuer=//')" \
    --arg expires "$(openssl x509 -in "$file" -noout -enddate 2>/dev/null | cut -d= -f2)" \
    --arg names "$(openssl x509 -in "$file" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')" \
    --argjson days "$(( ( $(date -d "$(openssl x509 -in "$file" -noout -enddate | cut -d= -f2)" +%s) - $(date +%s) ) / 86400 ))" \
    '{path:$path,present:true,subject:$subject,issuer:$issuer,expires:$expires,names:$names,daysLeft:$days}'
}
# Native listener -> suite upstream -> the certificate its clients already see.
listeners_json() {
  local router iam memory port cert key
  router=$(router_env); iam=$(iam_env); memory=$(memory_env)
  {
    jq -c '{port:(.ADMIN_PORT|tonumber),component:"ingress",role:"console and native admin paths",upstream:null,certificate:.TLS_CERT_PATH,privateKey:.TLS_KEY_PATH}' <<< "$router"
    jq -c '{port:(.API_PORT|tonumber),component:"emberpath",role:"model API",upstream:"emberpath:4020",certificate:.TLS_CERT_PATH,privateKey:.TLS_KEY_PATH}' <<< "$router"
    jq -c '{port:((.PORT // "4200")|tonumber),component:"oathweave",role:"identity API",upstream:"oathweave:4200",certificate:.TLS_CERT_PATH,privateKey:.TLS_KEY_PATH,relative:"/opt/hive-iam"}' <<< "$iam"
    jq -c '{port:((.HIVEMEM_WEB_PORT // "18790")|tonumber),component:"hivemem",role:"memory API",upstream:"hivemem:18790",certificate:.HIVEMEM_TS_TLS_CERT_FILE,privateKey:.HIVEMEM_TS_TLS_KEY_FILE}' <<< "$memory"
    if skills_present; then skills_env | jq -c '{port:((.HIVE_SKILLS_PORT // "4030")|tonumber),component:"hiveskills",role:"skills API",upstream:"hiveskills:4030",certificate:.HIVE_SKILLS_TLS_CERT_FILE,privateKey:.HIVE_SKILLS_TLS_KEY_FILE}'; fi
  } | jq -s .
}
identity_candidates() {
  sqlite3 -readonly -json "file:$(native_path /opt/hive-iam/prisma/iam.db)?mode=ro" "
    SELECT u.id,u.username,u.active,u.mfaEnabled,u.lastLoginAt,u.passwordChangedAt,u.lockedUntil,
           (SELECT group_concat(r.name) FROM user_role_assignments a JOIN roles r ON r.id=a.roleId WHERE a.userId=u.id) AS roles,
           (SELECT count(*) FROM webauthn_credentials w WHERE w.userId=u.id) AS passkeys,
           (SELECT maxAgeDays FROM password_policies WHERE isDefault=1 LIMIT 1) AS maxAgeDays
    FROM users u ORDER BY u.username"
}
local_accounts() {
  local router_accounts
  router_accounts=$(sqlite3 -readonly -json "file:$(native_path /opt/hive-router/shared/data/router.db)?mode=ro" 'SELECT id,username FROM AdminUser ORDER BY username')
  jq -n --argjson emberpath "${router_accounts:-[]}" --argjson skills "$(if skills_present; then skills_env | jq -c '(.HIVE_SKILLS_ADMIN_USERS // "")|split(",")|map(select(length>0))'; else printf '[]'; fi)" \
    '{emberpath:$emberpath,hiveskills:$skills,hivemem:"Agent and workspace IDs; no human account mapping exists"}'
}
# Only explicit, approved entries for a subject and local account that exist here apply.
# No email, username or display name is ever compared. Everything else needs the owner.
links_review() {
  local candidates locals reviewed='null' file
  candidates=$(identity_candidates); locals=$(local_accounts)
  file=$(jq -r '.reviewedLinks // "null"' <<< "$input")
  [[ "$file" == null ]] || reviewed=$file
  jq -n --argjson users "${candidates:-[]}" --argjson locals "$locals" --argjson reviewed "$reviewed" --arg installation "$installation" --argjson hasSkills "$(jq -n --argjson v "$(skills_present && printf true || printf false)" '$v')" '
    ($users|map(.id)) as $subjects |
    def known($link):
      if $link.product=="emberpath" then ($locals.emberpath|map(.id)|index($link.localId))!=null
      elif $link.product=="hiveskills" then ($locals.hiveskills|index($link.localId))!=null
      elif $link.product=="hivemem" then ($link.localId|type=="string" and test("^[a-z0-9_-]{2,32}$"))
      else false end;
    (if $reviewed==null then [] elif $reviewed.installation!=$installation then error("The reviewed links file belongs to another installation") else ($reviewed.links // []) end) as $links |
    (if $reviewed==null then [] else ($reviewed.grants // []) end) as $grants |
    {applied:[$links[]|select(.approved==true and (.subject as $s|$subjects|index($s))!=null and known(.))|{product,subject,localId}],
     refused:[$links[]|select(.approved==true and ((.subject as $s|$subjects|index($s))==null or (known(.)|not)))|{product,subject,localId,reason:(if (.subject as $s|$subjects|index($s))==null then "This subject does not exist in this installation" else "This local account does not exist in this product" end)}],
     pending:[$links[]|select(.approved!=true)|{product,subject,localId}],
     grants:[$grants[]|select(.approved==true and .role=="SUITE_ADMIN" and (.subject as $s|$subjects|index($s))!=null)|{subject,role}],
     refusedGrants:[$grants[]|select(.approved==true and (.role!="SUITE_ADMIN" or (.subject as $s|$subjects|index($s))==null))|{subject,role}]} |
    .missing=([["emberpath"],["hivemem"],(if $hasSkills then ["hiveskills"] else [] end)]|add|map(. as $product|select(([$links[]|select(.approved==true and .product==$product)]|length)==0)|"No approved link for "+.))'
}
action_plan() {
  check_binding
  local units='[]' unit listeners found extras candidates review admin
  for unit in $(installed_units "${units_start[@]}"); do
    if service_active "$unit"; then units=$(jq -c --arg unit "$unit" '.+[{unit:$unit,active:true}]' <<< "$units"); else units=$(jq -c --arg unit "$unit" '.+[{unit:$unit,active:false}]' <<< "$units"); fi
  done
  listeners=$(listeners_json)
  found=$(jq -r '.[]|[.port,.component,.role]|@tsv' <<< "$listeners" | while IFS=$'\t' read -r port component role; do
    jq -n --argjson port "$port" --arg component "$component" --arg role "$role" --arg unit "$(unit_of_port "$port" || true)" '{port:$port,suite:$component,role:$role,nativeUnit:$unit}'
  done | jq -s .)
  # Other services share these hosts. Their ports are never taken over.
  extras=$(for port in 4100 9090; do jq -n --argjson port "$port" --arg owner "$(listener_owner "$port" || true)" --arg unit "$(unit_of_port "$port" || true)" 'select($owner!="" or $unit!="")|{port:$port,owner:$owner,unit:$unit,action:"Not Hive: left alone"}'; done | jq -s .)
  candidates=$(identity_candidates); review=$(links_review)
  local source_problems='[]' container
  if [[ "$manager" == systemd ]]; then
    container=$(nget '.source.qdrantContainer // empty')
    if [[ -z "$container" ]] || ! docker inspect "$container" >/dev/null 2>&1; then source_problems='["Set source.qdrantContainer to the native Qdrant container"]'; fi
  fi
  admin=$(jq -n --argjson users "$candidates" --argjson chosen "$(nget '.adminAccount // null')" '
    {chosen:$chosen,found:($chosen!=null and ($users|any(.id==$chosen.subject and .username==$chosen.username))),candidates:($users|map(. + {passwordExpired:(if .maxAgeDays>0 and .passwordChangedAt then ((.passwordChangedAt[:19]+"Z"|fromdateiso8601)+.maxAgeDays*86400)<now else false end)}))}')
  jq -n --arg installation "$installation" --arg host "$expected_host" --argjson units "$units" --argjson listeners "$found" --argjson extras "$extras" \
    --argjson certificates "$(jq -r '.[].certificate' <<< "$listeners" | sort -u | while IFS= read -r path; do certificate_json "$(resolve_from /opt/hive-iam "$path")"; done | jq -s .)" \
    --argjson sourceProblems "$source_problems" --argjson admin "$admin" --argjson review "$review" --argjson locals "$(local_accounts)" --arg free "$(df -Pm -- "$(dirname -- "$directory")" | awk 'NR==2 {print $4}')" \
    --arg memoryMiB "$(du -sm --exclude=models -- "$(native_path /var/opt/hivemem)" | cut -f1)" --arg iamMiB "$(du -sm -- "$(native_path /opt/hive-iam/prisma)" "$(native_path /opt/hive-iam/audit-logs)" | awk '{sum+=$1} END {print sum}')" \
    '{schema:1,installation:$installation,host:$host,bindingVerified:true,nativeUnits:$units,nativeListeners:$listeners,otherServicesLeftAlone:$extras,certificates:$certificates,administrator:$admin,identity:{localAccounts:$locals,links:$review},dataMiB:{memory:($memoryMiB|tonumber),identity:($iamMiB|tonumber)},freeMiB:($free|tonumber),modelFilesCopied:false,
      decisions:([(if $admin.chosen==null or ($admin.found|not) then "Confirm the administrator account for the initial password reset: set nativeMigration.adminAccount" else empty end)]+$review.missing+($review.refused|map(.product+" link refused: "+.reason))+($review.pending|map("Pending "+.product+" link "+.localId))+(if ($review.grants|length)==0 then ["No approved SUITE_ADMIN grant: the administrator can sign in but existing roles carry no product permissions"] else [] end)+($certificates|map(select(.present==true and .daysLeft<45)|"Certificate "+.path+" expires in "+(.daysLeft|tostring)+" days: renew it before cutover and schedule tls-refresh"))+$sourceProblems),
      steps:["prepare: stage images and configuration, copy data online, boot the copy with no ports, change nothing native","cutover: close native start paths, stop native writers, take the final copy, apply product migrations, start the suite on the native ports, verify, issue the administrator reset token","rollback: stop the suite, report writes made since cutover, reopen and start the native services on unchanged data"]}'
}

# ---- Configuration. ----
write_env() {
  # write_env COMPONENT PATH JSON. Single quotes keep values literal in Compose env files.
  local component=$1 file=$2 json=$3 user temporary
  jq -e --arg sq "'" 'all(to_entries[]; (.value|type)=="string" and (.value|contains($sq)|not) and (.value|contains("\n")|not))' <<< "$json" >/dev/null || die "A native value for $component cannot be represented in an environment file"
  user=$(service_user "$component")
  temporary=$(mktemp "$directory/config/.env.XXXXXX")
  jq -r --arg sq "'" 'to_entries|sort_by(.key)[]|.key+"="+$sq+.value+$sq' <<< "$json" > "$temporary"
  chown "$user" "$temporary"; chmod 600 "$temporary"; mv -T -- "$temporary" "$file"
}
publish_copy() {
  # publish_copy COMPONENT DESTINATION SOURCE [MODE]
  local component=$1 destination=$2 source=$3 mode=${4:-600} user temporary
  [[ -f "$source" ]] || die "Missing native file: ${source#"$root"}"
  user=$(service_user "$component")
  install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$(dirname -- "$destination")"
  temporary=$(mktemp "$directory/config/.copy.XXXXXX")
  cat -- "$source" > "$temporary"; chown "$user" "$temporary"; chmod "$mode" "$temporary"; mv -T -- "$temporary" "$destination"
}
ensure_secret() {
  local path="$directory/config/.migration/secrets/$1"
  [[ -f "$path" ]] || (umask 077; openssl rand -hex 32 > "$path.pending"; mv -T -- "$path.pending" "$path")
  cat -- "$path"
}
internal_certificates() {
  local base="$directory/config/.migration" component user
  if [[ ! -f "$base/ca.pem" ]]; then
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$base/ca.key" >/dev/null 2>&1
    openssl req -new -x509 -key "$base/ca.key" -out "$base/ca.pem" -days 3650 -subj "/CN=$installation-internal-authority" -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
  fi
  for component in oathweave emberpath hivemem hiveskills; do
    has_component "$component" || continue
    user=$(service_user "$component")
    if [[ ! -f "$base/$component.key" ]]; then
      openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$base/$component.key" >/dev/null 2>&1
      printf 'subjectAltName=DNS:%s,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' "$component" > "$base/$component.ext"
      openssl req -new -key "$base/$component.key" -out "$base/$component.csr" -subj "/CN=$component" >/dev/null 2>&1
      openssl x509 -req -in "$base/$component.csr" -CA "$base/ca.pem" -CAkey "$base/ca.key" -set_serial "0x$(openssl rand -hex 16)" -days 825 -extfile "$base/$component.ext" -out "$base/$component.pem" >/dev/null 2>&1
    fi
    publish_copy "$component" "$directory/config/$component/tls.key" "$base/$component.key"
    publish_copy "$component" "$directory/config/$component/tls.crt" "$base/$component.pem"
    publish_copy "$component" "$directory/config/$component/authority.pem" "$base/ca.pem"
  done
  publish_copy ingress "$directory/config/ingress/backend-ca.pem" "$base/ca.pem"
}
ingress_fragments() {
  local listeners=$1 config="$directory/config/ingress" port upstream certificate key
  local proxy_memory='import product_backend {$HIVEMEM_TLS_NAME} "__Host-oathweave_sso|iam_refresh|hive_router_admin|hive_skills_session|cindertrace_session|MMSID|MMUSERID|MMCSRF"'
  local proxy_models='import verified_backend {$EMBERPATH_TLS_NAME}'
  {
    printf '# Generated by hive.sh migrate-native. Paths the native Router served on its console port.\n'
    printf 'handle /v1/* {\n\treverse_proxy {$HIVEMEM_ENDPOINT} {\n\t\t%s\n\t}\n}\n' "$proxy_memory"
    printf 'handle /dashboard {\n\treverse_proxy {$HIVEMEM_ENDPOINT} {\n\t\t%s\n\t}\n}\n' "$proxy_memory"
    printf '@native_health path /health /health/live /health/ready /health/dependencies\n'
    printf 'handle @native_health {\n\treverse_proxy {$EMBERPATH_ENDPOINT} {\n\t\t%s\n\t}\n}\n' "$proxy_models"
    printf '@native_admin {\n\tpath /api/*\n\tnot path /api/oathweave/* /api/emberpath/* /api/hivemem/* /api/hiveskills/* /api/cindertrace/* /api/chattermost/* /api/magnus/* /api/registry/* /api/emberfold/* /api/v4/* /api/v1/security-fusion/*\n}\n'
    printf 'handle @native_admin {\n\treverse_proxy {$EMBERPATH_ENDPOINT} {\n\t\t%s\n\t}\n}\n' "$proxy_models"
  } > "$state/native-routes.caddy"
  : > "$state/native-listeners.caddy"
  local renewed="$directory/config/.migration/identity-leaf.pem"
  while IFS=$'\t' read -r port upstream certificate key; do
    publish_copy ingress "$config/native/$port.crt" "$(resolve_from /opt/hive-iam "$certificate")"
    # A leaf this suite renewed stays in use until the native one is newer.
    if [[ "$upstream" == oathweave:* && -f "$renewed" ]] && openssl x509 -in "$renewed" -noout -checkend 604800 >/dev/null 2>&1; then
      publish_copy ingress "$config/native/$port.crt" "$renewed"
    fi
    publish_copy ingress "$config/native/$port.key" "$(resolve_from /opt/hive-iam "$key")"
    [[ -n "$upstream" && "$upstream" != null ]] || continue
    # Requests pass through unchanged: every native client keeps its URL, certificate and headers.
    printf ':%s {\n\ttls /config/native/%s.crt /config/native/%s.key\n\treverse_proxy https://%s {\n\t\timport verified_backend %s\n\t}\n\thandle_errors {\n\t\trespond "Service unavailable" 503\n\t}\n}\n' \
      "$port" "$port" "$port" "$upstream" "${upstream%%:*}" >> "$state/native-listeners.caddy"
  done < <(jq -r '.[]|[.port,(.upstream // "null"),.certificate,.privateKey]|@tsv' <<< "$listeners")
  publish_copy ingress "$config/native-routes.caddy" "$state/native-routes.caddy"
  publish_copy ingress "$config/native-listeners.caddy" "$state/native-listeners.caddy"
  get .ingressTemplate | base64 -d > "$state/Caddyfile"
  publish_copy ingress "$config/Caddyfile" "$state/Caddyfile"
  local console_port; console_port=$(jq -r 'map(select(.upstream==null))[0].port' <<< "$listeners")
  publish_copy ingress "$config/console.crt" "$config/native/$console_port.crt"
  publish_copy ingress "$config/console.key" "$config/native/$console_port.key"
}
action_configure() {
  check_binding
  install -d -m 700 "$directory" "$directory/config" "$directory/config/.migration" "$directory/config/.migration/secrets" "$state" "$steps" "$directory/bin"
  [[ ! -f "$directory/receipt.json" ]] || die 'The suite is already active here; roll back before preparing again'
  jq -n --arg host "$expected_host" --arg machine "$expected_machine" --arg id "$installation" '{schema:1,installation:$id,host:$host,machineIdSHA256:$machine}' | atomic "$state/binding.json"
  rm -f -- "$directory/deployment-inputs.$plan.json"
  local iam router memory skills='{}' listeners issuer subnet review policies common redis_password qdrant_key native_trusted
  iam=$(iam_env); router=$(router_env); memory=$(memory_env)
  ! skills_present || skills=$(skills_env)
  listeners=$(listeners_json)
  jq -e --argjson wanted "$(jq -c '[.console.nativeListeners[].port,.console.httpsPort]|sort' <<< "$input")" 'map(.port)|sort==$wanted' <<< "$listeners" >/dev/null || die 'console.nativeListeners and console.httpsPort must list exactly the native listeners found on this host'
  jq -e 'all(.[];(.certificate|type)=="string" and (.privateKey|type)=="string")' <<< "$listeners" >/dev/null || die 'A native listener has no certificate configuration'
  issuer=$(nget .browserIssuer); subnet=$(get .console.networkSubnet)
  review=$(links_review)
  jq -e '(.refused|length)==0 and (.refusedGrants|length)==0' <<< "$review" >/dev/null || die "Reviewed identity data was refused: $(jq -c '.refused+.refusedGrants' <<< "$review")"
  jq . <<< "$review" | atomic "$state/links.json"
  redis_password=$(ensure_secret redis-password); qdrant_key=$(ensure_secret qdrant-key)
  local secrets="$directory/config/.migration/secrets"
  common=$(jq -nc '{NODE_ENV:"production",HIVE_HOME:"/data",HIVE_AUTO_MIGRATE:"false",HIVE_AUTO_UPGRADE:"false",HIVE_UPDATE_CHECK:"false",NODE_EXTRA_CA_CERTS:"/config/authority.pem"}')
  [[ "$rehearsal" != true ]] || common=$(jq -c '.+{HIVE_REHEARSAL:"true"}' <<< "$common")
  internal_certificates
  # An external Magnus (deployment/FULL.md#external-magnus) gets the console's Magnus client too.
  local external_magnus external_host
  external_magnus=$(jq -r '.external.magnus.url // empty' <<< "$input")
  external_host=${external_magnus#https://}; external_host=${external_host%%:*}
  policies=$(jq -nc --arg redirect "$origin/auth/callback" --argjson skills "$(has_component hiveskills && printf true || printf false)" --arg magnus "$external_magnus" '
    [{id:"hivexui-oathweave",audience:"oathweave",permissions:["iam:users:read","iam:users:write","iam:users:delete","iam:roles:read","iam:roles:write","iam:sa:read","iam:sa:write","iam:sa:delete","iam:clients:read","iam:clients:write","iam:sessions:revoke","iam:audit:read","iam:system:login","iam:policy:write"]},
     {id:"hivexui-emberpath",audience:"emberpath",permissions:["router:providers:read","router:providers:write","router:routing:read","router:routing:write","router:testing:read","router:testing:write","router:keys:read","router:keys:write","router:settings:read","router:settings:write","router:admin:read","router:admin:write"]},
     {id:"hivexui-hivemem",audience:"hivemem",permissions:["hivemem:admin:all"]}]+
    (if $skills then [{id:"hivexui-hiveskills",audience:"hiveskills",permissions:["hiveskills:admin"]}] else [] end)+
    (if $magnus!="" then [{id:"hivexui-magnus",audience:"magnus",permissions:["magnus:view","magnus:operate","magnus:admin"]}] else [] end)|map(.+{redirectUris:[$redirect],firstParty:true})')
  jq . <<< "$policies" | atomic "$state/browser-clients.json"
  local link_env
  link_env() { jq -c --arg product "$1" --arg issuer "$issuer" --argjson generation "${2:-null}" '[.applied[]|select(.product==$product)|{issuer:$issuer,subject,localId}+(if $generation!=null then {credentialGeneration:$generation} else {} end)]' <<< "$review"; }
  local oath_env ember_env mem_env
  native_trusted=$(jq -r '.TRUSTED_PROXY_IPS // ""' <<< "$iam")
  oath_env=$(jq -c --argjson common "$common" --arg issuer "$issuer" --arg origin "$origin" --arg fqdn "$fqdn" --rawfile redisPassword "$secrets/redis-password" --argjson policies "$policies" --arg trusted "${native_trusted:+$native_trusted,}$subnet" --arg installation "$installation" '
    with_entries(select(.key|test("^(JWT_ISSUER|JWT_ACCESS_TTL|JWT_REFRESH_TTL|COOKIE_SECRET|IAM_AGENT_SECRET|REDIS_PREFIX|AUDIT_MAX_AGE_DAYS|RATE_LIMIT_[A-Z_]+|MAX_REQUEST_BODY_BYTES|IAM_MACHINE_CLIENT_POLICIES)$"))) + $common + {
      HOST:"0.0.0.0",PORT:"4200",DATABASE_URL:"file:/data/iam/iam.db",IAM_DATA_DIR:"/data/iam",AUDIT_LOG_DIR:"/data/iam/audit-logs",REDIS_URL:("redis://:"+($redisPassword|rtrimstr("\n"))+"@oathweave-redis:6379"),
      JWT_PRIVATE_KEY_PATH:"/data/keyring/active-private.pem",JWT_PUBLIC_KEY_PATH:"/data/keyring/active-public.pem",
      JWT_PREVIOUS_PUBLIC_KEY_PATHS:((.JWT_PREVIOUS_PUBLIC_KEY_PATHS // "")|split(",")|map(select(length>0)|"/data/keyring/previous/"+(split("/")|last))|join(",")),
      IAM_BROWSER_ISSUER:$issuer,IAM_BROWSER_AUTHORIZATION_URL:($origin+"/auth/authorize"),IAM_BROWSER_API_BASE_URL:($origin+"/api/oathweave"),
      IAM_BROWSER_CLIENT_POLICIES:($policies|map({key:.id,value:{audience,permissions}})|from_entries|tojson),
      CORS_ORIGIN:$origin,WEBAUTHN_RP_ID:$fqdn,WEBAUTHN_RP_ORIGIN:$origin,WEBAUTHN_RP_NAME:"Oathweave",
      IAM_RECOVERY_OUTBOX_DIRECTORY:"/data/iam/recovery-outbox",TRUSTED_PROXY_IPS:$trusted,TLS_CERT_PATH:"/config/tls.crt",TLS_KEY_PATH:"/config/tls.key",
      IAM_ENROLLMENT_INSTALLATION_ID:$installation,
      IAM_ENROLLMENT_PRODUCTS_JSON:({emberpath:{url:"https://emberpath:9443/api",caFile:"/config/authority.pem"},hivemem:{url:"https://hivemem:18790/v1",caFile:"/config/authority.pem"}}|tojson)}' <<< "$iam")
  write_env oathweave "$directory/config/oathweave.env" "$oath_env"
  ember_env=$(jq -c --argjson common "$common" --arg issuer "$issuer" --argjson links "$(link_env emberpath)" --arg rehearsal "$rehearsal" '
    with_entries(select((.key|test("^(HIVE_ROUTER_[A-Z_]+|HIVE_TYPESAFE_AI_[A-Z_]+|MAX_[A-Z_]+|CAPTURE_[A-Z_]+|LOG_LEVEL|REQUIRE_TLS|PROMETHEUS_PREFIX|DEFAULT_TRACE_RETENTION_DAYS|PUBLIC_API_URL|PUBLIC_ADMIN_URL|HIVE_UI_PUBLIC_URL|HIVEMEM_PUBLIC_URL|HIVE_IAM_PUBLIC_URL)$")) and .key!="HIVE_ROUTER_OS_AUTH_COMMAND")) + $common + {
      HOST:"0.0.0.0",API_HOST:"0.0.0.0",ADMIN_HOST:"0.0.0.0",API_PORT:"4020",ADMIN_PORT:"9443",
      DATABASE_URL:"file:/data/router/router.db",DATA_DIR:"/data/router",TRACE_DIR:"/data/router/traces",
      TLS_CERT_PATH:"/config/tls.crt",TLS_KEY_PATH:"/config/tls.key",
      HIVE_IAM_INTERNAL_URL:"https://oathweave:4200",HIVEMEM_INTERNAL_URL:"https://hivemem:18790",
      HIVE_ROUTER_IAM_CA_CERT_PATH:"/config/authority.pem",HIVEMEM_CA_CERT_PATH:"/config/authority.pem",
      OATHWEAVE_ISSUER:$issuer,OATHWEAVE_JWKS_URL:"https://oathweave:4200/api/v1/oauth/jwks",OATHWEAVE_USERINFO_URL:"https://oathweave:4200/api/v1/oauth/userinfo",
      EMBERPATH_OATHWEAVE_IDENTITIES_JSON:($links|tojson)} +
      # Accounts move to Oathweave: Emberpath sign-in uses it, never PAM on the host.
      (if ((.HIVE_ROUTER_IAM_CLIENT_ID // "")|length)>0 and ((.HIVE_ROUTER_IAM_CLIENT_SECRET // "")|length)>=24 then {HIVE_ROUTER_AUTH_MODE:"iam-oidc"} else {} end) + (if $rehearsal=="true" then {HIVE_ROUTER_DECISION_MODE:"off",OTEL_SDK_DISABLED:"true"} else {} end) | if $rehearsal=="true" then del(.HIVE_ROUTER_OPENROUTER_KEY,.HIVE_TYPESAFE_AI_KEY) else . end' <<< "$router")
  write_env emberpath "$directory/config/emberpath.env" "$ember_env"
  mem_env=$(jq -c --argjson common "$common" --arg issuer "$issuer" --arg origin "$origin" --rawfile qdrant "$secrets/qdrant-key" --argjson links "$(link_env hivemem 0)" --arg rehearsal "$rehearsal" '
    with_entries(select(.key|test("^HIVEMEM_(JWT_[A-Z_]+|RENEWAL_[A-Z_]+|ADMIN_TOKEN|METRICS_[A-Z_]+|VECTOR_DIM|DEDUP_[A-Z_]+|PRUNE_[A-Z_]+|CONFIDENCE_[A-Z_]+|IMPORTANCE_[A-Z_]+|DASHBOARD_[A-Z_]+|TOKEN_EXPIRE_HOURS|LOG_LEVEL|ADMIN_OS_USERS)$"))) + $common + {
      HIVEMEM_TS_CORE_HOST:"0.0.0.0",HIVEMEM_TS_CORE_PORT:"18790",HIVEMEM_STORAGE_PATH:"/data/memory",HIVEMEM_TS_PERSISTENCE:"qdrant",
      HIVEMEM_QDRANT_URL:"http://hivemem-qdrant:6333",QDRANT_API_KEY:($qdrant|rtrimstr("\n")),
      HIVEMEM_TS_TLS_CERT_FILE:"/config/tls.crt",HIVEMEM_TS_TLS_KEY_FILE:"/config/tls.key",
      HIVEMEM_ADMIN_OS_LOGIN_ENABLED:"false",HIVEMEM_CORS_ORIGINS:(((.HIVEMEM_CORS_ORIGINS // "")|split(",")|map(select(length>0)))+[$origin]|unique|join(",")),
      OATHWEAVE_ISSUER:$issuer,OATHWEAVE_JWKS_URL:"https://oathweave:4200/api/v1/oauth/jwks",OATHWEAVE_USERINFO_URL:"https://oathweave:4200/api/v1/oauth/userinfo",
      HIVEMEM_OATHWEAVE_IDENTITIES_JSON:($links|tojson)} + (if $rehearsal=="true" then {HIVEMEM_WORKER_ENABLED:"false"} else {} end)' <<< "$memory")
  write_env hivemem "$directory/config/hivemem.env" "$mem_env"
  if has_component hiveskills; then
    write_env hiveskills "$directory/config/hiveskills.env" "$(jq -c --argjson common "$common" --arg issuer "$issuer" --arg alias "$(jq -r '.nativeMigration.dataAliases.hiveskills // "/data/skills"' <<< "$input")" --argjson links "$(link_env hiveskills)" --arg rehearsal "$rehearsal" '
      with_entries(select(.key|test("^HIVE_SKILLS_(SESSION_SECRET|ADMIN_USERS|PUBLIC_URL)$"))) + $common + {
        HIVE_SKILLS_HOST:"0.0.0.0",HIVE_SKILLS_PORT:"4030",HIVE_SKILLS_DATA_DIR:$alias,HIVE_SKILLS_TLS_CERT_FILE:"/config/tls.crt",HIVE_SKILLS_TLS_KEY_FILE:"/config/tls.key",
        OATHWEAVE_ISSUER:$issuer,OATHWEAVE_JWKS_URL:"https://oathweave:4200/api/v1/oauth/jwks",OATHWEAVE_USERINFO_URL:"https://oathweave:4200/api/v1/oauth/userinfo",
        HIVESKILLS_OATHWEAVE_IDENTITIES_JSON:($links|tojson)} + (if $rehearsal=="true" then {HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED:"false"} else {} end)' <<< "$skills")"
  fi
  printf 'bind 0.0.0.0\nprotected-mode yes\ndir /data\nappendonly yes\nappendfsync everysec\nrequirepass %s\n' "$redis_password" > "$state/redis.conf"
  publish_copy oathweave-redis "$directory/config/oathweave-redis/redis.conf" "$state/redis.conf"; rm -f -- "$state/redis.conf"
  printf 'log_level: WARN\ntelemetry_disabled: true\nstorage:\n  storage_path: /data/storage\n  snapshots_path: /data/snapshots\nservice:\n  host: 0.0.0.0\n  http_port: 6333\n  api_key: %s\n' "$qdrant_key" > "$state/qdrant.yaml"
  publish_copy hivemem-qdrant "$directory/config/hivemem-qdrant/qdrant.yaml" "$state/qdrant.yaml"; rm -f -- "$state/qdrant.yaml"
  ingress_fragments "$listeners"
  # The console listens for every name the native Router accepted on this port.
  write_env ingress "$directory/config/ingress.env" "$(jq -nc --argjson skills "$(has_component hiveskills && printf true || printf false)" --arg magnus "$external_magnus" --arg magnusHost "$external_host" '{HIVE_CONSOLE_HOST:":8443",XDG_CONFIG_HOME:"/data/config",XDG_DATA_HOME:"/data",
    OATHWEAVE_ENDPOINT:"https://oathweave:4200",OATHWEAVE_TLS_NAME:"oathweave",EMBERPATH_ENDPOINT:"https://emberpath:9443",EMBERPATH_TLS_NAME:"emberpath",
    EMBERPATH_API_ENDPOINT:"https://emberpath:4020",EMBERPATH_API_TLS_NAME:"emberpath",HIVEMEM_ENDPOINT:"https://hivemem:18790",HIVEMEM_TLS_NAME:"hivemem"}+
    (if $skills then {HIVESKILLS_ENDPOINT:"https://hiveskills:4030",HIVESKILLS_TLS_NAME:"hiveskills"} else {} end)+
    # An external Magnus is verified against the ingress image system trust store, on its own name.
    (if $magnus!="" then {MAGNUS_ENDPOINT:$magnus,MAGNUS_TLS_NAME:$magnusHost,MAGNUS_TRUST_FILE:"/etc/ssl/certs/ca-certificates.crt"} else {} end)')"
  jq -n --arg issuer "$issuer" --arg installation "$installation" --argjson skills "$(has_component hiveskills && printf true || printf false)" --arg magnus "$external_magnus" '
    {schema:1,mode:"suite",enrollmentInstallationId:$installation,products:{oathweave:"/api/oathweave",emberpath:"/api/emberpath",hivemem:"/api/hivemem"},identity:{issuer:$issuer,apiPrefix:"/api/oathweave",clients:{oathweave:"hivexui-oathweave",emberpath:"hivexui-emberpath",hivemem:"hivexui-hivemem"}}}|
    if $skills then .products.hiveskills="/api/hiveskills"|.identity.clients.hiveskills="hivexui-hiveskills" else . end |
    if $magnus!="" then .products.magnus="/api/magnus"|.identity.clients.magnus="hivexui-magnus" else . end' > "$directory/config/runtime.json"
  chmod 644 "$directory/config/runtime.json"
  # The owner's password script. It holds no secret and talks to the native identity port.
  local verify_address admin_username ca_file
  verify_address=$(nget '.verifyAddress // "127.0.0.1"')
  admin_username=$(nget '.adminAccount.username // empty')
  ca_file="$directory/migration/identity-ca.pem"
  cp -- "$(native_path /opt/hive-iam/certs/ca.crt)" "$ca_file"; chmod 644 "$ca_file"
  if [[ -n "$admin_username" ]]; then
    jq -n --arg installation "$installation" --arg username "$admin_username" --arg url "https://$fqdn:4200/api/v1/auth/reset-password" --arg resolve "$fqdn:4200:$verify_address" --arg ca "$ca_file" '{installation:$installation,username:$username,url:$url,resolve:$resolve,caFile:$ca}' | atomic "$state/reset-target.json"
    chmod 644 "$state/reset-target.json"
    printf '%s\n' "$(get .adminScript)" | base64 -d > "$directory/bin/hive-set-admin-password"
    chmod 700 "$directory/bin/hive-set-admin-password"
  fi
  mark_step configured "$(jq -c '{applied:(.applied|length),missing:.missing}' <<< "$review")"
  log 'Configuration staged; native files were only read'
}

# ---- Data copies. The online and final copies share this path. ----
copy_tree() {
  # copy_tree SOURCE DESTINATION USER [tar exclude patterns...]
  local source=$1 destination=$2 user=$3; shift 3
  local -a excludes=()
  local pattern
  for pattern in "$@"; do excludes+=(--exclude="$pattern"); done
  install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$destination"
  tar -C "$source" "${excludes[@]}" --warning=no-file-changed -cf - . | tar -C "$destination" --no-same-owner -xf -
  chown -R "$user" "$destination"
}
sqlite_copy() {
  local source=$1 destination=$2 user=$3
  [[ ! -e "$destination" ]] || die "Refusing to overwrite a copy: ${destination##*/}"
  # With every writer stopped and no WAL, read the file as immutable: this writes nothing
  # beside the native database, not even an empty WAL.
  if [[ "${FINAL_COPY:-false}" == true && ! -s "$source-wal" ]]; then
    sqlite3 "file:$source?immutable=1" ".backup '$destination'"
  else
    sqlite3 "file:$source?mode=ro" ".backup '$destination'"
  fi
  [[ $(sqlite3 "$destination" 'PRAGMA integrity_check' | head -1) == ok ]] || die "Copied database failed its integrity check: ${destination##*/}"
  chown "$user" "$destination"; chmod 600 "$destination"
}
source_network() { nget '.source.dataNetwork // "host"'; }
qdrant_source() { nget '.source.qdrantUrl // "http://127.0.0.1:6333"'; }
qdrant_snapshots() {
  local destination=$1 url name route snapshot file index=0
  url=$(qdrant_source)
  install -d -m 755 "$destination"
  : > "$destination/index.tsv"
  curl -fsS "$url/collections" | jq -r '.result.collections[].name' | sort | while IFS= read -r name; do
    route="$url/collections/$(jq -rn --arg name "$name" '$name|@uri')/snapshots"
    snapshot=$(curl -fsS -X POST "$route" | jq -er .result.name)
    file="qdrant-$index.snapshot"
    curl -fsS -o "$destination/$file" "$route/$(jq -rn --arg name "$snapshot" '$name|@uri')"
    curl -fsS -X DELETE "$route/$(jq -rn --arg name "$snapshot" '$name|@uri')" >/dev/null
    chmod 644 "$destination/$file"
    printf '%s\t%s\n' "$name" "$file" >> "$destination/index.tsv"
    index=$((index+1))
  done
}
qdrant_inventory() { data_tool_secret MIGRATE_API_KEY "$directory/config/.migration/secrets/qdrant-key" "$1" "$2" '{"command":"qdrant-inventory","url":"http://127.0.0.1:6333"}'; }
restore_qdrant() {
  # Native snapshots go in through the product's own restore, never by copying its files.
  local snapshots=$1 data=$2 name=$3 user image collection file count=0
  local -a arguments=()
  user=$(service_user hivemem-qdrant); image=$(image_of hivemem-qdrant)
  install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$data"
  while IFS=$'\t' read -r collection file; do arguments+=(--snapshot "/snapshots/$file:$collection"); count=$((count+1)); done < "$snapshots/index.tsv"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network none --user "$user" --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:mode=1777 --workdir /data \
    --mount "type=bind,source=$data,target=/data" --mount "type=bind,source=$directory/config/hivemem-qdrant,target=/config,readonly" --mount "type=bind,source=$snapshots,target=/snapshots,readonly" \
    --entrypoint /qdrant/qdrant "$image" --config-path /config/qdrant.yaml "${arguments[@]}" >/dev/null
  local attempt result=''
  for attempt in $(seq 1 60); do
    if result=$(qdrant_inventory "container:$name" "$user" 2>/dev/null); then
      [[ $(jq -r .totalCollections <<< "$result") == "$count" ]] && break
    fi
    result=''; sleep 2
  done
  [[ -n "$result" ]] || { docker logs --tail 20 "$name" >&2 || true; docker rm -f "$name" >/dev/null 2>&1 || true; die 'Vector snapshots could not be restored'; }
  docker stop --time 30 "$name" >/dev/null; docker rm "$name" >/dev/null
  printf '%s\n' "$result"
}
restore_redis() {
  # restore_redis DUMP_FILE DATA_DIR CONTAINER INVENTORY_FILE. The inventory holds digests only.
  local dump_file=$1 data=$2 name=$3 inventory=$4 user image result attempt work
  user=$(service_user oathweave-redis); image=$(image_of oathweave-redis); work=$(dirname -- "$dump_file")
  install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$data"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network none --user "$user" --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:mode=1777 \
    --mount "type=bind,source=$data,target=/data" --mount "type=bind,source=$directory/config/oathweave-redis,target=/config,readonly" "$image" redis-server /config/redis.conf >/dev/null
  chmod 644 "$dump_file"
  result=''
  for attempt in $(seq 1 15); do
    if result=$(data_tool_secret MIGRATE_REDIS_PASSWORD "$directory/config/.migration/secrets/redis-password" "container:$name" "$user" "$(jq -nc --arg input "/work/$(basename -- "$dump_file")" '{command:"redis-import",url:"redis://127.0.0.1:6379",input:$input,inventory:"/work/inventory.json"}')" --mount "type=bind,source=$work,target=/work" 2>/dev/null); then break; fi
    result=''; sleep 1
  done
  rm -f -- "$dump_file"
  docker stop --time 30 "$name" >/dev/null; docker rm "$name" >/dev/null
  [[ -n "$result" ]] || die 'Redis records could not be restored'
  mv -T -- "$work/inventory.json" "$inventory"
  printf '%s\n' "$result"
}
# Builds complete suite data under $1 from the native stores. Native files stay as they are.
# The Redis inventory of the copy is written beside it, as redis-inventory.json.
copy_stores() {
  local destination=$1 label=$2 iam user keyring previous redis_url prefix result_qdrant result_redis
  iam=$(iam_env)
  [[ ! -e "$destination" ]] || rm -rf -- "$destination"
  install -d -m 755 "$destination"
  user=$(service_user oathweave)
  install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$destination/oathweave" "$destination/oathweave/iam" "$destination/oathweave/keyring" "$destination/oathweave/keyring/previous"
  sqlite_copy "$(native_path /opt/hive-iam/prisma/iam.db)" "$destination/oathweave/iam/iam.db" "$user"
  local audit_directory
  audit_directory=$(resolve_from /opt/hive-iam "$(jq -r '.AUDIT_LOG_DIR // "./audit-logs"' <<< "$iam")")
  if [[ -d "$audit_directory" ]]; then copy_tree "$audit_directory" "$destination/oathweave/iam/audit-logs" "$user"; fi
  keyring=$(native_path /var/lib/hive-iam-keyring/current)
  install -m 600 -o "${user%:*}" -g "${user#*:}" "$keyring/active-private.pem" "$destination/oathweave/keyring/active-private.pem"
  install -m 600 -o "${user%:*}" -g "${user#*:}" "$keyring/active-public.pem" "$destination/oathweave/keyring/active-public.pem"
  if [[ -d "$keyring/previous" ]]; then
    for previous in "$keyring"/previous/*; do [[ ! -f "$previous" ]] || install -m 600 -o "${user%:*}" -g "${user#*:}" "$previous" "$destination/oathweave/keyring/previous/"; done
  fi
  user=$(service_user emberpath)
  install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$destination/emberpath" "$destination/emberpath/router"
  sqlite_copy "$(native_path /opt/hive-router/shared/data/router.db)" "$destination/emberpath/router/router.db" "$user"
  [[ ! -f "$(native_path /opt/hive-router/shared/data/.hive-router-schema.json)" ]] || install -m 600 -o "${user%:*}" -g "${user#*:}" "$(native_path /opt/hive-router/shared/data/.hive-router-schema.json)" "$destination/emberpath/router/"
  [[ ! -d "$(native_path /opt/hive-router/shared/data/traces)" ]] || copy_tree "$(native_path /opt/hive-router/shared/data/traces)" "$destination/emberpath/router/traces" "$user"
  user=$(service_user hivemem)
  install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$destination/hivemem"
  # Model weights stay where they are. No model data moves into the suite.
  copy_tree "$(native_path /var/opt/hivemem)" "$destination/hivemem/memory" "$user" ./models ./backups ./writer.lock ./migration.lock './lib/__pycache__'
  if has_component hiveskills; then
    user=$(service_user hiveskills)
    install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$destination/hiveskills"
    copy_tree "$(native_path /opt/hive-skills/shared/data)" "$destination/hiveskills" "$user" ./backups ./registry.sqlite ./registry.sqlite-wal ./registry.sqlite-shm ./migration.lock
    sqlite_copy "$(native_path /opt/hive-skills/shared/data/registry.sqlite)" "$destination/hiveskills/registry.sqlite" "$user"
    # Absolute archive paths in the store resolve through the same path inside the container.
    jq -e '.nativeMigration.dataAliases.hiveskills=="/opt/hive-skills/shared/data"' <<< "$input" >/dev/null || die 'HiveSkills needs its native data path preserved: set nativeMigration.dataAliases.hiveskills'
  fi
  user=$(service_user ingress); install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$destination/ingress"
  log "$label: vector snapshots"
  rm -rf -- "$state/work-$label"; install -d -m 755 "$state/work-$label"
  qdrant_snapshots "$state/work-$label/snapshots"
  result_qdrant=$(restore_qdrant "$state/work-$label/snapshots" "$destination/hivemem-qdrant" "hive-migrate-$installation-qdrant-$label")
  log "$label: Redis records"
  redis_url=$(nget '.source.redisUrl // empty')
  [[ -n "$redis_url" ]] || redis_url=$(jq -r '.REDIS_URL' <<< "$iam" | sed 's#localhost#127.0.0.1#')
  prefix=$(jq -r '.REDIS_PREFIX // "hive-iam"' <<< "$iam")
  install -d -m 777 "$state/work-$label/redis"
  printf '%s' "$redis_url" > "$state/work-$label/source-url"
  data_tool_secret MIGRATE_REDIS_URL "$state/work-$label/source-url" "$(source_network)" "$(service_user oathweave-redis)" "$(jq -nc --arg prefix "$prefix" '{command:"redis-export",prefix:$prefix,output:"/out/redis.json"}')" --mount "type=bind,source=$state/work-$label/redis,target=/out" >/dev/null
  result_redis=$(restore_redis "$state/work-$label/redis/redis.json" "$destination/oathweave-redis" "hive-migrate-$installation-redis-$label" "$(dirname -- "$destination")/redis-inventory.json")
  rm -rf -- "$state/work-$label"
  jq -n --argjson qdrant "$result_qdrant" --argjson redis "$result_redis" '{qdrant:$qdrant,redis:$redis}'
}
database_files() { # name, relative path in data dir, owning component
  printf 'oathweave\toathweave/iam/iam.db\n'; printf 'emberpath\temberpath/router/router.db\n'
  if has_component hiveskills; then printf 'hiveskills\thiveskills/registry.sqlite\n'; fi
}
baseline() {
  # baseline DATA_ROOT OUTPUT_DIR
  local data=$1 output=$2 component path user
  install -d -m 777 "$output"
  while IFS=$'\t' read -r component path; do
    user=$(service_user "$component")
    data_tool none "$user" "$(jq -nc --arg output "/out/$component.json" --arg file "/db/$(basename -- "$path")" '{command:"sqlite-state",file:$file,output:$output}')" \
      --mount "type=bind,source=$(dirname -- "$data/$path"),target=/db" --mount "type=bind,source=$output,target=/out" >/dev/null
  done < <(database_files)
  data_tool none "$(service_user oathweave)" '{"command":"accounts","file":"/db/iam.db"}' --mount "type=bind,source=$data/oathweave/iam,target=/db" | atomic "$output/accounts.json"
  chmod 711 "$output"
}
# Product-owned migrations run on the copy only, with their own verified backups.
product_migrations() {
  local file=$1 component output pending approval
  local -a flags
  mapfile -t datastores < <(jq -r '.services|keys[]|select(.=="oathweave-redis" or .=="hivemem-qdrant")' "$file")
  docker compose -f "$file" up -d --wait --wait-timeout 120 "${datastores[@]}"
  for component in oathweave emberpath hivemem hiveskills; do
    has_component "$component" || continue
    output=$(docker compose -f "$file" run --no-deps --rm -T "$component" migrate --plan --json 2>"$state/migrate-plan.err") || { tail -3 "$state/migrate-plan.err" >&2; die "$component could not plan its migrations"; }
    output=$(grep '^{' <<< "$output" | tail -1) || die "$component returned no migration plan"
    pending=$(jq -c '.pending // []' <<< "$output")
    approval=$(jq -r '.approval // empty' <<< "$output")
    if [[ "$pending" != '[]' ]]; then
      log "$component: applying $(jq length <<< "$pending") product migrations to the copy"
      flags=(--backup-dir /data/migration-backups)
      [[ -z "$approval" ]] || flags+=(--confirm-plan "$approval")
      docker compose -f "$file" run --no-deps --rm -T "$component" migrate "${flags[@]}" >&2
    fi
  done
}
# Adds only what the console needs. Existing users, roles and client rows are compared
# byte for byte; a difference aborts before anything is committed.
identity_additions() {
  local file=$1 clients grants code
  clients=$(cat "$state/browser-clients.json")
  grants=$(jq -c .grants "$state/links.json")
  # shellcheck disable=SC2016
  code='import {prisma} from "/app/apps/iam-core/dist/db/client.js";import assert from "node:assert/strict";
const p=JSON.parse(process.argv[1]);
const snapshot=async(tx)=>JSON.stringify([await tx.user.findMany({orderBy:{id:"asc"}}),await tx.role.findMany({orderBy:{id:"asc"}}),await tx.client.findMany({where:{id:{notIn:p.clients.map(c=>c.id)}},orderBy:{id:"asc"}}),await tx.userRoleAssignment.findMany({where:{role:{name:{not:"SUITE_ADMIN"}}},orderBy:[{userId:"asc"},{roleId:"asc"}]})]);
const before=await snapshot(prisma);const permissions=[...new Set(p.clients.flatMap(c=>c.permissions))];let createdClients=0,grantsApplied=0;
await prisma.$transaction(async(tx)=>{
 let role=await tx.role.findUnique({where:{name:"SUITE_ADMIN"}});
 if(role)assert.deepEqual(JSON.parse(role.permissions).sort(),[...permissions].sort(),"SUITE_ADMIN already exists with other permissions");
 else role=await tx.role.create({data:{name:"SUITE_ADMIN",label:"Suite Administrator",description:"Explicit console resource grants added by the native migration",isSystem:false,permissions:JSON.stringify(permissions)}});
 for(const c of p.clients){const existing=await tx.client.findUnique({where:{id:c.id}});if(existing){assert.equal(existing.clientType,"public");continue;}await tx.client.create({data:{id:c.id,name:c.id,description:"HiveXUI "+c.audience+" browser client",clientType:"public",active:true,firstParty:c.firstParty,redirectUris:JSON.stringify(c.redirectUris),grantTypes:JSON.stringify(["authorization_code"]),allowedIps:"[]"}});createdClients++;}
 for(const g of p.grants){const user=await tx.user.findUnique({where:{id:g.subject}});assert(user,"Reviewed grant names an unknown subject");const existing=await tx.userRoleAssignment.findFirst({where:{userId:g.subject,roleId:role.id}});if(!existing){await tx.userRoleAssignment.create({data:{userId:g.subject,roleId:role.id}});grantsApplied++;}}
});
const after=await prisma.$transaction(async(tx)=>{const roles=await tx.role.findMany({where:{name:{not:"SUITE_ADMIN"}},orderBy:{id:"asc"}});return JSON.stringify([await tx.user.findMany({orderBy:{id:"asc"}}),roles,await tx.client.findMany({where:{id:{notIn:p.clients.map(c=>c.id)}},orderBy:{id:"asc"}}),await tx.userRoleAssignment.findMany({where:{role:{name:{not:"SUITE_ADMIN"}}},orderBy:[{userId:"asc"},{roleId:"asc"}]})]);});
const strip=(text)=>{const value=JSON.parse(text);value[1]=value[1].filter(r=>r.name!=="SUITE_ADMIN");return JSON.stringify(value);};
assert.equal(after,strip(before),"Existing identity records changed");
console.log(JSON.stringify({createdClients,grantsApplied,existingRecordsUnchanged:true}));await prisma.$disconnect();process.exit(0);'
  docker compose -f "$file" run --no-deps --rm -T --entrypoint node oathweave --input-type=module -e "$code" "$(jq -nc --argjson clients "$clients" --argjson grants "$grants" '{clients:$clients,grants:$grants}')" | grep '^{' | tail -1
}
compare_store() {
  # compare_store DATA_ROOT BASELINE_DIR ALLOWED_JSON_ARRAY [OPTIONS_JSON] -> JSON per component
  # OPTIONS {"credentials":true} compares only credential tables, tolerating the live columns.
  local data=$1 base=$2 allowed=$3 options=${4:-'{}'} component path
  while IFS=$'\t' read -r component path; do
    data_tool none "$(service_user "$component")" "$(jq -nc --arg file "/db/$(basename -- "$path")" --arg component "$component" --argjson allowed "$allowed" --argjson options "$options" '{command:"sqlite-compare",before:("/base/"+$component+".json"),file:$file,component:$component,allowedToChange:$allowed}+$options')" \
      --mount "type=bind,source=$(dirname -- "$data/$path"),target=/db" --mount "type=bind,source=$base,target=/base,readonly" | jq -c --arg component "$component" '{($component):.}' || true
  done < <(database_files) | jq -s --argjson want "$(database_files | cut -f1 | jq -Rsc 'split("\n")|map(select(length>0))')" '
    # A store that could not be read is a violation, never a silent pass.
    (add // {}) as $got | reduce $want[] as $name ($got; if has($name) then . else .[$name]={changed:{},violations:["the store could not be read"]} end)'
}

# ---- Prepare: everything here is read-only for the native installation. ----
action_registry_login() {
  local server username password_file
  server=$(nget '.imageRegistry.server // empty')
  [[ -n "$server" ]] || return 0
  username=$(nget .imageRegistry.username); password_file=$(nget .imageRegistry.passwordFile)
  [[ -f "$password_file" && ! -L "$password_file" ]] || die 'The image registry credential file must be a regular file'
  (( (8#$(stat -c %a -- "$password_file") & 077)==0 )) || die 'The image registry credential file must be owner-only'
  install -d -m 700 "$directory/.docker-config"
  DOCKER_CONFIG="$directory/.docker-config" docker login "$server" --username "$username" --password-stdin < "$password_file" >/dev/null
}
action_registry_logout() {
  local server; server=$(nget '.imageRegistry.server // empty')
  [[ -z "$server" ]] || DOCKER_CONFIG="$directory/.docker-config" docker logout "$server" >/dev/null 2>&1 || true
  rm -rf -- "$directory/.docker-config"
}
action_dry_run() {
  check_binding
  [[ -f "$candidate" ]] || die 'Stage the release first'
  docker pull --quiet "$utility_image" >/dev/null
  local staged="$state/staged" project="dryrun-$installation" copied additions compared started_at
  compose_file="$state/dry-run.compose.json"
  started_at=$(date +%s)
  copied=$(copy_stores "$staged/data" online)
  baseline "$staged/data" "$staged/baseline"
  jq --arg project "$project" --arg data "$directory/data/" --arg staged "$staged/data/" --argjson subnets "$(nget '.dryRunSubnets // {}')" '
    .name=$project | .networks=(.networks|to_entries|map(.key as $name|.value=(.value+{internal:true}|del(.ipam)|if $subnets[$name] then .ipam={config:[{subnet:$subnets[$name]}]} else . end))|from_entries) |
    .services|=with_entries(.value|=(del(.ports,.restart)|(if (.networks|type)=="array" then .networks|=map(select(.!="edge")) else . end)|
      .environment=((.environment // {})+{HIVE_REHEARSAL:"true",HIVEMEM_WORKER_ENABLED:"false",HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED:"false"})|
      .volumes|=map(if .source|startswith($data) then .source=($staged+.source[($data|length):]) else . end))) | .networks|=del(.edge)' "$candidate" > "$compose_file"
  cleanup_done=false
  dry_run_down() { [[ "$cleanup_done" == true ]] || docker compose -f "$compose_file" down --timeout 45 >/dev/null 2>&1 || true; cleanup_done=true; }
  trap dry_run_down EXIT
  local user
  user=$(service_user hive-registry); install -d -m 700 -o "${user%:*}" -g "${user#*:}" "$staged/data/hive-registry"
  product_migrations "$compose_file"
  additions=$(identity_additions "$compose_file")
  docker compose -f "$compose_file" up -d --wait --wait-timeout 240 oathweave emberpath hivemem $(has_component hiveskills && printf hiveskills) ingress
  docker compose -f "$compose_file" stop --timeout 45 >/dev/null
  compared=$(compare_store "$staged/data" "$staged/baseline" '["sessions","refresh_tokens","audit_events","clients","roles","RuntimeSetting","AdminSession","registry_migrations","_prisma_migrations","Trace","QuotaBucket","QuotaLedgerState","QuotaReservation","ApiDocEntry"]')
  dry_run_down; trap - EXIT
  jq -e 'all(.[];(.violations|length)==0)' <<< "$compared" >/dev/null || { jq -c 'map_values(.violations)' <<< "$compared" >&2; die 'The dry run changed preserved records; see the violations above'; }
  jq -n --argjson copied "$copied" --argjson additions "$additions" --argjson compared "$compared" --argjson seconds "$(( $(date +%s)-started_at ))" '{copied:$copied,identityAdditions:$additions,comparison:$compared,seconds:$seconds}' | atomic "$state/dry-run.json"
  mark_step dry-run "$(jq -c '{seconds,copied}' "$state/dry-run.json")"
  rm -rf -- "$staged/data" "$staged/redis-inventory.json"
  log "Dry run passed in $(jq -r .seconds "$state/dry-run.json") seconds; staged copy removed"
}

# ---- Cutover. Every step records itself so a repeat continues where it stopped. ----
action_stop_native() {
  check_binding
  step_done dry-run || die 'Prepare has not passed for this exact plan; run prepare first'
  if step_done native-stopped; then log 'Native writers already stopped'; return; fi
  [[ -f "$candidate" ]] || die 'The staged release is missing; run prepare first'
  jq -n --arg at "$(date -u +%FT%TZ)" '{schema:1,startedAt:$at}' | atomic "$state/cutover-started.json"
  retire_units
  local unit
  for unit in $(installed_units "${units_stop[@]}"); do service stop "$unit"; done
  for unit in $(installed_units "${units_stop[@]}"); do ! service_active "$unit" || die "$unit did not stop"; done
  # Native bytes as they stand with every writer stopped. Rollback requires these exact bytes.
  native_hashes | atomic "$state/native-stopped.json"
  mark_step native-stopped
  log 'Native writers stopped'
}
action_capture() {
  check_binding
  step_done native-stopped || die 'Native writers are not stopped'
  if step_done captured; then log 'Final copy already taken'; return; fi
  local work="$state/capture" copied
  FINAL_COPY=true
  copied=$(copy_stores "$work/data" final)
  qdrant_control stop
  mark_step native-qdrant-stopped
  baseline "$work/data" "$work/baseline"
  # Vectors are counted after the product restore, while nothing can write to them.
  local component target
  [[ ! -d "$directory/data" ]] || find "$directory/data" -mindepth 1 -maxdepth 1 -type f -exec false {} + || die 'Unexpected file in the data directory'
  install -d -m 700 "$directory/data"
  for component in oathweave oathweave-redis emberpath hivemem hivemem-qdrant hiveskills ingress; do
    [[ -d "$work/data/$component" ]] || continue
    target="$directory/data/$component"
    [[ ! -e "$target" ]] || die "Refusing to overwrite suite data: $component. Roll back first."
    mv -T -- "$work/data/$component" "$target"
  done
  mv -T -- "$work/redis-inventory.json" "$work/baseline/redis.json"
  mv -T -- "$work/baseline" "$state/baseline"
  rm -rf -- "$work"
  mark_step captured "$copied"
  log 'Final copy taken'
}
action_migrate_products() {
  check_binding
  step_done captured || die 'The final copy has not been taken'
  if step_done products-migrated; then return; fi
  product_migrations "$candidate"
  local additions
  additions=$(identity_additions "$candidate")
  docker compose -f "$candidate" stop --timeout 45 >/dev/null 2>&1 || true
  mark_step products-migrated "$additions"
}
# ---- Preservation: checked on the copy before any client, port or worker can reach it. ----
# Only the copy's datastores run here: no product, so no memory worker, and no published port.
# Nothing but the migration has touched the data, so every preserved record is compared exactly.
datastore_services() { jq -c '[.services|keys[]|select(.=="oathweave-redis" or .=="hivemem-qdrant")]' "$1"; }
keyring_json() {
  # The suite's signing and verification keys are the native files, byte for byte.
  local native_keys copy name file same=true count=0
  native_keys=$(native_path /var/lib/hive-iam-keyring/current); copy="$directory/data/oathweave/keyring"
  for name in active-private.pem active-public.pem; do
    count=$((count+1)); [[ -f "$copy/$name" && $(sha "$native_keys/$name") == "$(sha "$copy/$name")" ]] || same=false
  done
  if [[ -d "$native_keys/previous" ]]; then
    for file in "$native_keys"/previous/*; do
      [[ -f "$file" ]] || continue
      count=$((count+1)); [[ -f "$copy/previous/${file##*/}" && $(sha "$file") == "$(sha "$copy/previous/${file##*/}")" ]] || same=false
    done
  fi
  [[ $(find "$copy" -type f | wc -l) == "$count" ]] || same=false
  jq -n --argjson files "$count" --argjson same "$same" '{files:$files,byteIdentical:$same}'
}
issuer_json() {
  local native_issuer suite_issuer
  native_issuer=$(iam_env | jq -r '.JWT_ISSUER // empty')
  suite_issuer=$(sed -n "s/^JWT_ISSUER='\(.*\)'$/\1/p" "$directory/config/oathweave.env")
  jq -n --arg native "$native_issuer" --arg suite "$suite_issuer" '{native:$native,unchanged:($native!="" and $native==$suite)}'
}
action_preserve() {
  check_binding
  step_done products-migrated || die 'Product migrations have not been applied to the copy'
  if step_done preserved; then log 'Preservation already verified'; return; fi
  [[ -f "$candidate" && ! -f "$directory/compose.json" ]] || die 'Preservation is checked before the suite starts; this suite is already active. Roll back, then repeat cutover.'
  local datastores running failures=() compared accounts keyring issuer vectors redis='null' container
  datastores=$(datastore_services "$candidate")
  jq -e --argjson stores "$datastores" '. as $c|all($stores[]; $c.services[.].ports==null)' "$candidate" >/dev/null || die 'A datastore publishes a port'
  mapfile -t stores < <(jq -r '.[]' <<< "$datastores")
  docker compose -f "$candidate" up -d --wait --wait-timeout 120 "${stores[@]}" >&2
  running=$(docker compose -f "$candidate" ps --status running --services | jq -Rsc 'split("\n")|map(select(length>0))|sort')
  # The Hive Registry holds only its own catalog, so it may already run; no product may.
  jq -e --argjson stores "$datastores" 'all(.[]; . as $name|($stores+["hive-registry"])|index($name)!=null)' <<< "$running" >/dev/null || die "Only datastores may run while preservation is checked, but these run: $running"
  # Records: no existing row of any table changed or disappeared. Additions are the migrations'.
  compared=$(compare_store "$directory/data" "$state/baseline" '[]')
  jq -e 'all(.[];(.violations|length)==0)' <<< "$compared" >/dev/null || failures+=("Preserved records changed: $(jq -c 'map_values(.violations)' <<< "$compared")")
  accounts=$(data_tool none "$(service_user oathweave)" '{"command":"accounts","file":"/db/iam.db"}' --mount "type=bind,source=$directory/data/oathweave/iam,target=/db")
  jq -e --slurpfile before "$state/baseline/accounts.json" '.accounts==$before[0].accounts' <<< "$accounts" >/dev/null || failures+=('Accounts or password hashes differ from the native copy')
  keyring=$(keyring_json); jq -e .byteIdentical <<< "$keyring" >/dev/null || failures+=('The signing keys differ from the native keys')
  issuer=$(issuer_json); jq -e .unchanged <<< "$issuer" >/dev/null || failures+=('The issuer differs from the native issuer')
  container=$(docker compose -f "$candidate" ps -q hivemem-qdrant)
  vectors=$(qdrant_inventory "container:$container" "$(service_user hivemem-qdrant)")
  jq -e --argjson copied "$(jq -c '.detail.qdrant' "$steps/captured.json")" '.totalPoints==$copied.totalPoints and .totalCollections==$copied.totalCollections and .digest==$copied.digest' <<< "$vectors" >/dev/null || failures+=('Vector counts or content differ from the native snapshots')
  if [[ -f "$state/baseline/redis.json" ]]; then
    container=$(docker compose -f "$candidate" ps -q oathweave-redis)
    redis=$(data_tool_secret MIGRATE_REDIS_PASSWORD "$directory/config/.migration/secrets/redis-password" "container:$container" "$(service_user oathweave-redis)" '{"command":"redis-compare","url":"redis://127.0.0.1:6379","input":"/base/redis.json"}' --mount "type=bind,source=$state/baseline,target=/base,readonly")
    jq -e .unchanged <<< "$redis" >/dev/null || failures+=("Redis records differ from the native records: $(jq -c '{missing,changed,unexpected}' <<< "$redis")")
  else failures+=('The capture has no Redis inventory; repeat prepare and cutover with this controller'); fi
  local result
  result=$(jq -n --arg plan "$plan" --arg at "$(date -u +%FT%TZ)" --arg capture "$(sha "$steps/captured.json")" --argjson running "$running" --argjson compared "$compared" \
    --argjson accounts "$(jq -c --slurpfile before "$state/baseline/accounts.json" '{count:(.accounts|length),passwordHashesUnchanged:(.accounts==$before[0].accounts)}' <<< "$accounts")" \
    --argjson keyring "$keyring" --argjson issuer "$issuer" --argjson vectors "$vectors" --argjson redis "$redis" --argjson failures "$(printf '%s\n' "${failures[@]:-}" | jq -R . | jq -s 'map(select(length>0))')" \
    '{schema:1,plan:$plan,checkedAt:$at,captureSHA256:$capture,serving:false,runningServices:$running,passed:($failures|length==0),failures:$failures,records:$compared,accounts:$accounts,keyring:$keyring,issuer:$issuer,vectors:$vectors,redis:$redis}')
  jq . <<< "$result" | atomic "$state/preserved.json"
  jq -c '{preserved:.passed,serving,failures,vectors,redis:(.redis|if .==null then null else {recorded,present,expiredSinceCapture} end)}' <<< "$result"
  jq -e .passed <<< "$result" >/dev/null || exit 1
  mark_step preserved "$(jq -nc --arg sha "$(sha "$state/preserved.json")" '{receiptSHA256:$sha}')"
}

# ---- Serving checks. Clients may already be writing, so these tolerate live data changes. ----
# Each native certificate has its own names: a client uses the name its certificate carries.
declare -A port_names=()
curl_native() {
  # curl_native PORT PATH [curl arguments...] -> status code. Trust comes from the native files.
  local port=$1 path=$2 name; shift 2
  name=${port_names[$port]:-$fqdn}
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$name:$port:$(nget '.verifyAddress // "127.0.0.1"')" --cacert "$state/verify-trust.pem" "$@" "https://$name:$port$path" 2>/dev/null || printf '000'
}
b64url_decode() { local value=$1; value=${value//-/+}; value=${value//_//}; case $(( ${#value} % 4 )) in 2) value+='==';; 3) value+='=';; esac; base64 -d <<< "$value"; }
# The receipt of the preservation check this suite was started from, bound to its capture.
receipt_json() {
  local mode=$1 kind=none valid=false
  if [[ -f "$state/preserved.json" && -f "$steps/preserved.json" && -f "$steps/captured.json" ]]; then
    kind=preservation
    if jq -e --arg capture "$(sha "$steps/captured.json")" '.passed==true and .serving==false and .captureSHA256==$capture' "$state/preserved.json" >/dev/null &&
      [[ $(jq -r .detail.receiptSHA256 "$steps/preserved.json") == "$(sha "$state/preserved.json")" ]]; then valid=true; fi
  elif [[ "$mode" == live && -f "$state/verification.json" && -f "$steps/verified.json" ]] && jq -e '.schema==1 and .passed==true' "$state/verification.json" >/dev/null; then
    # A 2.0.0 cutover compared the same records exactly, on a host quiet enough to pass.
    kind=exact-cutover-verification; valid=true
  fi
  jq -n --arg kind "$kind" --argjson valid "$valid" --argjson receipt "$(if [[ "$kind" == preservation ]]; then jq -c '{checkedAt,serving,passed}' "$state/preserved.json"; else printf null; fi)" '{kind:$kind,valid:$valid,preserved:$receipt}'
}
verify_suite() {
  # verify_suite cutover|live. cutover also compares the credential rows, while only machine
  # clients can be connected; live is the standalone check, after the owner may have acted.
  local mode=$1 listeners router iam failures=() probes='[]'
  check_binding
  [[ -f "$directory/compose.json" ]] || die 'The suite is not active here'
  router=$(router_env); iam=$(iam_env); listeners=$(listeners_json)
  local receipt; receipt=$(receipt_json "$mode")
  jq -e .valid <<< "$receipt" >/dev/null || failures+=('No valid preservation receipt: this suite was not started from a copy whose preserved data was verified before serving')
  # Native clients trust these exact roots, so verification uses nothing else.
  : > "$state/verify-trust.pem"
  chmod 600 "$state/verify-trust.pem"
  local certificate listener_port
  while IFS= read -r certificate; do
    cat -- "$(resolve_from /opt/hive-iam "$certificate")" >> "$state/verify-trust.pem"
  done < <(jq -r '.[].certificate' <<< "$listeners" | sort -u)
  while IFS= read -r certificate; do cat -- "$directory/config/ingress/native/$certificate.crt" >> "$state/verify-trust.pem"; done < <(jq -r '.[].port' <<< "$listeners")
  while IFS=$'\t' read -r listener_port certificate; do
    if openssl x509 -in "$(resolve_from /opt/hive-iam "$certificate")" -noout -checkhost "$fqdn" 2>/dev/null | grep -q 'does match'; then port_names[$listener_port]=$fqdn; else port_names[$listener_port]=$expected_host; fi
  done < <(jq -r '.[]|[.port,.certificate]|@tsv' <<< "$listeners")
  cat -- "$(native_path /opt/hive-iam/certs/ca.crt)" >> "$state/verify-trust.pem"
  [[ -z "$(nget '.verifyExtraTrustFile // empty')" ]] || cat -- "$(nget .verifyExtraTrustFile)" >> "$state/verify-trust.pem"
  probe() {
    local port=$1 path=$2 expected=$3 status; shift 3
    status=$(curl_native "$port" "$path" "$@")
    probes=$(jq -c --argjson port "$port" --arg path "$path" --arg expected "$expected" --arg status "$status" '.+[{port:$port,path:$path,expected:$expected,status:$status,ok:($status|test($expected))}]' <<< "$probes")
    [[ "$status" =~ ^($expected)$ ]] || failures+=("port $port $path answered $status, expected $expected")
  }
  local admin_port api_port iam_port memory_port
  admin_port=$(jq -r .ADMIN_PORT <<< "$router"); api_port=$(jq -r .API_PORT <<< "$router"); iam_port=$(jq -r '.PORT // "4200"' <<< "$iam"); memory_port=$(memory_env | jq -r '.HIVEMEM_WEB_PORT // "18790"')
  probe "$admin_port" /_hive/ready 200
  probe "$admin_port" / 200
  probe "$admin_port" /health/ready 200
  probe "$admin_port" /v1/health/ready 200
  probe "$admin_port" /api/oathweave/health/ready 200
  probe "$admin_port" /api/emberpath/health/ready 200
  probe "$admin_port" /api/registry/health/ready 200
  probe "$api_port" /health/ready 200
  probe "$api_port" /v1/models 401
  probe "$iam_port" /api/v1/health/ready 200
  probe "$iam_port" /api/v1/oauth/jwks 200
  probe "$memory_port" /v1/health/ready 200
  if skills_present; then probe "$(skills_env | jq -r '.HIVE_SKILLS_PORT // "4030"')" /healthz 200; fi
  # Each listener presents the exact native certificate, whatever name the client used.
  local tls='[]' port file expected_fp served_fp
  while IFS=$'\t' read -r port file; do
    expected_fp=$(openssl x509 -in "$directory/config/ingress/native/$port.crt" -noout -fingerprint -sha256)
    served_fp=$(openssl s_client -connect "$(nget '.verifyAddress // "127.0.0.1"'):$port" -servername "$fqdn" </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null || true)
    tls=$(jq -c --argjson port "$port" --argjson same "$([[ "$expected_fp" == "$served_fp" ]] && printf true || printf false)" '.+[{port:$port,nativeCertificate:$same}]' <<< "$tls")
    [[ "$expected_fp" == "$served_fp" ]] || failures+=("port $port does not present its native certificate")
  done < <(jq -r '.[]|[.port,.certificate]|@tsv' <<< "$listeners")
  # A native client obtains a token and verifies it against the unchanged native public key.
  local client_id token_reply token header payload signature tokens='{"checked":false}'
  client_id=$(jq -r '.HIVE_ROUTER_IAM_CLIENT_ID // empty' <<< "$router")
  if [[ -n "$client_id" ]]; then
    token_reply=$(jq -c '{grant_type:"client_credentials",client_id:.HIVE_ROUTER_IAM_CLIENT_ID,client_secret:.HIVE_ROUTER_IAM_CLIENT_SECRET}' <<< "$router" |
      curl -sS --max-time 20 --resolve "$fqdn:$iam_port:$(nget '.verifyAddress // "127.0.0.1"')" --cacert "$state/verify-trust.pem" -H 'Content-Type: application/json' --data-binary @- "https://$fqdn:$iam_port/api/v1/oauth/token" 2>/dev/null || true)
    token=$(jq -r '.access_token // .accessToken // empty' <<< "$token_reply" 2>/dev/null || true)
    if [[ -n "$token" ]]; then
      IFS=. read -r header payload signature <<< "$token"
      printf '%s.%s' "$header" "$payload" > "$state/token.signed"
      b64url_decode "$signature" > "$state/token.signature"
      local verified=false
      if openssl dgst -sha256 -verify "$(native_path /var/lib/hive-iam-keyring/current/active-public.pem)" -signature "$state/token.signature" "$state/token.signed" >/dev/null 2>&1; then verified=true; fi
      tokens=$(b64url_decode "$payload" | jq -c --argjson verified "$verified" '{checked:true,issuer:.iss,audience:.aud,signatureVerifiedWithNativeKey:$verified}')
      rm -f -- "$state/token.signed" "$state/token.signature"
      [[ "$verified" == true ]] || failures+=('A new token does not verify with the native signing key')
      [[ $(jq -r .issuer <<< "$tokens") == "$(jq -r '.JWT_ISSUER' <<< "$iam")" ]] || failures+=('The native issuer changed')
    else failures+=('The native client could not obtain a token'); fi
  fi
  # Native memory credentials keep working, directly and through the console port.
  local memory_token memory_checks='[]'
  memory_token=$(memory_env | jq -r '.HIVEMEM_ADMIN_TOKEN // empty')
  if [[ -n "$memory_token" ]]; then
    printf 'Authorization: Bearer %s\n' "$memory_token" > "$state/memory.header"
    local via status_direct
    for via in "$memory_port" "$admin_port"; do
      status_direct=$(curl_native "$via" /v1/stats -H "@$state/memory.header")
      memory_checks=$(jq -c --argjson port "$via" --arg status "$status_direct" '.+[{port:$port,status:$status}]' <<< "$memory_checks")
      [[ "$status_direct" == 200 ]] || failures+=("A native memory credential failed on port $via: $status_direct")
    done
    rm -f -- "$state/memory.header"
  fi
  # Invariants that no client or product action changes: the signing keys and the issuer, and
  # the native stores, which must keep the exact bytes rollback depends on.
  local keyring issuer native_bytes=false invariants
  keyring=$(keyring_json); jq -e .byteIdentical <<< "$keyring" >/dev/null || failures+=('The signing keys differ from the native keys')
  issuer=$(issuer_json); jq -e .unchanged <<< "$issuer" >/dev/null || failures+=('The issuer differs from the native issuer')
  if [[ -f "$state/native-stopped.json" ]] && jq -e --slurpfile before "$state/native-stopped.json" '.==$before[0]' <<< "$(native_hashes)" >/dev/null; then native_bytes=true; else failures+=('Native stores changed since cutover stopped them: a native service wrote, so rollback would refuse'); fi
  invariants=$(jq -nc --argjson keyring "$keyring" --argjson issuer "$issuer" --argjson native "$native_bytes" '{keyring:$keyring,issuer:$issuer,nativeStoresUnchangedSinceStop:$native}')
  # Credentials and registrations stay exact while serving, except the declared live columns.
  local credentials=null accounts
  if [[ "$mode" == cutover ]]; then
    credentials=$(compare_store "$directory/data" "$state/baseline" '[]' '{"credentials":true}')
    jq -e 'all(.[];(.violations|length)==0)' <<< "$credentials" >/dev/null || failures+=("Credential records changed while serving: $(jq -c 'map_values(.violations)' <<< "$credentials")")
    accounts=$(data_tool none "$(service_user oathweave)" '{"command":"accounts","file":"/db/iam.db"}' --mount "type=bind,source=$directory/data/oathweave/iam,target=/db")
    jq -e --slurpfile before "$state/baseline/accounts.json" '.accounts==$before[0].accounts' <<< "$accounts" >/dev/null || failures+=('Accounts or password hashes changed while serving')
  fi
  local result output
  result=$(jq -n --arg mode "$mode" --arg at "$(date -u +%FT%TZ)" --argjson receipt "$receipt" --argjson probes "$probes" --argjson tls "$tls" --argjson tokens "$tokens" --argjson memory "$memory_checks" --argjson invariants "$invariants" --argjson credentials "$credentials" --argjson failures "$(printf '%s\n' "${failures[@]:-}" | jq -R . | jq -s 'map(select(length>0))')" \
    '{schema:2,mode:$mode,checkedAt:$at,passed:($failures|length==0),failures:$failures,receipt:$receipt,probes:$probes,tls:$tls,nativeToken:$tokens,memoryCredential:$memory,invariants:$invariants,credentials:$credentials}')
  if [[ "$mode" == cutover ]]; then output="$state/verification.json"; else output="$state/live-verification.json"; fi
  jq . <<< "$result" | atomic "$output"
  jq -c '{passed,mode,failures,receipt:.receipt.valid,probes:(.probes|map(select(.ok|not)))}' <<< "$result"
  jq -e .passed <<< "$result" >/dev/null || exit 1
  [[ "$mode" != cutover ]] || mark_step verified
}
action_issue_token() {
  check_binding
  [[ -f "$directory/compose.json" ]] || die 'The suite is not active here'
  local subject username digest ttl
  subject=$(nget .adminAccount.subject); username=$(nget .adminAccount.username)
  digest=$(jq -r .tokenDigest <<< "$input"); ttl=$(jq -r '.tokenTtlSeconds // 86400' <<< "$input")
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || die 'A token digest is required'
  docker compose -f "$directory/compose.json" exec -T oathweave node dist/cli.js issue-reset-token --account "$subject" --username "$username" --token-sha256 "$digest" --installation "$installation" --ttl-seconds "$ttl" | grep '^{' | tail -1
}
# The native timer renewed this leaf only while native IAM ran. The native CA signs a new
# one with the same names and key, for the suite's copy; native files are not changed.
renew_identity_leaf() {
  local listeners=$1 port certificate key extension request renewed="$directory/config/.migration/identity-leaf.pem" names ca ca_key
  port=$(jq -r 'map(select(.component=="oathweave"))[0].port' <<< "$listeners")
  certificate="$directory/config/ingress/native/$port.crt"; key="$directory/config/ingress/native/$port.key"
  ! openssl x509 -in "$certificate" -noout -checkend 604800 >/dev/null 2>&1 || return 0
  ca=$(native_path /var/lib/hive-iam-pki/ca.crt); ca_key=$(native_path /var/lib/hive-iam-pki/ca.key)
  [[ -f "$ca" && -f "$ca_key" ]] || die 'The identity certificate is near expiry and the native CA is not available to renew it'
  names=$(openssl x509 -in "$certificate" -noout -ext subjectAltName | tail -n +2 | sed 's/^ *//; s/IP Address:/IP:/g; s/, */,/g')
  extension=$(mktemp "$state/leaf-ext.XXXXXX"); request=$(mktemp "$state/leaf-csr.XXXXXX")
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$names" > "$extension"
  openssl req -new -sha256 -key "$key" -subj "$(openssl x509 -in "$certificate" -noout -subject -nameopt compat | sed 's/^subject=//')" -out "$request" 2>/dev/null
  openssl x509 -req -sha256 -in "$request" -CA "$ca" -CAkey "$ca_key" -set_serial "0x$(openssl rand -hex 16)" -days 30 -extfile "$extension" -out "$renewed.pending" 2>/dev/null
  rm -f -- "$extension" "$request"
  openssl verify -CAfile "$ca" "$renewed.pending" >/dev/null || die 'The renewed identity certificate did not verify'
  mv -T -- "$renewed.pending" "$renewed"
  publish_copy ingress "$certificate" "$renewed"
  log 'Identity certificate renewed from the native CA'
}
action_tls_refresh() {
  check_binding
  local listeners; listeners=$(listeners_json)
  [[ -f "$directory/compose.json" ]] || die 'The suite is not active here'
  ingress_fragments "$listeners"
  renew_identity_leaf "$listeners"
  docker compose -f "$directory/compose.json" restart ingress >/dev/null
  log 'Ingress restarted with the current native certificates'
}
# The Router's memory proxy token is renewed in the native environment file, which the suite
# Emberpath copied at cutover. This copies the current value and recreates Emberpath. The value
# is never printed.
action_refresh_memory_token() {
  check_binding
  [[ -f "$directory/compose.json" ]] || die 'The suite is not active here'
  local file="$directory/config/emberpath.env" current next
  next=$(router_env | jq -c 'select((.HIVE_ROUTER_MEMORY_PROXY_TOKEN // "")|length>0)|{HIVE_ROUTER_MEMORY_PROXY_TOKEN}')
  [[ -n "$next" ]] || die 'The native Router environment has no memory proxy token'
  current=$(env_json "$file")
  if jq -e --argjson next "$next" '.HIVE_ROUTER_MEMORY_PROXY_TOKEN==$next.HIVE_ROUTER_MEMORY_PROXY_TOKEN' <<< "$current" >/dev/null; then
    log 'Emberpath already has the current memory proxy token'; return
  fi
  write_env emberpath "$file" "$(jq -c --argjson next "$next" '.+$next' <<< "$current")"
  docker compose -f "$directory/compose.json" up -d --wait --wait-timeout 180 --no-deps --force-recreate emberpath >&2
  log 'Emberpath was recreated with the renewed memory proxy token'
}

# ---- Rollback. Native data was never written after the stop, so it is simply restarted. ----
action_rollback() {
  check_binding
  [[ -f "$state/native-stopped.json" ]] || die 'There is no cutover to roll back'
  local compose_file=''
  [[ ! -f "$directory/compose.json" ]] || compose_file="$directory/compose.json"
  [[ -n "$compose_file" || ! -f "$candidate" ]] || compose_file="$candidate"
  local vectors='null' stamp attempt writes='null' container
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  if [[ -n "$compose_file" ]]; then
    container=$(docker compose -f "$compose_file" ps -q --status running hivemem-qdrant 2>/dev/null || true)
    if [[ -n "$container" && -f "$steps/captured.json" ]]; then
      vectors=$(qdrant_inventory "container:$container" "$(service_user hivemem-qdrant)" || printf 'null')
    fi
    docker compose -f "$compose_file" stop --timeout 45
  fi
  if [[ -d "$state/baseline" && -f "$directory/data/oathweave/iam/iam.db" ]]; then
    writes=$(compare_store "$directory/data" "$state/baseline" '[]' || printf 'null')
  fi
  # The native bytes must be exactly as cutover left them, before anything starts.
  local current; current=$(native_hashes)
  jq -e --slurpfile before "$state/native-stopped.json" '.==$before[0]' <<< "$current" >/dev/null || die 'Native stores changed while the suite was active. Nothing was restarted: reconcile them before rolling back.'
  qdrant_control start
  local attempts=0
  until curl -fsS -o /dev/null "$(qdrant_source)/readyz" 2>/dev/null; do attempts=$((attempts+1)); (( attempts<60 )) || die 'Native Qdrant did not become ready'; sleep 2; done
  restore_units
  local unit
  for unit in $(installed_units "${units_start[@]}"); do service start "$unit"; done
  sleep 1
  for unit in $(installed_units "${units_start[@]}"); do service_active "$unit" || die "$unit did not start"; done
  # Writes made in the suite are never replayed or discarded: they stay in this attempt.
  attempt="$directory/attempts/$stamp"
  install -d -m 700 "$directory/attempts" "$attempt"
  [[ ! -d "$directory/data" ]] || mv -T -- "$directory/data" "$attempt/data"
  [[ ! -d "$state/baseline" ]] || mv -T -- "$state/baseline" "$attempt/baseline"
  for name in compose.json receipt.json data-formats.json transaction.json; do [[ ! -f "$directory/$name" ]] || mv -T -- "$directory/$name" "$attempt/$name"; done
  [[ ! -f "$steps/captured.json" ]] || cp -- "$steps/captured.json" "$attempt/"
  jq -n --arg attempt "$attempt" --arg at "$(date -u +%FT%TZ)" --argjson writes "$writes" --argjson vectors "$vectors" --slurpfile copied <(jq -c '.detail.qdrant // null' "$steps/captured.json" 2>/dev/null || printf 'null') --argjson nativeBytes "$current" '
    {schema:1,rolledBackAt:$at,suiteDataRetainedAt:$attempt,nativeBytesUnchangedSinceStop:true,nativeHashes:$nativeBytes,
     writesMadeAfterCutover:{statement:"These writes went to the suite only. They were not copied back to the native stores. They remain in the retained suite data for review.",databases:$writes,vectorsAtRollback:$vectors,vectorsAtCutover:$copied[0]}}' | atomic "$attempt/rollback-receipt.json"
  cp -- "$attempt/rollback-receipt.json" "$state/last-rollback.json"
  rm -rf -- "$steps"; install -d -m 700 "$steps"
  rm -f -- "$state/native-stopped.json" "$state/cutover-started.json" "$state/verification.json"
  jq -c '{rolledBackAt,suiteDataRetainedAt,nativeBytesUnchangedSinceStop,writes:(.writesMadeAfterCutover.databases|if .==null then null else map_values(.changed) end),vectorsAtRollback:.writesMadeAfterCutover.vectorsAtRollback,vectorsAtCutover:.writesMadeAfterCutover.vectorsAtCutover}' "$attempt/rollback-receipt.json"
}
action_status() {
  local completed='[]' last=null
  if [[ -d "$steps" ]]; then completed=$(find "$steps" -maxdepth 1 -name '*.json' -printf '%f\n' | sed 's/\.json$//' | sort | jq -R . | jq -s .); fi
  [[ ! -f "$state/last-rollback.json" ]] || last=$(jq -c '{rolledBackAt,suiteDataRetainedAt}' "$state/last-rollback.json")
  jq -n --argjson steps "$completed" --argjson rollback "$last" --arg installation "$installation" --argjson active "$([[ -f "$directory/compose.json" ]] && printf true || printf false)" '{installation:$installation,suiteActive:$active,completedSteps:$steps,lastRollback:$rollback}'
}

if [[ "$action" == native-configure || "$action" == native-dry-run ]]; then install -d -m 700 "$directory"; fi
if [[ "$action" != native-plan && "$action" != native-status ]]; then
  [[ -d "$directory" ]] || die 'The installation directory does not exist; run prepare first'
  [[ ! -L "$directory/migration.lock" ]] || die 'Unsafe migration lock'
  exec 7>"$directory/migration.lock"
  flock -n 7 || die 'Another migration command holds this installation'
fi
case "$action" in
  native-plan) action_plan;;
  native-configure) action_configure;;
  native-registry-login) action_registry_login;;
  native-registry-logout) action_registry_logout;;
  native-dry-run) action_dry_run;;
  native-stop) action_stop_native;;
  native-capture) action_capture;;
  native-migrate) action_migrate_products;;
  native-preserve) action_preserve;;
  native-verify) verify_suite cutover;;
  native-verify-live) verify_suite live;;
  native-issue-token) action_issue_token;;
  native-tls-refresh) action_tls_refresh;;
  native-refresh-memory-token) action_refresh_memory_token;;
  native-rollback) action_rollback;;
  native-status) action_status;;
  *) die 'Unknown migration action';;
esac
