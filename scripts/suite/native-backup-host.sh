#!/usr/bin/env bash
# Host-side coordination only. Magnus owns native file formats, inventory and service handling.
# Definitions are transported before host-runtime.sh; all requests and credentials stay on stdin.
native_backup_error() { printf 'Hive native backup: %s\n' "$*" >&2; return 1; }
native_backup_guard() { [[ $(id -u) == 0 ]] || native_backup_error 'Root transport is required for native backup'; }
native_backup_storage_root() { printf '/var/lib/hive-native-backups\n'; }
native_backup_plain_path() {
  local path=$1 current='' part
  [[ "$path" == /* && "$path" != / && "$path" == "$(realpath -m -- "$path")" ]] || return 1
  local -a parts; IFS=/ read -r -a parts <<< "$path"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue; current="$current/$part"
    [[ ! -L "$current" && ( ! -e "$current" || -d "$current" ) ]] || return 1
  done
}
native_backup_searchable_parent() {
  local path=$1 current='' part
  [[ "$path" == /* ]] || return 1
  local -a parts; IFS=/ read -r -a parts <<< "$(dirname -- "$path")"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    [[ ! -d "${current:-/}" || -x "${current:-/}" ]] || return 1
    current="$current/$part"
    [[ ! -e "$current" || ( -d "$current" && -x "$current" ) ]] || return 1
  done
}
native_backup_private_dir() {
  local path=$1
  native_backup_plain_path "$path" || return 1
  [[ ! -e "$path" || ( -d "$path" && $(stat -c %u "$path") == "$(id -u)" && $(stat -c %a "$path") == 700 ) ]] || return 1
  install -d -m 700 -- "$path"
}
native_backup_context() {
  [[ "$installation" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$ && "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$ && "$plan" =~ ^[a-f0-9]{64}$ ]] || return 1
  NATIVE_BACKUP_BASE="$(native_backup_storage_root)/$installation-$host"
  NATIVE_BACKUP_OPERATION=$(jq -er '.operation // "backup"' <<< "$input") || return 1
  [[ "$NATIVE_BACKUP_OPERATION" =~ ^[a-z-]{1,48}$ && "${archive:-}" =~ ^[A-Za-z0-9.-]{0,96}$ ]] || return 1
  NATIVE_BACKUP_PLAN_ROOT="$NATIVE_BACKUP_BASE/$plan"
  NATIVE_BACKUP_SESSION="$NATIVE_BACKUP_PLAN_ROOT/$(printf '%s\0%s\0%s' "$plan" "$NATIVE_BACKUP_OPERATION" "${archive:-}" | sha256sum | cut -d ' ' -f1)"
  NATIVE_BACKUP_META="$NATIVE_BACKUP_SESSION/coordinator.json"
}
native_backup_write() {
  local file=$1 value=$2
  [[ ! -L "$file" && ! -L "$file.next" ]] || return 1
  (umask 077; printf '%s\n' "$value" > "$file.next") && sync -f "$file.next" && mv -T -- "$file.next" "$file"
}
native_backup_env() {
  jq -Rrs --arg key "$2" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|
    if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$1"
}
native_backup_cli() {
  local root=$1; shift
  (cd -- "$root" && env -i PATH=/usr/bin:/bin AGENT_INSTALL_DIR="$root" /usr/bin/node \
    "$root/node_modules/@hivemagnus/magnus-agent/dist/index.js" --env-file "$root/.env" "$@")
}
native_backup_product() {
  local action=$1 request=$2 root=$3
  printf '%s\n' "$request" | native_backup_cli "$root" native-snapshot "$action" --request-file -
}
native_backup_binding() {
  local root=$1 console_name fqdn port url identity
  jq -e '.placements.magnus!=null and .console!=null' <<< "$input" >/dev/null || native_backup_error 'Owned profiles need their local suite Magnus coordinator' || return 1
  console_name=$(jq -er '.origin|capture("^https://(?<host>[A-Za-z0-9.-]+)(:[0-9]+)?$").host' <<< "$input") || return 1
  fqdn=$(native_backup_env "$root/.env" HOST_FQDN)
  [[ "$fqdn" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || return 1
  port=$(jq -er '[.console.nativeListeners[]?|select(.component=="magnus")|.port]|select(length==1)|.[0]' <<< "$input") || return 1
  url=$(native_backup_env "$root/.env" CONTROL_API_URL)
  [[ "${url%/}" == "https://$console_name:$port" ]] || native_backup_error 'Native node belongs to another Magnus endpoint' || return 1
  identity=$(native_backup_cli "$root" identity show --json) || return 1
  jq -e '.state=="bound" and (.nodeId|type=="string" and test("^[A-Za-z0-9_-]{1,128}$"))' <<< "$identity" >/dev/null || return 1
  jq -nc --arg node "$(jq -er .nodeId <<< "$identity")" --arg fqdn "$fqdn" '{nodeId:$node,nodeFqdn:$fqdn}'
}
# Discover only the installer-owned local native account and the node already bound to this
# suite's canonical Magnus listener. Never enumerate unrelated homes or remote fleet nodes.
# Coverage is explicit: a host without this installation's Magnus component, or a Magnus agent
# installed outside the Hive installer (no ROOT.native-owner.json), is "not included", never an
# error and never silent. An installer-owned root that fails its checks still fails.
native_backup_discover() {
  local required=${1:-false} root reported load owner uid home profile_root install_root present=false binding marker file path
  if ! jq -e '.placements.magnus!=null' <<< "$input" >/dev/null 2>&1; then
    [[ "$required" != true ]] || native_backup_error 'This archive holds native profiles, but this host runs no Magnus component of the installation' || return 1
    printf '{"available":false,"present":false,"included":false,"reason":"no-magnus-component"}\n'; return
  fi
  root=$(systemctl show magnus-agent.service --property=WorkingDirectory --value 2>/dev/null) || root=''
  reported=$root
  load=$(systemctl show magnus-agent.service --property=LoadState --value 2>/dev/null) || load=''
  root=${root:-/opt/magnus-agent}; marker="$root.native-owner.json"
  native_backup_searchable_parent "$root" || native_backup_error 'Native installation parent cannot be inspected; use root transport' || return 1
  if [[ -n "$reported" || "$load" == loaded || -d "$root" || -e "$marker" || -L "$root" || -L "$marker" ]]; then native_backup_guard || return 1; fi
  if [[ ! -e "$root/.env" && ! -e "$marker" && ! -L "$marker" ]]; then printf '{"available":false,"present":false,"included":false,"reason":"no-native-agent"}\n'; return; fi
  native_backup_guard || return 1
  # The installer records the account it created. A Magnus agent installed any other way, such
  # as a fleet agent, belongs to its own tooling: Hive neither stops nor archives it.
  if [[ ! -e "$marker" && ! -L "$marker" ]]; then
    [[ "$required" != true ]] || native_backup_error "This archive holds native profiles, but the Magnus agent at $root was installed outside the Hive installer" || return 1
    jq -nc --arg root "$root" '{available:false,present:false,included:false,reason:"not-installer-owned",root:$root}'; return
  fi
  native_backup_plain_path "$root" || native_backup_error "Installer-owned native root $root is not a plain path" || return 1
  [[ -d "$root" && $(stat -c %u "$root") == 0 && $(stat -c %a "$root") == 700 ]] || native_backup_error "Installer-owned native root $root must be a root-owned directory with mode 700" || return 1
  for file in "$root/.env" "$marker"; do
    [[ -f "$file" && ! -L "$file" && $(stat -c %u "$file") == 0 && $(stat -c %a "$file") == 600 ]] || native_backup_error 'Native installation provenance is missing or unsafe' || return 1
  done
  owner=$(native_backup_env "$root/.env" ARDENT_OWNER_USER)
  [[ "$owner" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || return 1
  uid=$(id -u "$owner") || return 1; home=$(getent passwd "$owner" | cut -d: -f6)
  jq -e --arg owner "$owner" --argjson uid "$uid" '.schema==1 and .phase=="complete" and .username==$owner and .uid==$uid and .uid>0' "$marker" >/dev/null || native_backup_error "Native ownership record $marker differs from the installed account" || return 1
  native_backup_plain_path "$home" && [[ -d "$home" ]] || return 1
  profile_root=$(native_backup_env "$root/.env" ARDENT_HOME); profile_root=${profile_root:-$home/.ardent}
  install_root=$(native_backup_env "$root/.env" ARDENT_INSTALL_DIR); install_root=${install_root:-$home/.local/share/ardent}
  for path in "$profile_root" "$install_root"; do
    [[ "$path" == "$home/"* ]] && native_backup_plain_path "$path" || return 1
  done
  if [[ -d "$profile_root/profiles" ]] && [[ -n $(find "$profile_root/profiles" -mindepth 1 -maxdepth 1 -print -quit) ]]; then present=true; fi
  if [[ -d "$home/.config/systemd/user" ]] && [[ -n $(find "$home/.config/systemd/user" -maxdepth 1 -name 'ardent@*.service' -print -quit) ]]; then present=true; fi
  if [[ "$present" == false && "$required" != true ]]; then
    jq -nc --arg root "$root" '{available:true,present:false,included:true,root:$root}'; return
  fi
  binding=$(native_backup_binding "$root") || return 1
  jq -nc --arg root "$root" --argjson binding "$binding" --argjson present "$present" '$binding+{available:true,present:$present,included:true,root:$root}'
}
# What a backup covers, for its receipt: {included, reason, root}.
native_backup_coverage() {
  local found
  found=$(native_backup_discover) || return 1
  jq -c '{included:(.available==true),reason:(.reason // null),root:(.root // null)}' <<< "$found"
}
# Say plainly when native profiles are left out, so an operator never assumes they are covered.
native_backup_notice() {
  case $(jq -r '.reason // ""' <<< "$1") in
    no-magnus-component) printf 'Hive native backup: native profiles not included: this host runs no Magnus component of the installation. Agents installed outside the Hive installer are not part of Hive backups.\n' >&2;;
    not-installer-owned) printf 'Hive native backup: native profiles not included: the Magnus agent at %s was installed outside the Hive installer (it has no %s.native-owner.json). Agents installed outside the Hive installer are not part of Hive backups; back them up with their own tooling.\n' "$(jq -r .root <<< "$1")" "$(jq -r .root <<< "$1")" >&2;;
  esac
  return 0
}
native_backup_present() { local found; found=$(native_backup_discover) || return 1; jq -e '.present==true' <<< "$found" >/dev/null; }
native_backup_overlap() {
  local roots
  roots=$(jq -c '.target|{root,install}' <<< "$1") || return 1
  jq -e --argjson roots "$roots" '
    def overlaps($a;$b): $a==$b or ($a|startswith($b+"/")) or ($b|startswith($a+"/"));
    all(.agents[]?; .profileDirectory as $p | ([ $roots.root,$roots.install ]|all(.[]; overlaps($p;.)|not)))' <<< "$input" >/dev/null ||
    native_backup_error 'Declared agents overlap Magnus native custody; select one recovery owner'
}
native_backup_inspect() {
  local discovery=$1 inventory
  inventory=$(native_backup_product inspect '{}' "$(jq -er .root <<< "$discovery")") || native_backup_error 'Installed Magnus lacks a usable native-snapshot CLI; update it before backing up these profiles' || return 1
  jq -e '.schemaVersion==1 and (.inventorySha256|test("^[a-f0-9]{64}$")) and (.targetSha256|test("^[a-f0-9]{64}$")) and (.profiles|type=="array") and .target.uid>0' <<< "$inventory" >/dev/null || return 1
  native_backup_overlap "$inventory" || return 1
  printf '%s\n' "$inventory"
}
native_backup_bytes_kib() { jq -r '([.trees[].entries[]|select(.kind=="file")|.size]|add // 0)|(. / 1024|ceil)' <<< "$1"; }
native_backup_space_kib() {
  local found inventory
  found=$(native_backup_discover) || return 1
  if ! jq -e '.present==true' <<< "$found" >/dev/null; then printf '0\n'; return; fi
  inventory=$(native_backup_inspect "$found") || return 1
  native_backup_bytes_kib "$inventory"
}
native_backup_free_kib() { df -Pk -- "$1" | awk 'NR==2 {print $4}'; }
native_backup_coordinator() {
  local action=$1 meta=$2 code request result
  code=$(jq -er .nativeBackupTool <<< "$input" | base64 -d) || return 1
  request=$(jq -c --arg action "$action" '{action:$action,nodeId,nodeFqdn,session:(.fenceSession // .session)}' <<< "$meta") || return 1
  result=$(printf '%s\n' "$request" | docker compose -f "$directory/compose.json" exec -T magnus node --input-type=module -e "$code" -- --hive-native-backup) || return 1
  jq -e --argjson request "$request" --arg action "$action" '.schema==1 and .verified==true and .nodeId==$request.nodeId and .nodeFqdn==$request.nodeFqdn and .session==$request.session and .action==$action and .closed==($action!="release")' <<< "$result" >/dev/null || return 1
  printf '%s\n' "$result"
}
native_backup_load() {
  native_backup_context || return 1
  [[ -f "$NATIVE_BACKUP_META" && ! -L "$NATIVE_BACKUP_META" && $(stat -c %u "$NATIVE_BACKUP_META") == "$(id -u)" && $(stat -c %a "$NATIVE_BACKUP_META") == 600 ]] || return 1
  jq -e --arg installation "$installation" --arg host "$host" --arg plan "$plan" --arg operation "$NATIVE_BACKUP_OPERATION" --arg archive "${archive:-}" '
    .schema==1 and .installation==$installation and .host==$host and .plan==$plan and .operation==$operation and .archive==$archive and
    (.session|test("^[a-f0-9-]{36}$")) and (.fenceSession|test("^[a-f0-9-]{36}$")) and
    (.nodeId|test("^[A-Za-z0-9_-]{1,128}$")) and (.nodeFqdn|test("^[A-Za-z0-9.-]+$"))' "$NATIVE_BACKUP_META" >/dev/null || return 1
  cat -- "$NATIVE_BACKUP_META"
}
native_backup_stopped_inventory() {
  local meta=$1 journal="$NATIVE_BACKUP_SESSION/state/journal.json" reservation current
  reservation="$(jq -er .root <<< "$meta")/.native-snapshot-reservation.json"
  for file in "$journal" "$reservation"; do
    [[ -f "$file" && ! -L "$file" && $(stat -c %u "$file") == "$(id -u)" && $(stat -c %a "$file") == 600 ]] || return 1
  done
  jq -e --argjson meta "$meta" '.session==$meta.session and .targetSha256==$meta.targetSha256 and (.phase=="stopped" or .phase=="captured" or .phase=="restored") and .stoppedInventorySha256==$meta.stoppedInventorySHA256' "$journal" >/dev/null || return 1
  jq -e --argjson meta "$meta" --arg state "$NATIVE_BACKUP_SESSION/state" '.session==$meta.session and .state==$state and .targetSha256==$meta.targetSha256' "$reservation" >/dev/null || return 1
  current=$(native_backup_product inspect '{}' "$(jq -er .root <<< "$meta")") || return 1
  [[ $(jq -er .inventorySha256 <<< "$current") == "$(jq -er .stoppedInventorySHA256 <<< "$meta")" ]] || return 1
  printf '%s\n' "$current"
}
native_backup_completed_archive() {
  local meta=$1 record
  [[ "$NATIVE_BACKUP_OPERATION" != restore && -d "$directory/backups/$archive" ]] || return 1
  declare -F verify_archive >/dev/null && (verify_archive) || return 1
  record=$(tar -xOzf "$directory/backups/$archive/state.tar.gz" native-profiles/coordinator.json) || return 1
  jq -e --argjson meta "$meta" '.schema==1 and .installation==$meta.installation and .host==$meta.host and .nodeId==$meta.nodeId and .nodeFqdn==$meta.nodeFqdn and .session==$meta.session and .manifestSHA256==$meta.manifestSHA256 and .targetSha256==$meta.targetSha256' <<< "$record" >/dev/null
}
native_backup_retry_released() {
  local meta=$1 journal="$NATIVE_BACKUP_SESSION/state/journal.json" release="$NATIVE_BACKUP_SESSION/release.json" previous
  [[ "$NATIVE_BACKUP_OPERATION" != restore && ! -e "$directory/backups/$archive" && ! -L "$directory/backups/$archive" ]] || return 1
  [[ ! -e "$(jq -er .root <<< "$meta")/.native-snapshot-reservation.json" && ! -L "$(jq -er .root <<< "$meta")/.native-snapshot-reservation.json" ]] || return 1
  [[ ! -e "$directory/native-capture.$plan.$archive/native-profiles" && ! -L "$directory/native-capture.$plan.$archive/native-profiles" ]] || return 1
  for file in "$journal" "$release"; do
    [[ -f "$file" && ! -L "$file" && $(stat -c %u "$file") == "$(id -u)" && $(stat -c %a "$file") == 600 ]] || return 1
  done
  jq -e --argjson meta "$meta" '.session==$meta.session and .targetSha256==$meta.targetSha256 and .phase=="resumed"' "$journal" >/dev/null || return 1
  jq -e --argjson meta "$meta" '.schema==1 and .action=="release" and .verified==true and .closed==false and .nodeId==$meta.nodeId and .nodeFqdn==$meta.nodeFqdn and .session==$meta.fenceSession' "$release" >/dev/null || return 1
  previous="$NATIVE_BACKUP_SESSION.previous-$(jq -er .session <<< "$meta")"
  [[ ! -e "$previous" && ! -L "$previous" ]] || return 1
  mv -T -- "$NATIVE_BACKUP_SESSION" "$previous"
}
native_backup_begin() {
  local required=${1:-false} found inventory summary bytes parent free meta session quiesced
  native_backup_context || return 1
  if [[ -e "$NATIVE_BACKUP_META" ]]; then
    meta=$(native_backup_load) || return 1
    case $(jq -er .phase <<< "$meta") in
      quiesced|captured) native_backup_stopped_inventory "$meta" >/dev/null; return $?;;
      released)
        if native_backup_completed_archive "$meta"; then return 0; fi
        native_backup_retry_released "$meta" || native_backup_error "This native session needs inspection before retry: $NATIVE_BACKUP_SESSION" || return 1;;
      *) native_backup_error "An existing native session needs recovery: $NATIVE_BACKUP_SESSION"; return 1;;
    esac
  fi
  found=$(native_backup_discover "$required") || return 1
  native_backup_notice "$found"
  if [[ "$required" != true ]] && ! jq -e '.present==true' <<< "$found" >/dev/null; then return 0; fi
  jq -e '.available==true and (.root|type=="string")' <<< "$found" >/dev/null || return 1
  inventory=$(native_backup_inspect "$found") || return 1
  [[ "$required" == true || $(jq '.profiles|length' <<< "$inventory") != 0 ]] || return 0
  bytes=$(native_backup_bytes_kib "$inventory"); parent=$(native_backup_storage_root)
  while [[ ! -d "$parent" ]]; do parent=$(dirname -- "$parent"); done
  free=$(native_backup_free_kib "$parent")
  [[ "$free" =~ ^[0-9]+$ ]] && ((free >= bytes * 2 + 65536)) || native_backup_error 'Insufficient root-private native snapshot space; no service was stopped' || return 1
  native_backup_private_dir "$(native_backup_storage_root)" && native_backup_private_dir "$NATIVE_BACKUP_BASE" && native_backup_private_dir "$NATIVE_BACKUP_PLAN_ROOT" && native_backup_private_dir "$NATIVE_BACKUP_SESSION" || return 1
  session=$(cat /proc/sys/kernel/random/uuid)
  summary=$(jq -c '{targetSha256,inventorySha256}' <<< "$inventory") || return 1
  meta=$(jq -nc --arg installation "$installation" --arg host "$host" --arg plan "$plan" --arg operation "$NATIVE_BACKUP_OPERATION" --arg archive "${archive:-}" --arg session "$session" --argjson found "$found" --argjson inventory "$summary" \
    '{schema:1,installation:$installation,host:$host,plan:$plan,operation:$operation,archive:$archive,session:$session,fenceSession:$session,nodeId:$found.nodeId,nodeFqdn:$found.nodeFqdn,root:$found.root,targetSha256:$inventory.targetSha256,inventorySHA256:$inventory.inventorySha256,phase:"created"}')
  native_backup_write "$NATIVE_BACKUP_META" "$meta" || return 1
  native_backup_coordinator reserve "$meta" > "$NATIVE_BACKUP_SESSION/reserve.json" || native_backup_error "Native admission remains held; inspect $NATIVE_BACKUP_SESSION" || return 1
  meta=$(jq '.phase="reserved"' <<< "$meta"); native_backup_write "$NATIVE_BACKUP_META" "$meta" || return 1
  quiesced=$(native_backup_product quiesce "$(jq -nc --arg session "$session" --arg state "$NATIVE_BACKUP_SESSION/state" --arg inventory "$(jq -er .inventorySha256 <<< "$inventory")" '{session:$session,state:$state,expectedInventorySha256:$inventory}')" "$(jq -er .root <<< "$found")") || native_backup_error "Native shutdown requires recovery: $NATIVE_BACKUP_SESSION" || return 1
  jq -e --arg session "$session" '.session==$session and (.stoppedInventorySha256|test("^[a-f0-9]{64}$"))' <<< "$quiesced" >/dev/null || return 1
  meta=$(jq --arg sha "$(jq -er .stoppedInventorySha256 <<< "$quiesced")" '.phase="quiesced"|.stoppedInventorySHA256=$sha' <<< "$meta"); native_backup_write "$NATIVE_BACKUP_META" "$meta" || return 1
  native_backup_coordinator verify "$meta" > "$NATIVE_BACKUP_SESSION/verify.json" || native_backup_error "Native fence verification failed; inspect $NATIVE_BACKUP_SESSION" || return 1
}
native_backup_validate_wrapper() {
  local source=$1
  [[ -d "$source" && ! -L "$source" && "$source" == "$(realpath -m -- "$source")" && -f "$source/coordinator.json" && ! -L "$source/coordinator.json" && -d "$source/bundle" && ! -L "$source/bundle" ]] || return 1
  (( $(stat -c %s "$source/coordinator.json") <= 16384 )) || return 1
  [[ -z $(find "$source" \( \( ! -type f ! -type d \) -o \( -type f -links +1 \) \) -print -quit) ]] || return 1
  [[ $(find "$source" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort) == $'bundle\ncoordinator.json' ]] || return 1
  jq -e --arg installation "$installation" --arg host "$host" '(keys==(["schema","installation","host","nodeId","nodeFqdn","session","manifestSHA256","targetSha256","profiles"]|sort)) and .schema==1 and .installation==$installation and .host==$host and (.nodeId|test("^[A-Za-z0-9_-]{1,128}$")) and (.nodeFqdn|type=="string" and length<=253 and test("^[A-Za-z0-9.-]+$")) and (.session|test("^[a-f0-9-]{36}$")) and (.manifestSHA256|test("^[a-f0-9]{64}$")) and (.targetSha256|test("^[a-f0-9]{64}$")) and (.profiles|type=="number" and .>0 and .<=128)' "$source/coordinator.json" >/dev/null
}
native_backup_verify() {
  local source=$1 found record work verified needed free status=0
  native_backup_guard && native_backup_validate_wrapper "$source" || native_backup_error 'Native archive wrapper is missing, unsafe or belongs to another installation' || return 1
  found=$(native_backup_discover true) || return 1
  record=$(cat "$source/coordinator.json")
  jq -e --argjson found "$found" '.nodeId==$found.nodeId and .nodeFqdn==$found.nodeFqdn' <<< "$record" >/dev/null || return 1
  native_backup_private_dir "$(native_backup_storage_root)" || return 1
  needed=$(du -sk -- "$source/bundle" | awk '{print $1}')
  free=$(native_backup_free_kib "$(native_backup_storage_root)")
  [[ "$needed" =~ ^[0-9]+$ && "$free" =~ ^[0-9]+$ ]] && (( free >= needed + 65536 )) || return 1
  work=$(mktemp -d "$(native_backup_storage_root)/verify.XXXXXX") || return 1
  if ! cp -a -- "$source/bundle" "$work/bundle"; then rm -rf -- "$work"; return 1; fi
  if ! jq -e --arg session "$(jq -er .session <<< "$record")" '.session==$session' "$work/bundle/manifest.json" >/dev/null; then rm -rf -- "$work"; return 1; fi
  if verified=$(native_backup_product verify "$(jq -nc --arg source "$work/bundle" '{source:$source}')" "$(jq -er .root <<< "$found")"); then :; else status=1; fi
  rm -rf -- "$work"
  ((status==0)) || return 1
  jq -e --argjson record "$record" '.manifestSHA256==$record.manifestSHA256 and .targetSha256==$record.targetSha256 and (.profiles|length)==$record.profiles' <<< "$verified" >/dev/null || return 1
  jq -c --argjson record "$record" '{verified:true,manifestSHA256,profiles:(.profiles|length),session:$record.session,nodeId:$record.nodeId,nodeFqdn:$record.nodeFqdn,targetSha256}' <<< "$verified"
}
native_backup_capture() {
  local destination=$1 meta captured record verified
  native_backup_context || return 1
  if [[ ! -e "$NATIVE_BACKUP_META" ]]; then [[ ! -e "$destination" && ! -L "$destination" ]]; return $?; fi
  meta=$(native_backup_load) || return 1
  if [[ $(jq -r .phase <<< "$meta") == released ]]; then
    native_backup_completed_archive "$meta" && [[ ! -e "$destination" && ! -L "$destination" ]]; return $?
  fi
  [[ $(jq -r .phase <<< "$meta") == quiesced || $(jq -r .phase <<< "$meta") == captured ]] || return 1
  [[ "$destination" == "$directory/"* && "$destination" == "$(realpath -m -- "$destination")" && ! -L "$destination" ]] || return 1
  if [[ -e "$destination" ]]; then
    native_backup_validate_wrapper "$destination" || return 1
    jq -e --argjson meta "$meta" '.session==$meta.session and .nodeId==$meta.nodeId and .nodeFqdn==$meta.nodeFqdn and .targetSha256==$meta.targetSha256' "$destination/coordinator.json" >/dev/null ||
      native_backup_error 'Existing native capture belongs to another session; retain it for recovery' || return 1
    verified=$(native_backup_verify "$destination") || return 1
    if [[ $(jq -r .phase <<< "$meta") == captured ]]; then
      [[ $(jq -er .manifestSHA256 <<< "$verified") == "$(jq -er .manifestSHA256 <<< "$meta")" ]] || return 1
    fi
    meta=$(jq --arg sha "$(jq -er .manifestSHA256 <<< "$verified")" '.phase="captured"|.manifestSHA256=$sha' <<< "$meta")
    native_backup_write "$NATIVE_BACKUP_META" "$meta"; return $?
  fi
  [[ "$destination" == "$directory/"* && "$destination" == "$(realpath -m -- "$destination")" && ! -e "$destination" && ! -L "$destination" ]] || return 1
  native_backup_coordinator verify "$meta" > "$NATIVE_BACKUP_SESSION/capture-fence.json" || return 1
  if [[ $(jq -r .phase <<< "$meta") == captured ]]; then
    captured=$(native_backup_product verify "$(jq -nc --arg source "$NATIVE_BACKUP_SESSION/bundle" '{source:$source}')" "$(jq -er .root <<< "$meta")") || return 1
    captured=$(jq --arg session "$(jq -er .session <<< "$meta")" '.session=$session' <<< "$captured")
  else
    captured=$(native_backup_product capture "$(jq -nc --arg state "$NATIVE_BACKUP_SESSION/state" --arg destination "$NATIVE_BACKUP_SESSION/bundle" '{state:$state,destination:$destination}')" "$(jq -er .root <<< "$meta")") || return 1
  fi
  jq -e --argjson meta "$meta" '.session==$meta.session and .targetSha256==$meta.targetSha256 and (.manifestSHA256|test("^[a-f0-9]{64}$")) and (.profiles|length)>0' <<< "$captured" >/dev/null || return 1
  record=$(jq -c '{manifestSHA256,targetSha256,profiles:(.profiles|length)}' <<< "$captured") || return 1
  record=$(jq --argjson captured "$record" '{schema:1,installation,host,nodeId,nodeFqdn,session,manifestSHA256:$captured.manifestSHA256,targetSha256:$captured.targetSha256,profiles:$captured.profiles}' <<< "$meta")
  install -d -m 700 -- "$destination" && cp -a -- "$NATIVE_BACKUP_SESSION/bundle" "$destination/bundle" || return 1
  native_backup_write "$destination/coordinator.json" "$record" || return 1
  native_backup_verify "$destination" >/dev/null || return 1
  meta=$(jq --arg sha "$(jq -er .manifestSHA256 <<< "$captured")" '.phase="captured"|.manifestSHA256=$sha' <<< "$meta"); native_backup_write "$NATIVE_BACKUP_META" "$meta"
}
native_backup_restore() {
  local restored=$1 source="$1/native-profiles" meta verified acknowledgement expected current result archived restore_source copied
  native_backup_context || native_backup_error 'Native restore context is invalid; no profile was promoted' || return 1
  [[ -e "$source" ]] || return 0
  verified=$(native_backup_verify "$source") || return 1
  meta=$(native_backup_load) || native_backup_error 'Native restore has no quiesced current session' || return 1
  [[ $(jq -r .phase <<< "$meta") == quiesced ]] || return 1
  acknowledgement=$(jq -ce --arg host "$host" '.hosts[$host].nativeProfiles|select(type=="object")' "$directory/reconciliation.$plan.json") || return 1
  jq -e --arg sha "$(jq -er .manifestSHA256 <<< "$verified")" '.archiveManifestSHA256==$sha and (.currentInventorySHA256|test("^[a-f0-9]{64}$"))' <<< "$acknowledgement" >/dev/null || return 1
  expected=$(jq -er .currentInventorySHA256 <<< "$acknowledgement")
  [[ "$expected" == "$(jq -er .stoppedInventorySHA256 <<< "$meta")" ]] || native_backup_error 'Native inventory differs from write reconciliation' || return 1
  current=$(native_backup_product inspect '{}' "$(jq -er .root <<< "$meta")") || return 1
  [[ $(jq -er .inventorySha256 <<< "$current") == "$expected" ]] || return 1
  # The suite API is deliberately stopped after restore preparation. Its exact
  # durable fence record and product reservation, not a new API call, own this phase.
  native_backup_stopped_inventory "$meta" >/dev/null || return 1
  restore_source="$NATIVE_BACKUP_SESSION/restore-source"
  [[ ! -e "$restore_source" && ! -L "$restore_source" ]] || native_backup_error 'A prior native restore source needs inspection' || return 1
  native_backup_private_dir "$restore_source" && cp -a -- "$source/bundle" "$restore_source/bundle" || return 1
  copied=$(native_backup_product verify "$(jq -nc --arg source "$restore_source/bundle" '{source:$source}')" "$(jq -er .root <<< "$meta")") || return 1
  [[ $(jq -er .manifestSHA256 <<< "$copied") == "$(jq -er .manifestSHA256 <<< "$verified")" ]] || return 1
  result=$(native_backup_product restore "$(jq -nc --arg state "$NATIVE_BACKUP_SESSION/state" --arg source "$restore_source/bundle" --arg expected "$expected" '{state:$state,source:$source,expectedCurrent:$expected}')" "$(jq -er .root <<< "$meta")") || return 1
  jq -e --arg sha "$(jq -er .manifestSHA256 <<< "$verified")" '.restored==true and .manifestSHA256==$sha' <<< "$result" >/dev/null || return 1
  archived=$(jq -er .session <<< "$verified")
  meta=$(jq --arg archived "$archived" --arg sha "$(jq -er .manifestSHA256 <<< "$verified")" '.phase="restored"|.fenceSession=$archived|.manifestSHA256=$sha' <<< "$meta")
  native_backup_write "$NATIVE_BACKUP_META" "$meta"
}
native_backup_reconciliation() {
  local archived=$1 meta
  [[ "$archived" =~ ^[a-f0-9]{64}$ ]] || return 1
  native_backup_context || return 1
  if [[ ! -e "$NATIVE_BACKUP_META" ]]; then printf 'null\n'; return; fi
  meta=$(native_backup_load) || return 1
  case $(jq -er .phase <<< "$meta") in quiesced|captured) ;; *) return 1;; esac
  native_backup_stopped_inventory "$meta" >/dev/null || return 1
  jq -nc --arg archived "$archived" --arg current "$(jq -er .stoppedInventorySHA256 <<< "$meta")" '{archiveManifestSHA256:$archived,currentInventorySHA256:$current}'
}
native_backup_compact() {
  local meta=$1 path label manifest release="$NATIVE_BACKUP_SESSION/release.json" journal="$NATIVE_BACKUP_SESSION/state/journal.json"
  local -a payloads=()
  native_backup_guard || return 1
  [[ $(jq -er .phase <<< "$meta") == released ]] || return 1
  for path in "$(native_backup_storage_root)" "$NATIVE_BACKUP_BASE" "$NATIVE_BACKUP_PLAN_ROOT" "$NATIVE_BACKUP_SESSION"; do
    native_backup_plain_path "$path" && [[ -d "$path" && $(stat -c %u "$path") == "$(id -u)" && $(stat -c %a "$path") == 700 ]] || return 1
  done
  for path in "$release" "$journal"; do
    [[ -f "$path" && ! -L "$path" && $(stat -c %u "$path") == "$(id -u)" && $(stat -c %a "$path") == 600 ]] || return 1
  done
  path="$NATIVE_BACKUP_SESSION/restore-source"
  if [[ -e "$path" || -L "$path" ]]; then
    native_backup_plain_path "$path" && [[ -d "$path" && $(stat -c %u "$path") == "$(id -u)" && $(stat -c %a "$path") == 700 ]] || return 1
  fi
  jq -e --argjson meta "$meta" '.session==$meta.session and .targetSha256==$meta.targetSha256 and .phase=="resumed"' "$journal" >/dev/null || return 1
  jq -e --argjson meta "$meta" '.schema==1 and .verified==true and .action=="release" and .closed==false and .session==$meta.fenceSession and .nodeId==$meta.nodeId and .nodeFqdn==$meta.nodeFqdn' "$release" >/dev/null || return 1
  # Validate both inert storage copies before deleting either. Product promotion
  # checkpoints and all journals/receipts are outside these exact payload paths.
  for label in bundle restore-source/bundle; do
    path="$NATIVE_BACKUP_SESSION/$label"
    [[ -e "$path" || -L "$path" ]] || continue
    native_backup_plain_path "$path" && [[ -d "$path" ]] || return 1
    manifest="$path/manifest.json"
    [[ -f "$manifest" && ! -L "$manifest" && $(stat -c %h "$manifest") == 1 ]] || return 1
    [[ $(sha256sum -- "$manifest" | cut -d ' ' -f1) == "$(jq -er .manifestSHA256 <<< "$meta")" ]] || return 1
    jq -e --argjson meta "$meta" '.session==$meta.fenceSession and .targetSha256==$meta.targetSha256' "$manifest" >/dev/null || return 1
    [[ -z $(find "$path" \( \( ! -type f ! -type d \) -o \( -type f -links +1 \) \) -print -quit) ]] || return 1
    if [[ -e "$path/files" ]]; then
      [[ -d "$path/files" ]] || return 1
      payloads+=("$path/files")
    fi
  done
  for path in "${payloads[@]}"; do rm -rf -- "$path" || return 1; sync -f "$(dirname -- "$path")" || return 1; done
  native_backup_write "$NATIVE_BACKUP_SESSION/compacted.json" "$(jq -nc --arg session "$(jq -er .session <<< "$meta")" '{schema:1,session:$session,phase:"released",payloadsRemoved:true,manifestsRetained:true}')"
}
native_backup_finish_cleanup() {
  local meta=$1 receipt="$NATIVE_BACKUP_SESSION/cleanup-required.json" required=true
  if native_backup_compact "$meta"; then
    [[ -e "$receipt" || -L "$receipt" ]] || return 0
    required=false
  else
    printf 'Hive native backup: services resumed and admission released; private payload cleanup needs inspection: %s\n' "$NATIVE_BACKUP_SESSION" >&2
  fi
  # Cleanup follows a proven release. A storage problem cannot turn already
  # running services back into a held restore or a failed snapshot transaction.
  if native_backup_plain_path "$NATIVE_BACKUP_SESSION" && [[ -d "$NATIVE_BACKUP_SESSION" && $(stat -c %u "$NATIVE_BACKUP_SESSION") == "$(id -u)" && $(stat -c %a "$NATIVE_BACKUP_SESSION") == 700 ]]; then
    native_backup_write "$receipt" "$(jq -nc --arg session "$(jq -er .session <<< "$meta")" --argjson required "$required" '{schema:1,session:$session,phase:"released",required:$required,reason:"private-payload-compaction"}')" ||
      printf 'Hive native backup: could not record the private payload cleanup notice\n' >&2
  fi
  return 0
}
native_backup_finish() {
  local meta phase result
  native_backup_context || return 1
  [[ -e "$NATIVE_BACKUP_META" ]] || return 0
  meta=$(native_backup_load) || return 1; phase=$(jq -er .phase <<< "$meta")
  if [[ "$phase" == released ]]; then native_backup_finish_cleanup "$meta"; return 0; fi
  case "$phase" in quiesced|captured|restored|resumed) ;; *) native_backup_error "Native session remains held; inspect $NATIVE_BACKUP_SESSION"; return 1;; esac
  native_backup_coordinator verify "$meta" > "$NATIVE_BACKUP_SESSION/finish-fence.json" || native_backup_error "Native admission is not proven; inspect $NATIVE_BACKUP_SESSION" || return 1
  if [[ "$phase" != resumed ]]; then
    result=$(native_backup_product resume "$(jq -nc --arg state "$NATIVE_BACKUP_SESSION/state" '{state:$state}')" "$(jq -er .root <<< "$meta")") || native_backup_error "Native services remain held; inspect $NATIVE_BACKUP_SESSION" || return 1
    jq -e '.resumed==true' <<< "$result" >/dev/null || return 1
    meta=$(jq '.phase="resumed"' <<< "$meta"); native_backup_write "$NATIVE_BACKUP_META" "$meta" || return 1
  fi
  native_backup_coordinator verify "$meta" > "$NATIVE_BACKUP_SESSION/resumed-fence.json" || return 1
  native_backup_coordinator release "$meta" > "$NATIVE_BACKUP_SESSION/release.json" || native_backup_error "Native fence release requires recovery; inspect $NATIVE_BACKUP_SESSION" || return 1
  meta=$(jq '.phase="released"' <<< "$meta"); native_backup_write "$NATIVE_BACKUP_META" "$meta" || return 1
  native_backup_finish_cleanup "$meta"
}
native_backup_suite_serving() {
  local services containers
  services=$(jq -c '.services|keys|sort' "$directory/compose.json") || return 1
  containers=$(docker compose -f "$directory/compose.json" ps --all --format json | jq -sc flatten) || return 1
  jq -e --argjson services "$services" 'length>0 and ([.[].Service]|sort)==$services and all(.[]; .State=="running" and ((.Health // "")=="" or .Health=="healthy"))' <<< "$containers" >/dev/null
}
# This explicit approval is recovery only. Its old scope is local to the call;
# a controller with new source bytes must never silently adopt an old journal.
native_backup_recover() (
  local approval=$1 plan input=$input scope relative meta found inventory transaction="$directory/transaction.json" transaction_sha source_sha coordinator_sha journal_sha session state recovery result current proof completed path file
  native_backup_guard || return 1
  jq -e 'type=="object" and keys==(["sessionDirectory","expectedCurrentInventorySHA256","coordinatorSHA256","journalSHA256","quiescenceEffectsReviewed"]|sort) and
    (.sessionDirectory|type=="string" and length<=4096) and .quiescenceEffectsReviewed==true and
    all(.expectedCurrentInventorySHA256,.coordinatorSHA256,.journalSHA256; type=="string" and test("^[a-f0-9]{64}$"))' <<< "$approval" >/dev/null || return 1
  [[ $(jq -er .operation <<< "$input") == backup && "$archive" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,95}$ ]] || return 1
  source_sha=$(jq -er '.controllerSourceSHA256|select(test("^[a-f0-9]{64}$"))' <<< "$input") || return 1
  scope=$(jq -er .sessionDirectory <<< "$approval")
  relative=${scope#"$(native_backup_storage_root)/$installation-$host/"}
  [[ "$relative" != "$scope" && "$relative" =~ ^[a-f0-9]{64}/[a-f0-9]{64}$ ]] || return 1
  plan=${relative%%/*}; native_backup_context || return 1
  [[ "$NATIVE_BACKUP_SESSION" == "$scope" ]] || return 1
  for path in "$(native_backup_storage_root)" "$NATIVE_BACKUP_BASE" "$NATIVE_BACKUP_PLAN_ROOT" "$scope" "$scope/state"; do
    native_backup_plain_path "$path" && [[ -d "$path" && $(stat -c %u "$path") == "$(id -u)" && $(stat -c %a "$path") == 700 ]] || return 1
  done
  state="$scope/state"
  for file in "$NATIVE_BACKUP_META" "$state/journal.json"; do
    [[ -f "$file" && ! -L "$file" && $(stat -c %h "$file") == 1 && $(stat -c %u "$file") == "$(id -u)" && $(stat -c %a "$file") == 600 ]] || return 1
  done
  (( $(stat -c %s "$NATIVE_BACKUP_META") <= 16384 )) || return 1
  coordinator_sha=$(sha256sum "$NATIVE_BACKUP_META" | cut -d ' ' -f1); journal_sha=$(sha256sum "$state/journal.json" | cut -d ' ' -f1)
  [[ "$coordinator_sha" == "$(jq -er .coordinatorSHA256 <<< "$approval")" && "$journal_sha" == "$(jq -er .journalSHA256 <<< "$approval")" ]] || return 1
  meta=$(native_backup_load) || return 1
  [[ $(jq -er .phase <<< "$meta") == reserved && $(jq -er .session <<< "$meta") == "$(jq -er .fenceSession <<< "$meta")" ]] || return 1
  session=$(jq -er .session <<< "$meta")
  jq -e --argjson meta "$meta" '.phase=="held" and .session==$meta.session and .targetSha256==$meta.targetSha256 and (.promotions|length)==0 and .manifestSHA256==null' "$state/journal.json" >/dev/null || return 1
  [[ -f "$transaction" && ! -L "$transaction" && $(stat -c %h "$transaction") == 1 && $(stat -c %a "$transaction") == 600 && ( $(stat -c %u "$transaction") == 0 || $(stat -c %u "$transaction") == "$(stat -c %u "$directory")" ) ]] || return 1
  jq -e --arg plan "$plan" '.schema==1 and .plan==$plan and .operation=="backup" and .phase=="recovery-required"' "$transaction" >/dev/null || return 1
  transaction_sha=$(sha256sum "$transaction" | cut -d ' ' -f1)
  for path in "$directory/backups/$archive" "$directory/backups/.online-$archive" "$directory/native-capture.$plan.$archive" "$scope/bundle" "$scope/restore-source"; do [[ ! -e "$path" && ! -L "$path" ]] || return 1; done
  native_backup_suite_serving || return 1
  found=$(native_backup_discover true) || return 1
  jq -e --argjson meta "$meta" '.available==true and .nodeId==$meta.nodeId and .nodeFqdn==$meta.nodeFqdn and .root==$meta.root' <<< "$found" >/dev/null || return 1
  inventory=$(native_backup_inspect "$found") || return 1
  jq -e --argjson meta "$meta" --arg current "$(jq -er .expectedCurrentInventorySHA256 <<< "$approval")" '.targetSha256==$meta.targetSha256 and .inventorySha256==$current and .safety.active==0 and .safety.unknown==0 and .safety.unsupported==0 and all((.agent,.profiles[].service); .active==false and .clean==true and .cgroupEmpty==true)' <<< "$inventory" >/dev/null || return 1
  native_backup_coordinator verify "$meta" >/dev/null || return 1
  recovery="$scope/recovery-$journal_sha"
  [[ ! -e "$recovery" && ! -L "$recovery" ]] || return 1
  native_backup_private_dir "$recovery" || return 1
  for file in coordinator journal transaction; do
    case "$file" in coordinator) path=$NATIVE_BACKUP_META;; journal) path="$state/journal.json";; transaction) path=$transaction;; esac
    cp -- "$path" "$recovery/$file.before.json" && chmod 600 "$recovery/$file.before.json" && sync -f "$recovery/$file.before.json" || return 1
  done
  native_backup_write "$recovery/approval.json" "$approval" || return 1
  result=$(native_backup_product recover-quiesce "$(jq -nc --arg state "$state" --arg session "$session" --arg current "$(jq -er .expectedCurrentInventorySHA256 <<< "$approval")" --arg journal "$journal_sha" '{state:$state,session:$session,expectedCurrent:$current,expectedJournalSHA256:$journal}')" "$(jq -er .root <<< "$meta")") || {
    [[ -z "$result" ]] || native_backup_write "$recovery/product-refusal.json" "$result" || true
    native_backup_error "Native recovery remains held; inspect $recovery"; return 1;
  }
  native_backup_write "$recovery/product-recovery.json" "$result" || return 1
  jq -e --arg state "$state" --arg session "$session" --arg target "$(jq -er .targetSha256 <<< "$meta")" --arg previous "$journal_sha" --arg current "$(jq -er .expectedCurrentInventorySHA256 <<< "$approval")" '.schemaVersion==1 and .recovered==true and .state==$state and .session==$session and .targetSha256==$target and .previousJournalSHA256==$previous and .historySHA256==$previous and .historyPath==($state+"/history/journal-"+$previous+".json") and (.journalSHA256|test("^[a-f0-9]{64}$")) and .stoppedInventorySha256==$current and .safety.active==0 and .safety.unknown==0 and .safety.unsupported==0' <<< "$result" >/dev/null || return 1
  path=$(jq -er .historyPath <<< "$result")
  native_backup_plain_path "$(dirname -- "$path")" && [[ $(stat -c %u "$(dirname -- "$path")") == "$(id -u)" && $(stat -c %a "$(dirname -- "$path")") == 700 ]] || return 1
  [[ -f "$path" && ! -L "$path" && $(stat -c %u "$path") == "$(id -u)" && $(stat -c %a "$path") == 600 && $(sha256sum "$path" | cut -d ' ' -f1) == "$journal_sha" ]] || return 1
  [[ $(sha256sum "$state/journal.json" | cut -d ' ' -f1) == "$(jq -er .journalSHA256 <<< "$result")" ]] || return 1
  jq -e --arg session "$session" --arg target "$(jq -er .targetSha256 <<< "$meta")" --arg stopped "$(jq -er .stoppedInventorySha256 <<< "$result")" '.phase=="stopped" and .session==$session and .targetSha256==$target and .stoppedInventorySha256==$stopped' "$state/journal.json" >/dev/null || return 1
  meta=$(jq --arg stopped "$(jq -er .stoppedInventorySha256 <<< "$result")" '.phase="quiesced"|.stoppedInventorySHA256=$stopped' <<< "$meta")
  native_backup_write "$NATIVE_BACKUP_META" "$meta" || return 1
  native_backup_finish || return 1
  current=$(native_backup_product inspect '{}' "$(jq -er .root <<< "$meta")") || return 1
  jq -e --slurpfile previous "$recovery/journal.before.json" '([.agent]+[.profiles[].service]) as $actual | .safety.active==0 and .safety.unknown==0 and .safety.unsupported==0 and ([$actual[]|[.scope,.unit]]|sort)==([$previous[0].activation[]|[.scope,.unit]]|sort) and all($previous[0].activation[]; . as $want | any($actual[]; .unit==$want.unit and .scope==$want.scope and .active==$want.active and .enabled==$want.enabled and .clean==true))' <<< "$current" >/dev/null || return 1
  [[ $(sha256sum "$transaction" | cut -d ' ' -f1) == "$transaction_sha" ]] || return 1
  proof=$(jq -nc --arg session "$session" --arg previous "$transaction_sha" --arg controller "$source_sha" --arg coordinator "$coordinator_sha" --arg journal "$journal_sha" --arg product "$(sha256sum "$recovery/product-recovery.json" | cut -d ' ' -f1)" '{schema:1,recovered:true,archiveCreated:false,session:$session,previousTransactionSHA256:$previous,controllerSourceSHA256:$controller,coordinatorSHA256:$coordinator,journalSHA256:$journal,productRecoverySHA256:$product}')
  native_backup_write "$recovery/recovery.json" "$proof" || return 1
  completed=$(jq --argjson proof "$proof" '.phase="complete"|.nativeRecovery=$proof' "$transaction") || return 1
  native_backup_write "$transaction" "$completed" || return 1
  printf '%s\n' "$proof"
)
