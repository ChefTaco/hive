#!/usr/bin/env bash
# hive.sh console-clients, the browser sign-in settings on one host. Transported verbatim after
# ownership-host.sh and input-artifacts-host.sh; the reviewed settings arrive as JSON on standard
# input. On the host that runs each of them it reconciles:
#   Oathweave  IAM_BROWSER_ISSUER, IAM_BROWSER_AUTHORIZATION_URL, IAM_BROWSER_API_BASE_URL and a
#              reviewed policy in IAM_BROWSER_CLIENT_POLICIES for every HiveXUI browser client
#   Emberpath  EMBERPATH_PASSWORD_RELAY=false: sign-in and re-authentication go through Oathweave's
#              own page, and Emberpath never relays a password
# and it reads the console's runtime.json, whose issuer must be Oathweave's browser issuer. Only a
# missing setting is added. A key the operator set is kept as it is, and named when it differs from
# the reviewed value. The environment file is the one the active Compose definition gives the
# service, which the installation file must name too, so an installation whose Oathweave reads
# another file than config/oathweave.env is handled the same. check only reads. apply keeps a copy
# of every file it changes in config/.browser-signin/STAMP, moves the initializer's record and the
# active plan's pinned deployment inputs to the new bytes when nothing else changed since they were
# taken, and recreates only the services whose environment changed. No secret is read or printed.
set +x +v
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
die() { printf 'Browser sign-in: %s\n' "$*" >&2; exit 1; }
trap restore_installation_owner EXIT
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ! -L "$directory" ]] || die 'Invalid installation path'
request=$(jq -ce '.browserSignin|objects' <<< "$input") || die 'Missing request'
mode=$(jq -er .mode <<< "$request")
[[ "$mode" == check || "$mode" == apply ]] || die 'Unknown mode'
origin=$(jq -er .origin <<< "$input")
[[ "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die 'The console origin must be an HTTPS origin'
host=$(jq -er .host <<< "$input")
config="$directory/config"
compose="$directory/compose.json"
[[ -f "$compose" && ! -L "$compose" && -f "$directory/receipt.json" ]] || die 'The suite is not active on this host'
if [[ -f "$directory/transaction.json" ]]; then
  jq -e '.phase=="complete" or .phase=="aborted"' "$directory/transaction.json" >/dev/null || die 'A suite transaction is open on this host; repeat the command that opened it first'
fi
placed() { jq -e --arg name "$1" '.placements[$name]!=null' <<< "$input" >/dev/null; }
https_url() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[-A-Za-z0-9._~]+)*/?$ ]]; }
url_origin() { [[ "$1" =~ ^(https://[^/]+) ]] && printf '%s\n' "${BASH_REMATCH[1]}"; }
# Compose semantics: the last assignment wins; one pair of quotes is removed.
get() {
  jq -Rrs --arg key "$2" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|
    if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$1"
}
# The one environment file the active Compose definition gives SERVICE. The installation file must
# name the same one.
service_environment() {
  local name=$1 files file placement
  files=$(jq -c --arg name "$name" '.services[$name].env_file // null' "$compose")
  [[ "$files" != null ]] || die "$name is not in the active Compose definition on $host; upgrade or install first"
  jq -e 'type=="array" and length==1' <<< "$files" >/dev/null || die "$name does not read exactly one environment file"
  file=$(jq -r '.[0]|if type=="string" then . else .path end' <<< "$files")
  placement=$(jq -r --arg name "$name" '.placements[$name].envFile // empty' <<< "$input")
  [[ -z "$placement" || "$placement" == "$file" ]] || die "$name reads $file, but the installation file names $placement; reconcile them first"
  [[ "$file" == "$config/"* && "$file" != *'/../'* && "$file" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "The $name environment $file is not in this installation's configuration"
  [[ -f "$file" && ! -L "$file" ]] || die "The $name environment $file is missing"
  (( (8#$(stat -c %a "$file") & 077)==0 )) || die "The $name environment $file must be owner-only"
  printf '%s\n' "$file"
}

changes='[]' kept='[]' problems='[]'
note() { kept=$(jq -c --arg text "$1" '.+[$text]' <<< "$kept"); }
problem() { problems=$(jq -c --arg text "$1" '.+[$text]' <<< "$problems"); }
want() { # SERVICE FILE CHANGES-JSON [POLICIES-JSON]
  [[ "$3" != '{}' ]] || return 0
  changes=$(jq -c --arg service "$1" --arg file "$2" --argjson values "$3" --argjson policies "${4:-[]}" '.+[{service:$service,file:$file,values:$values,keys:($values|keys),policies:$policies}]' <<< "$changes")
}

# The console's runtime.json, when this host serves it: the issuer HiveXUI expects.
runtime_issuer=''
runtime=''
if jq -e '.console!=null and .placements.hivexui!=null' <<< "$input" >/dev/null; then
  runtime=$(jq -er .console.runtimeFile <<< "$input")
  [[ -f "$runtime" && ! -L "$runtime" ]] || die 'The console runtime.json is missing'
  runtime_issuer=$(jq -r '.identity.issuer // empty' "$runtime" 2>/dev/null) || die 'The console runtime.json is not JSON'
  [[ -n "$runtime_issuer" ]] || problem "$runtime has no identity.issuer: HiveXUI has no Oathweave sign-in. Restore the file from the installation's backup."
fi

issuer=$(jq -r '.issuer // empty' <<< "$request")
if placed oathweave; then
  oathweave=$(service_environment oathweave)
  current=$(get "$oathweave" IAM_BROWSER_ISSUER)
  values='{}'
  if [[ -n "$current" ]]; then
    issuer=$current
  else
    # HiveXUI's issuer first: browser tokens then keep the issuer the console already checks.
    [[ -z "$runtime_issuer" ]] || issuer=$runtime_issuer
    https_url "$issuer" || die "No HTTPS browser issuer to configure for Oathweave (from runtime.json or the installation file)"
    values=$(jq -c --arg value "$issuer" '.+{IAM_BROWSER_ISSUER:$value}' <<< "$values")
  fi
  https_url "$issuer" || problem "IAM_BROWSER_ISSUER in $oathweave is not an HTTPS URL: Oathweave issues no browser sign-in"
  # Browser discovery (authorization-code + PKCE clients outside the console) needs both URLs on
  # the issuer's origin. They point at the console, which serves the sign-in page and the API.
  authorization=$(get "$oathweave" IAM_BROWSER_AUTHORIZATION_URL)
  api=$(get "$oathweave" IAM_BROWSER_API_BASE_URL)
  if [[ -z "$authorization" || -z "$api" ]]; then
    if [[ "$(url_origin "$issuer")" == "$origin" ]]; then
      [[ -n "$authorization" ]] || values=$(jq -c --arg value "$origin/auth/authorize" '.+{IAM_BROWSER_AUTHORIZATION_URL:$value}' <<< "$values")
      [[ -n "$api" ]] || values=$(jq -c --arg value "$origin/api/oathweave" '.+{IAM_BROWSER_API_BASE_URL:$value}' <<< "$values")
    else
      problem "IAM_BROWSER_ISSUER ($issuer) is not on the console origin $origin, so browser discovery is left unconfigured; set IAM_BROWSER_AUTHORIZATION_URL and IAM_BROWSER_API_BASE_URL on the issuer's origin by hand"
    fi
  else
    [[ "$authorization" == "$origin/auth/authorize" ]] || note "IAM_BROWSER_AUTHORIZATION_URL is kept: $authorization"
    [[ "$api" == "$origin/api/oathweave" ]] || note "IAM_BROWSER_API_BASE_URL is kept: $api"
  fi
  policies=$(get "$oathweave" IAM_BROWSER_CLIENT_POLICIES); [[ -n "$policies" ]] || policies='{}'
  jq -e 'type=="object"' <<< "$policies" >/dev/null 2>&1 || die "IAM_BROWSER_CLIENT_POLICIES in $oathweave is not a JSON object; fix it by hand first"
  reviewed=$(jq -c '.policies // {}' <<< "$request")
  jq -e 'type=="object" and all(to_entries[]; (.key|test("^hivexui-[a-z][a-z0-9-]{0,47}$")) and (.value.audience|type=="string") and (.value.permissions|type=="array" and length>0))' <<< "$reviewed" >/dev/null || die 'Invalid reviewed policies'
  added=$(jq -c --argjson current "$policies" 'to_entries|map(select($current[.key]==null)|.key)' <<< "$reviewed")
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    note "The $id policy in IAM_BROWSER_CLIENT_POLICIES is kept as it is; it differs from the reviewed one"
  done < <(jq -r --argjson current "$policies" 'to_entries[]|select($current[.key]!=null and ($current[.key].audience!=.value.audience or ($current[.key].permissions|unique)!=(.value.permissions|unique)))|.key' <<< "$reviewed")
  if [[ "$added" != '[]' ]]; then
    values=$(jq -c --argjson policies "$policies" --argjson reviewed "$reviewed" --argjson added "$added" '.+{IAM_BROWSER_CLIENT_POLICIES:($policies+($reviewed|with_entries(select(.key as $id|$added|index($id))))|tojson)}' <<< "$values")
  fi
  want oathweave "$oathweave" "$values" "$added"
fi
[[ -z "$runtime_issuer" || -z "$issuer" || "$runtime_issuer" == "$issuer" ]] ||
  problem "runtime.json signs in with issuer $runtime_issuer, but Oathweave's browser issuer is $issuer; HiveXUI refuses those tokens. Make them equal by hand"

if placed emberpath; then
  emberpath=$(service_environment emberpath)
  relay=$(get "$emberpath" EMBERPATH_PASSWORD_RELAY)
  if [[ -z "$relay" ]]; then want emberpath "$emberpath" '{"EMBERPATH_PASSWORD_RELAY":"false"}'
  elif [[ "$relay" != false ]]; then note "EMBERPATH_PASSWORD_RELAY=$relay is kept in $emberpath: Emberpath still accepts passwords for Oathweave accounts. Remove the line, or set it to false, to turn the relay off"
  fi
fi
# Products that verify Oathweave's browser tokens on this host must name the same issuer.
for name in emberpath hivemem hiveskills; do
  placed "$name" && [[ -n "$issuer" ]] || continue
  file=$(service_environment "$name" 2>/dev/null) || continue
  expected=$(get "$file" OATHWEAVE_ISSUER)
  [[ -z "$expected" || "$expected" == "$issuer" ]] || problem "$name verifies OATHWEAVE_ISSUER=$expected in $file, not Oathweave's browser issuer $issuer"
done

result() { # RECREATED BACKUP REPINNED
  jq -nc --arg host "$host" --arg issuer "$issuer" --argjson check "$([[ "$mode" == check ]] && printf true || printf false)" --argjson changes "$changes" \
    --argjson kept "$kept" --argjson problems "$problems" --argjson recreated "${1:-[]}" --arg backup "${2:-}" --argjson repinned "${3:-false}" \
    '{check:$check,host:$host,issuer:(if $issuer=="" then null else $issuer end),changes:($changes|map(del(.values))),kept:$kept,problems:$problems,recreated:$recreated}+(if $backup=="" then {} else {backup:$backup,repinned:$repinned} end)'
}
if [[ "$mode" == check || "$changes" == '[]' ]]; then result; exit 0; fi

# ---- apply ----
[[ ! -L "$directory/controller.lock" ]] || die 'Unsafe controller lock'
exec 9>"$directory/controller.lock"
flock -n 9 || die 'Another controller holds this host'
while IFS= read -r file; do
  [[ -w "$file" && -w "$(dirname -- "$file")" ]] || die "$file cannot be written by $(id -un); set hosts.$host.sudoPasswordFile in the installation file, or run as the installation's owner"
done < <(jq -r '.[].file' <<< "$changes")
receipt="$directory/receipt.json"
plan=$(jq -r '.plan // empty' "$receipt")
definition="$directory/candidate.$plan.json"; [[ -n "$plan" && -f "$definition" ]] || definition=$compose
pin="$directory/deployment-inputs.$plan.json"
before=$(deployment_inputs_digest "$definition") || die 'The deployment inputs cannot be read safely'
# The active plan's pin moves with this change only when nothing else changed since it was taken.
repin=false
if [[ -n "$plan" && -f "$pin" && ! -L "$pin" ]] && [[ $(jq -r .sha256 "$pin") == "$before" && $(jq -r '.deploymentInputSHA256 // empty' "$receipt") == "$before" ]]; then repin=true; fi
[[ ! -L "$config/.browser-signin" ]] || die 'Unsafe backup directory'
install -d -m 700 -- "$config/.browser-signin"
backup="$config/.browser-signin/$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$backup" ]] || die 'A backup of this second already exists; repeat the command'
install -d -m 700 -- "$backup"
initializer="$config/.initializer/receipt.json"
# Fresh setup records the bytes of every file it wrote; a changed file is recorded again below, so
# the previous record is kept with the files for an undo (certificate renewal refuses a file whose
# bytes differ from the record).
recorded=false
if [[ -f "$initializer" && ! -L "$initializer" ]] && jq -e --argjson changes "$changes" 'any($changes[].file as $path | .files[$path]!=null; .)' "$initializer" >/dev/null; then
  cp -p -- "$initializer" "$backup/initializer-receipt.json"; recorded=true
fi
replace_json() { # FILE (JSON on standard input)
  local temporary; temporary=$(mktemp "$(dirname -- "$1")/.browser-signin.XXXXXX")
  cat > "$temporary"; chown --reference="$1" -- "$temporary"; chmod --reference="$1" -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$1"
}
while IFS= read -r change; do
  file=$(jq -r .file <<< "$change")
  values=$(jq -c .values <<< "$change")
  jq -e --arg sq "'" 'all(to_entries[]; (.key|test("^[A-Z][A-Z0-9_]*$")) and (.value|type)=="string" and (.value|contains($sq)|not) and (.value|test("[\n\r]")|not))' <<< "$values" >/dev/null || die 'A value cannot be represented in an environment file'
  cp -p -- "$file" "$backup/$(jq -r .service <<< "$change").env"
  keys=$(jq -r 'keys|join("|")' <<< "$values")
  temporary=$(mktemp "$(dirname -- "$file")/.browser-signin.XXXXXX")
  { grep -vE "^($keys)=" -- "$file" || true; jq -r --arg sq "'" 'to_entries[]|.key+"="+$sq+.value+$sq' <<< "$values"; } > "$temporary"
  chown --reference="$file" -- "$temporary"; chmod --reference="$file" -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$file"
  if [[ -f "$initializer" && ! -L "$initializer" ]] && jq -e --arg path "$file" '.files[$path]!=null' "$initializer" >/dev/null; then
    jq --arg path "$file" --arg sha "$(sha256sum -- "$file" | cut -d ' ' -f1)" '.files[$path]=$sha' "$initializer" | replace_json "$initializer"
  fi
done < <(jq -c '.[]' <<< "$changes")
jq -n --arg host "$host" --argjson changes "$changes" --argjson repin "$repin" --arg pin "$pin" --arg receipt "$receipt" --argjson recorded "$recorded" --arg initializer "$initializer" \
  '{schema:1,host:$host,changes:($changes|map({service,file,keys,policies}))}+(if $repin then {pinned:[$pin,$receipt]} else {} end)+(if $recorded then {initializer:$initializer} else {} end)' > "$backup/changes.json"
if [[ "$repin" == true ]]; then
  cp -p -- "$pin" "$backup/${pin##*/}"; cp -p -- "$receipt" "$backup/receipt.json"
  after=$(deployment_inputs_digest "$definition") || die 'The deployment inputs cannot be read after the change'
  jq --arg sha "$after" '.sha256=$sha' "$pin" | replace_json "$pin"
  jq --arg sha "$after" '.deploymentInputSHA256=$sha' "$receipt" | replace_json "$receipt"
fi
recreated='[]'
for service in $(jq -r '.[].service' <<< "$changes"); do
  docker compose -f "$compose" up -d --no-deps --force-recreate "$service" >/dev/null 2>&1 ||
    die "The settings are written, but $service did not start again; the previous files are in $backup. Run hive.sh doctor"
  container=$(docker compose -f "$compose" ps -q "$service")
  for _ in $(seq 1 90); do
    [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null) == healthy ]] && break
    sleep 2
  done
  [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null) == healthy ]] ||
    die "$service did not become healthy with the new settings; the previous files are in $backup (see UPGRADING.md, Suite 3.15.1, to roll back)"
  recreated=$(jq -c --arg service "$service" '.+[$service]' <<< "$recreated")
done
result "$recreated" "$backup" "$repin"
