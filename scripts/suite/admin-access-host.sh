#!/usr/bin/env bash
# Root host adapter. Only data crosses the controller transport; credentials stay on this host.
set +x +v
set -Eeuo pipefail
umask 077
read -r input
(( ${#input} <= 3145728 )) || { printf 'Administrator access: request too large\n' >&2; exit 1; }
directory=$(jq -er .directory <<< "$input")
config="$directory/config"; compose="$directory/compose.json"
request=$(jq -ce .adminAccess <<< "$input")
mode=$(jq -er .mode <<< "$request")
die() { printf 'Administrator access: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || die 'This command needs sudo on each selected product host'
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" == "$(realpath -m -- "$directory")" && ! -L "$directory" ]] || die 'Unsafe installation path'
[[ -d "$config" && ! -L "$config" && -f "$compose" && ! -L "$compose" && ! -L "$directory/controller.lock" ]] || die 'Install the suite first'
trap restore_installation_owner EXIT
exec 9>"$directory/controller.lock"
flock -n 9 || die 'Another controller is running on this host'
jq -e '.phase|IN("complete","aborted")' "$directory/transaction.json" >/dev/null || die 'A suite transaction is held; recover it before changing access'
jq -e --arg installation "$(jq -er .installation <<< "$input")" '.installation==$installation' "$directory/installation.json" >/dev/null || die 'Installation ownership differs'
placed() { jq -e --arg component "$1" '.placements[$component]!=null' <<< "$input" >/dev/null; }
private_directory() {
  local path=$1
  [[ "$path" == "$config/.admin-access" || "$path" == "$config/.admin-access/"* ]] || die 'Unsafe access record directory'
  [[ ! -L "$path" ]] || die 'Access records cannot be symlinks'
  if [[ -e "$path" ]]; then [[ -d "$path" && $(stat -c '%u:%a' "$path") == 0:700 ]] || die 'Access records must be root-owned and private'
  else install -d -m 700 -o 0 -g 0 -- "$path"; sync -f "$(dirname -- "$path")"; fi
}
private_file() { [[ -f "$1" && ! -L "$1" && $(stat -c '%u:%a:%h' "$1") == 0:600:1 ]]; }
atomic_record() {
  local target=$1 pending
  [[ ! -L "$target" ]] || die 'Unsafe access record'
  pending=$(mktemp "$(dirname -- "$target")/.pending.XXXXXX")
  cat > "$pending"; chmod 600 "$pending"
  if [[ -f "$target" ]] && cmp -s -- "$pending" "$target"; then rm -- "$pending"; return 0; fi
  sync -f "$pending"
  mv -T -- "$pending" "$target"; sync -f "$(dirname -- "$target")"
}
component_file() { printf '%s/%s.env\n' "$config" "$1"; }
# Deliberate allowlist: no private key, password or other product credential leaves the host.
component_keys() {
  printf '%s\n' OATHWEAVE_ISSUER
  case "$1" in
    magnus|magnus-gateway) printf '%s\n' MAGNUS_OATHWEAVE_IDENTITIES_JSON;;
    emberpath) printf '%s\n' EMBERPATH_OATHWEAVE_IDENTITIES_JSON EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON HIVE_ROUTER_ADMIN_USERS;;
    hivemem) printf '%s\n' HIVEMEM_OATHWEAVE_IDENTITIES_JSON;;
    hiveskills) printf '%s\n' HIVESKILLS_OATHWEAVE_IDENTITIES_JSON HIVE_SKILLS_ADMIN_USERS;;
    cindertrace) printf '%s\n' CINDERTRACE_OATHWEAVE_IDENTITIES_JSON;;
    chattermost) printf '%s\n' OATHWEAVE_CHAT_IDENTITIES_JSON;;
    embermend|embermend-worker) printf '%s\n' EMBERMEND_IDENTITY_GRANTS;;
    ardentstudio) printf '%s\n' ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON;;
  esac
}
environments() {
  local result='{}' component key values file value
  for component in emberpath hivemem hiveskills magnus magnus-gateway cindertrace chattermost embermend embermend-worker ardentstudio; do
    placed "$component" || continue
    file=$(component_file "$component"); values='{}'
    while IFS= read -r key; do value=$(admin_access_env_value "$file" "$key") || die 'A product environment could not be read safely'; values=$(jq -c --arg key "$key" --arg value "$value" '.+{($key):$value}' <<< "$values"); done < <(component_keys "$component")
    result=$(jq -c --arg component "$component" --argjson values "$values" '.+{($component):$values}' <<< "$result")
  done
  printf '%s\n' "$result"
}
node_tool() { # service, script key, JSON. Nothing sensitive is placed in argv.
  local service=$1 script=$2 body=$3 code
  placed "$service" || die "The owning $service is not on this host"
  code=$(jq -er --arg script "$script" '.scripts[$script]' <<< "$request" | base64 -d)
  printf '%s\n' "$body" | docker compose -f "$compose" exec -T "$service" node --input-type=module -e "$code" -- --stdin
}
identity_action() {
  local body
  body=$(jq -c --arg mode "$1" '{mode:$mode,username,identity,operationId:.state.operationId,approvedBy:.state.approvedBy}' <<< "$request")
  node_tool oathweave identity "$body"
}
load_record_path() {
  local issuer subject key
  issuer=$(jq -er .identity.issuer <<< "$request"); subject=$(jq -er .identity.subject <<< "$request")
  [[ "$issuer" == "$(jq -er .origin <<< "$input")/api/oathweave" && "$subject" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] || die 'Invalid administrator identity'
  key=$(printf '%s\n%s' "$issuer" "$subject" | sha256sum | cut -d ' ' -f1)
  record_directory="$config/.admin-access/$key"
  coordinator="$record_directory/coordinator.json"
  for path in "$config/.admin-access" "$record_directory"; do [[ ! -L "$path" ]] || die 'Unsafe access record directory'; done
}
load_state() {
  load_record_path
  state=$(jq -ce .state <<< "$request")
  jq -e --argjson identity "$(jq -c .identity <<< "$request")" --arg installation "$(jq -er .installation <<< "$input")" \
    --arg host "$(jq -er .host <<< "$input")" --arg uuid "$(jq -er .uuid "$directory/installation.json")" '.schema==1 and .installation==$installation and .identity==$identity and .hostIdentities[$host]==$uuid and (.operationId|test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")) and (.localIds|type=="object")' <<< "$state" >/dev/null || die 'The access operation identity differs'
  private_directory "$config/.admin-access"; private_directory "$record_directory"
}
restart_products() { # JSON list of service names; health checked even after an interrupted recreate.
  local services=$1 stage=$2 service container fingerprint receipt
  fingerprint=$(printf '%s\n%s' "$stage" "$services" | sha256sum | cut -d ' ' -f1)
  receipt="$record_directory/restarted-$fingerprint.json"
  if [[ -e "$receipt" ]]; then private_file "$receipt" || die 'Unsafe restart receipt'; fi
  while IFS= read -r service; do
    placed "$service" || die 'The restart list is not placed on this host'
    if [[ ! -f "$receipt" ]]; then
      printf 'Administrator access: reconnecting %s...\n' "$service" >&2
      docker compose -f "$compose" up -d --no-deps --force-recreate "$service" >/dev/null 2>&1 || die "The grant is retained but $service did not recreate; repeat the same setup to recover"
    fi
    container=$(docker compose -f "$compose" ps -q "$service")
    [[ -n "$container" ]] || die "$service is not running"
    for _ in $(seq 1 90); do
      [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container") == healthy ]] && break
      sleep 2
    done
    [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container") == healthy ]] || die "$service did not become healthy; keep the access receipts and repeat the same setup"
    printf 'Administrator access: %s is ready.\n' "$service" >&2
  done < <(jq -r '.[]' <<< "$services")
  if [[ ! -f "$receipt" ]]; then jq -nc --argjson services "$services" '{schema:1,services:$services,healthy:true}' | atomic_record "$receipt"; fi
}
case "$mode" in
  list|resolve|status) identity_action "$mode";;
  inspect)
    load_record_path
    saved=null
    if [[ -e "$coordinator" ]]; then private_file "$coordinator" || die 'Unsafe coordinator receipt'; saved=$(cat "$coordinator"); fi
    jq -nc --argjson environments "$(environments)" --argjson state "$saved" --arg uuid "$(jq -er .uuid "$directory/installation.json")" '{environments:$environments,state:$state,installationUUID:$uuid}'
    ;;
  init)
    load_state
    verified_identity=$(identity_action resolve | jq -ce .identity)
    [[ "$verified_identity" == "$(jq -c .identity <<< "$request")" ]] || die 'The account changed before approval was recorded'
    if [[ -e "$coordinator" ]]; then
      private_file "$coordinator" || die 'Unsafe coordinator receipt'
      jq -e --argjson state "$state" '.installation==$state.installation and .identity==$state.identity and .operationId==$state.operationId and .localIds==$state.localIds and .hostIdentities==$state.hostIdentities' "$coordinator" >/dev/null || die 'A different access operation is already retained'
    else
      state=$(jq -c --arg uid "${SUDO_UID:-0}" --arg actor "${SUDO_USER:-root}" --arg approvedAt "$(date -u +%FT%TZ)" '.approvedBy={uid:$uid,account:$actor,at:$approvedAt}' <<< "$state")
      printf '%s\n' "$state" | atomic_record "$coordinator"
    fi
    cat "$coordinator";;
  merge|preview)
    placed oathweave || die 'Policy planning needs the identity host'
    code=$(jq -er .scripts.data <<< "$request" | base64 -d)
    if [[ "$mode" == preview ]]; then code+=$'\nprocess.exitCode=await adminAccessDataCLI(process.stdin,process.stdout,{preview:true});'; fi
    # Preview uses an explicit invocation rather than the default CLI's native proof requirement.
    if [[ "$mode" == preview ]]; then
      printf '%s\n' "$(jq -c .plan <<< "$request")" | docker compose -f "$compose" exec -T oathweave node --input-type=module -e "$code"
    else
      printf '%s\n' "$(jq -c .plan <<< "$request")" | docker compose -f "$compose" exec -T oathweave node --input-type=module -e "$code" -- --stdin
    fi;;
  recover)
    load_state
    for publication in "$record_directory"/secret-publication "$record_directory"/grant-publication; do
      if [[ -d "$publication" ]]; then admin_access_recover "$publication" >/dev/null; fi
    done
    jq -nc '{recovered:true}'
    ;;
  secrets)
    load_state
    updates='{}'; services='[]'
    while IFS= read -r component; do
      placed "$component" || continue
      expected=$(jq -er --arg component "$component" '.expectedImages[$component]' <<< "$request")
      [[ $(jq -er --arg component "$component" '.services[$component].image' "$compose") == "$expected" ]] || die "Upgrade $component with ./hive.sh upgrade --release latest before setting up access"
      file=$(component_file "$component"); secret=$(admin_access_env_value "$file" HIVE_ADMIN_PROVISIONING_SECRET)
      if [[ -z "$secret" ]]; then
        secret_file="$record_directory/$component-provisioning-secret"
        if [[ -e "$secret_file" ]]; then private_file "$secret_file" || die 'Unsafe purpose credential'; else openssl rand -hex 32 | atomic_record "$secret_file"; fi
        secret=$(cat "$secret_file")
        [[ "$secret" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid purpose credential'
        updates=$(jq -c --arg file "$file" --arg secret "$secret" '.+{($file):{HIVE_ADMIN_PROVISIONING_SECRET:$secret}}' <<< "$updates")
        if [[ "$component" == chattermost ]]; then updates=$(jq -c --arg file "$config/chattermost/runtime.env" --arg secret "$secret" '.+{($file):{HIVE_ADMIN_PROVISIONING_SECRET:$secret}}' <<< "$updates"); fi
      else [[ "$secret" =~ ^[a-f0-9]{64}$ ]] || die 'The existing provisioning credential is invalid'; fi
      if [[ -n "${secret_file:-}" ]]; then services=$(jq -c --arg component "$component" '.+[$component]' <<< "$services"); fi
      secret_file=''
    done < <(printf '%s\n' hivemem chattermost)
    restart_file="$record_directory/secret-services.json"
    if [[ -e "$restart_file" ]]; then private_file "$restart_file" || die 'Unsafe service receipt'; services=$(cat "$restart_file")
    else printf '%s\n' "$services" | atomic_record "$restart_file"; fi
    admin_access_publish "$updates" "$record_directory/secret-publication" >/dev/null
    restart_products "$services" secrets
    jq -nc '{purposeCredentialsReady:true}'
    ;;
  native)
    load_state
    component=$(jq -er .component <<< "$request")
    [[ "$component" == hivemem || "$component" == chattermost ]] || die 'Unknown native account owner'
    body=$(jq -nc --arg component "$component" --argjson state "$state" '{version:1,issuer:$state.identity.issuer,subject:$state.identity.subject,username:$state.identity.username} +
      (if $component=="hivemem" then {local_id:$state.localIds.hivemem,display_name:$state.identity.displayName} else {user_id:$state.localIds.chattermost,email:$state.identity.email,username:($state.identity.username|ascii_downcase|if test("^[a-z0-9._-]{2,64}$") then . else ("hive_"+$state.localIds.chattermost) end)} end)')
    call=$(jq -nc --arg component "$component" --arg serverName "$(jq -er .serverName <<< "$request")" --arg operationId "$(jq -er .operationId <<< "$state")" --argjson body "$body" '{component:$component,serverName:$serverName,operationId:$operationId,method:"GET",body:$body}')
    result=$(node_tool "$component" native "$call") || die 'The owning product did not confirm this native account; retain the operation and repeat the same setup'
    if [[ $(jq -r '.missing // false' <<< "$result") == true ]]; then
      call=$(jq -c '.method="POST"' <<< "$call")
      result=$(node_tool "$component" native "$call") || die 'The native request did not return a receipt; retain this operation and repeat setup to inspect its exact receipt'
    fi
    printf '%s\n' "$result" | atomic_record "$record_directory/native-$component.json"
    printf '%s\n' "$result";;
  apply)
    load_state
    jq -e '.plan.nativeProvisioningVerified==true' <<< "$request" >/dev/null || die 'A preview cannot publish grants'
    updates='{}'; services='[]'
    while IFS= read -r component; do
      placed "$component" || continue
      changes=$(jq -c --arg component "$component" '[.plan.changes[]|select(.component==$component)]|map({key:.key,value:.after})|from_entries' <<< "$request")
      while IFS= read -r key; do
        if ! jq -e --arg component "$component" --arg key "$key" 'any(.plan.changes[]; .component==$component and .key==$key)' <<< "$request" >/dev/null; then
          current=$(admin_access_env_value "$(component_file "$component")" "$key")
          [[ "$current" == "$(jq -r --arg component "$component" --arg key "$key" '.plan.environments[$component][$key]' <<< "$request")" ]] || die 'A reviewed product policy changed before publication'
        fi
      done < <(jq -r --arg component "$component" '.plan.environments[$component]|keys[]' <<< "$request")
      while IFS= read -r change; do
        key=$(jq -er .key <<< "$change"); current=$(admin_access_env_value "$(component_file "$component")" "$key")
        [[ "$current" == "$(jq -r .before <<< "$change")" || "$current" == "$(jq -r .after <<< "$change")" ]] || die 'A reviewed product policy changed; no grant will overwrite it'
      done < <(jq -c --arg component "$component" '.plan.changes[]|select(.component==$component)' <<< "$request")
      if [[ "$changes" != '{}' ]]; then
        file=$(component_file "$component")
        updates=$(jq -c --arg file "$file" --argjson changes "$changes" '.+{($file):$changes}' <<< "$updates")
        if [[ "$component" == chattermost ]]; then updates=$(jq -c --arg file "$config/chattermost/runtime.env" --argjson changes "$changes" '.+{($file):$changes}' <<< "$updates"); fi
        services=$(jq -c --arg component "$component" '.+[$component]' <<< "$services")
      fi
    done < <(jq -r '.plan.environments|keys[]' <<< "$request")
    # Include the stored affected services when recovery observes already published keys.
    restart_file="$record_directory/grant-services.json"
    if [[ -e "$restart_file" ]]; then private_file "$restart_file" || die 'Unsafe service receipt'; services=$(cat "$restart_file")
    else printf '%s\n' "$services" | atomic_record "$restart_file"; fi
    admin_access_publish "$updates" "$record_directory/grant-publication" >/dev/null
    restart_products "$services" grants
    while IFS= read -r component; do
      placed "$component" || continue
      container=$(docker compose -f "$compose" ps -q "$component")
      [[ -n "$container" ]] || die 'A linked product is not running'
      while IFS= read -r key; do
        effective=$(docker inspect "$container" | jq -r --arg key "$key" '.[0].Config.Env|map(select(startswith($key+"="))|.[($key|length)+1:])|if length==1 then .[0] else error("Ambiguous runtime environment") end')
        [[ "$effective" == "$(jq -r --arg component "$component" --arg key "$key" '.plan.environments[$component][$key]' <<< "$request")" ]] || die 'A running product has not loaded the reviewed access policy'
      done < <(component_keys "$component")
    done < <(jq -r '.plan.environments|keys[]' <<< "$request")
    actual=$(environments)
    jq -e --argjson actual "$actual" '.plan.environments as $expected | all($actual|to_entries[]; .value==$expected[.key])' <<< "$request" >/dev/null || die 'Published policy differs from the reviewed plan'
    jq -nc --argjson services "$services" '{published:true,healthy:true,services:$services}' | atomic_record "$record_directory/participant.json"
    cat "$record_directory/participant.json";;
  grant)
    load_state
    identity_action grant;;
  complete)
    load_state
    private_file "$coordinator" || die 'The coordinator receipt is missing'
    if [[ $(jq -r .phase "$coordinator") == complete ]]; then jq -nc '{complete:true}'; exit 0; fi
    jq --arg phase complete --arg at "$(date -u +%FT%TZ)" '.phase=$phase|.completedAt=$at' "$coordinator" | atomic_record "$coordinator"
    jq -nc '{complete:true}'
    ;;
  *) die 'Unknown guided access action';;
esac
