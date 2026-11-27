#!/usr/bin/env bash
# hive.sh uninstall [--purge] and hive.sh remove PRODUCT. Both show their plan and change nothing
# without --yes or an interactive yes. Data, configuration and backups are kept unless uninstall is
# given --purge and the operator types the installation name, which --yes never replaces.
# See deployment/README.md#uninstalling.

# Root is needed to delete DIRECTORY on this machine when a file in it belongs to another account
# (a product's service user), or when its parent is not writable: setup creates /opt/ID with sudo,
# so the operator owns everything inside it but cannot remove the directory itself.
hive_uninstall_needs_sudo() { # DIRECTORY
  local directory=$1
  [[ $(id -u) != 0 && -e "$directory" ]] || return 1
  [[ -n $(find "$directory" ! -user "$(id -u)" -print -quit 2>/dev/null) || ! -w "$(dirname -- "$directory")" ]]
}

hive_uninstall_action() { # HOST ACTION [REQUEST] [SUDO]
  local sudo=${4:-false} remote_sudo=false
  # Deleting an installation needs root for files the products own; on this machine only when
  # such a file exists.
  if [[ "$sudo" == true ]]; then
    if jq -e --arg host "$1" '.hosts[$host].target=="local"' "$HIVE_CONFIG" >/dev/null; then
      local directory
      directory=$(jq -r --arg host "$1" '.hosts[$host].directory' "$HIVE_CONFIG")
      hive_uninstall_needs_sudo "$directory" || sudo=false
    else sudo=false; remote_sudo=true; fi
  fi
  HIVE_HOST_LOCAL_SUDO=$sudo HIVE_HOST_REMOTE_SUDO=$remote_sudo HIVE_HOST_ACTION=$2 HIVE_UNINSTALL_INPUT=${3:-null} \
    hive_host "$1" "$(cat "$HIVE_ROOT/scripts/suite/uninstall-host.sh")"
}

# The console certificate renewal service on this machine, when it renews this installation.
hive_uninstall_certificate_service() {
  local directory=${HIVE_SYSTEMD_DIRECTORY:-/etc/systemd/system} service
  service=$directory/hive-console-certificate.service
  [[ -f "$service" && ! -L "$service" ]] || return 1
  jq -e '.console.host as $host | .hosts[$host].target=="local"' "$HIVE_CONFIG" >/dev/null || return 1
  grep -Eq "^ExecStart=[^ ]+ renew --config ${HIVE_OPERATOR_CONFIG//./\\.}( |$)" "$service"
}

hive_uninstall_has_schedule() {
  local current entries
  command -v crontab >/dev/null || return 1
  current=$(mktemp)
  hive_retention_crontab_read "$current" 2>/dev/null || { rm -f -- "$current"; return 1; }
  entries=$(hive_retention_crontab_entries "$current" "$HIVE_OPERATOR_CONFIG"); rm -f -- "$current"
  [[ -n "$entries" ]]
}

# The Ardent setup receipts of this installation beside its file (ardent-setup/PROFILE.json, which
# names the installation, and PROFILE.lock), so a later installation of the same name starts its
# setup afresh instead of refusing a receipt for another Magnus node. A lock or staging file
# without any receipt goes too; a receipt of another installation stays with its lock.
hive_uninstall_ardent_receipts() { # DIRECTORY
  local directory=$1 file profile
  [[ -d "$directory" && ! -L "$directory" ]] || return 0
  for file in "$directory"/*.json; do
    [[ -f "$file" && ! -L "$file" ]] || continue
    jq -e --arg id "$HIVE_ID" '.installation==$id' "$file" >/dev/null 2>&1 || continue
    profile=$(basename -- "$file" .json)
    rm -f -- "$file" "$directory/$profile.lock"
  done
  for file in "$directory"/*.lock "$directory"/.receipt.*; do
    [[ -f "$file" && ! -L "$file" ]] || continue
    [[ "$file" == *.lock && -e "${file%.lock}.json" ]] && continue
    rm -f -- "$file"
  done
  if rmdir -- "$directory" 2>/dev/null; then printf 'Deleted the Ardent setup receipts in %s.\n' "$directory"
  else printf 'Hive: kept %s, which holds the Ardent setup receipts of another installation or files Hive did not write.\n' "$directory" >&2; fi
}

hive_uninstall() {
  local purge=${HIVE_UNINSTALL_PURGE:-false} host directory answer step=1 status=0 config_directory agent=false schedule=false certificate=false
  local -a hosts=()
  mapfile -t hosts < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  config_directory=$(dirname -- "$HIVE_OPERATOR_CONFIG")
  jq -e '.components.magnus!=null and ([.console.nativeListeners // [] | .[] | select(.component=="magnus")]|length>0)' "$HIVE_CONFIG" >/dev/null && agent=true
  hive_uninstall_has_schedule && schedule=true
  hive_uninstall_certificate_service && certificate=true
  printf 'Uninstall installation %s (release %s):\n' "$HIVE_ID" "$(jq -r .release "$HIVE_CONFIG")"
  for host in "${hosts[@]}"; do
    printf '  %s. On %s: stop and remove the containers (docker compose down)' "$((step++))" "$host"
    if [[ "$purge" == true ]]; then printf '\n'; else printf '; %s stays with its data, configuration and backups\n' "$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG")"; fi
  done
  if [[ "$agent" == true ]]; then
    printf '  %s. Remove the Magnus host agent the installer set up, its staged Ardent packages and its native account (magnus-agent remove),\n     only where the ownership record on the Magnus host names %s' "$((step++))" "$HIVE_ID"
    if [[ "${HIVE_AGENT_DELETE_PROFILES:-false}" == true ]]; then printf '; the account goes with its home and every Ardent profile in it\n'
    else printf '; an account that holds Ardent profiles stays with them%s\n' "$([[ "$purge" == true ]] && printf ' (--delete-agent-profiles deletes them)')"; fi
  fi
  [[ "$schedule" != true ]] || printf '  %s. Remove the daily backup prune line from the crontab of %s\n' "$((step++))" "$(id -un)"
  [[ "$certificate" != true ]] || printf '  %s. Stop and remove the console certificate renewal service and timer on this machine (sudo)\n' "$((step++))"
  printf '  %s. Forget the controller the hive command runs for %s\n' "$((step++))" "$HIVE_ID"
  if [[ "$purge" == true ]]; then
    for host in "${hosts[@]}"; do
      printf '  %s. DELETE %s on %s: all data, configuration and backups (sudo)\n' "$((step++))" "$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG")" "$host"
    done
    printf '  %s. DELETE the installation file %s and the journals Hive wrote beside it, its Ardent setup receipts among them; %s goes only if nothing else is in it\n' "$((step++))" "$HIVE_OPERATOR_CONFIG" "$config_directory"
    printf 'Nothing deleted can be restored. Copy any backup you want to keep first: ./hive.sh backups export ARCHIVE --to DESTINATION\n'
  else
    printf 'Data, configuration and backups are kept; ./hive.sh install --config %s brings the installation back, and uninstall --purge deletes them.\n' "$HIVE_OPERATOR_CONFIG"
  fi
  if [[ "${HIVE_CONFIRMED:-false}" != true ]]; then
    [[ "${HIVE_UNINSTALL_INTERACTIVE:-true}" == true && -t 0 ]] && hive_confirm "Uninstall $HIVE_ID?" || hive_die 'Cancelled; nothing was changed. Unattended use needs --yes'
  fi
  if [[ "$purge" == true ]]; then
    # --yes never stands in for this answer.
    answer=''
    read -r -p "Type the installation name, $HIVE_ID, to delete its data: " answer || true
    [[ "$answer" == "$HIVE_ID" ]] || hive_die 'The installation name was not typed; nothing was changed'
  fi
  # Containers first, on every host, so nothing keeps writing while the rest is removed.
  for host in "${hosts[@]}"; do
    hive_uninstall_action "$host" uninstall-stop > /dev/null || hive_die "The containers on $host could not be removed; see above. Nothing else was changed; repeat the command"
    printf 'Removed the containers on %s.\n' "$host"
  done
  # Within the typed confirmation above: profiles go only with --purge --delete-agent-profiles.
  if [[ "$agent" == true ]]; then
    if (hive_magnus_agent_target ''; hive_magnus_agent_remove_owned "${HIVE_AGENT_DELETE_PROFILES:-false}"); then :; else
      status=1
      if [[ "$purge" == true ]]; then printf 'Hive: what is left of the Magnus host agent is listed above; the purge continues.\n' >&2
      else printf 'Hive: what is left of the Magnus host agent is listed above; remove it later with ./hive.sh magnus-agent remove.\n' >&2; fi
    fi
  fi
  if [[ "$schedule" == true ]]; then
    (HIVE_CONFIG=$HIVE_OPERATOR_CONFIG; hive_retention_schedule_disable) || { status=1; printf 'Hive: the daily prune line was not removed; remove it with crontab -e.\n' >&2; }
  fi
  if [[ "$certificate" == true ]]; then
    local systemd=${HIVE_SYSTEMD_DIRECTORY:-/etc/systemd/system}
    if sudo systemctl disable --now hive-console-certificate.timer && sudo rm -f -- "$systemd/hive-console-certificate.service" "$systemd/hive-console-certificate.timer" && sudo systemctl daemon-reload; then
      printf 'Removed the console certificate renewal service.\n'
    else
      status=1; printf 'Hive: the certificate renewal service was not removed; see above.\n' >&2
    fi
  fi
  rm -f -- "$(hive_entry_point_state "$HIVE_ID")"
  if [[ "$purge" == true ]]; then
    for host in "${hosts[@]}"; do
      hive_uninstall_action "$host" uninstall-purge "$(jq -nc --arg id "$HIVE_ID" '{confirmed:$id}')" true > /dev/null ||
        hive_die "$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG") on $host could not be deleted; see above. Repeat the command to continue"
      printf 'Deleted the installation directory on %s.\n' "$host"
    done
    # Only what Hive itself wrote beside the installation file: the file, the add journals, and
    # the copies remove keeps. The directory goes only when nothing else is left in it.
    rm -f -- "$HIVE_OPERATOR_CONFIG" "$HIVE_OPERATOR_CONFIG".before-remove-*
    if [[ -d "$config_directory/additions" && ! -L "$config_directory/additions" ]]; then
      find "$config_directory/additions" -maxdepth 1 -type f \( -name '*.json' -o -name '*.json.complete-*' \) -delete
      rmdir -- "$config_directory/additions" 2>/dev/null || printf 'Hive: kept %s, which holds files Hive did not write.\n' "$config_directory/additions" >&2
    fi
    hive_uninstall_ardent_receipts "$config_directory/ardent-setup"
    # The web terminal approval log goes with the last of this installation's files.
    if [[ -f "$config_directory/magnus-trust.log" && ! -L "$config_directory/magnus-trust.log" && -z $(find "$config_directory" -mindepth 1 -maxdepth 1 ! -name magnus-trust.log -print -quit) ]]; then
      rm -f -- "$config_directory/magnus-trust.log"
    fi
    if rmdir -- "$config_directory" 2>/dev/null; then printf 'Deleted %s.\n' "$config_directory"
    else printf 'Deleted %s; %s holds other files and was kept.\n' "$HIVE_OPERATOR_CONFIG" "$config_directory"; fi
    rm -rf -- "$(dirname -- "$(hive_entry_point_state "$HIVE_ID")")"
  fi
  printf 'Installation %s is uninstalled%s.\n' "$HIVE_ID" "$([[ "$purge" == true ]] && printf ' and its data deleted' || printf '; its data is kept')"
  return "$status"
}

# hive.sh remove PRODUCT: the inverse of add for what remove supports. It backs up, stops the
# product's containers, takes its components out of the installation file (keeping the previous
# file) and applies that as an upgrade to the installed release. The product's data stays.
hive_remove_catalog() {
  printf '%s\n' '{"cindertrace-collector":{"name":"Cindertrace collector","components":["cindertrace-collector"]}}'
}

hive_remove_product() {
  local product=${1:-} entry name archive before pending host
  (($# == 1)) || hive_die "Use: remove PRODUCT [--yes]; PRODUCT is one of: $(hive_remove_catalog | jq -r 'keys|join(", ")')"
  entry=$(hive_remove_catalog | jq -ce --arg product "$product" '.[$product] // empty') ||
    hive_die "remove supports $(hive_remove_catalog | jq -r 'keys|join(", ")') so far. See deployment/README.md#uninstalling"
  name=$(jq -r .name <<< "$entry")
  [[ $(realpath -e -- "$HIVE_CONFIG") == "$HIVE_OPERATOR_CONFIG" ]] || hive_die 'remove rewrites the installation file, which must name the hive-registry component itself: run upgrade first'
  jq -e --argjson entry "$entry" '. as $c | any($entry.components[]; $c.components[.]!=null)' "$HIVE_CONFIG" >/dev/null ||
    hive_die "$name is not in this installation"
  host=$(jq -r --arg name "$product" '.components[$name].host' "$HIVE_CONFIG")
  hive_need openssl; hive_need sha256sum; hive_manifest
  printf 'Remove %s from installation %s (release %s):\n' "$name" "$HIVE_ID" "$HIVE_VERSION"
  printf '  1. Online backup of the installation; no service stops\n'
  printf '  2. On %s: stop and remove the %s containers; their data and settings stay\n' "$host" "$(jq -r '.components|join(", ")' <<< "$entry")"
  printf '  3. The installation file %s loses %s (its previous copy is kept beside it)\n' "$HIVE_OPERATOR_CONFIG" "$(jq -r '.components|join(", ")' <<< "$entry")"
  printf '  4. Apply it as an upgrade to release %s\n' "$HIVE_VERSION"
  if [[ "${HIVE_CONFIRMED:-false}" != true ]]; then
    [[ "${HIVE_REMOVE_INTERACTIVE:-true}" == true && -t 0 ]] && hive_confirm "Remove $name?" || hive_die 'Cancelled; nothing was changed. Unattended use needs --yes'
  fi
  archive="pre-remove-$product-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
  ( HIVE_OPERATION=backup HIVE_ARCHIVE=$archive; hive_lifecycle backup ) || hive_die "The backup before removing $name failed; nothing was changed"
  hive_uninstall_action "$host" remove-component "$(jq -c '{components}' <<< "$entry")" > /dev/null ||
    hive_die "The $name containers on $host could not be removed; see above. The installation file is unchanged; repeat the command"
  before="$HIVE_OPERATOR_CONFIG.before-remove-$product-$(date -u +%Y%m%d%H%M%S)"
  cp -- "$HIVE_OPERATOR_CONFIG" "$before"; chmod 600 "$before"
  pending=$(mktemp "$(dirname -- "$HIVE_OPERATOR_CONFIG")/.installation.XXXXXX")
  jq --argjson entry "$entry" 'reduce $entry.components[] as $name (.; del(.components[$name]))' "$HIVE_OPERATOR_CONFIG" > "$pending"
  chmod 600 "$pending"; mv -T -- "$pending" "$HIVE_OPERATOR_CONFIG"
  printf '%s removed from %s; the previous file is %s\n' "$(jq -r '.components|join(", ")' <<< "$entry")" "$HIVE_OPERATOR_CONFIG" "$before"
  ( HIVE_CONFIG=$HIVE_OPERATOR_CONFIG HIVE_OPERATION=upgrade HIVE_ARCHIVE=''
    hive_validate; hive_manifest; hive_lifecycle upgrade ) ||
    hive_die "Applying the removal stopped; see above. Repeat ./hive.sh upgrade --config $HIVE_OPERATOR_CONFIG --release $HIVE_VERSION to finish it, or restore $before and upgrade to bring $name back"
  printf '\n%s is removed from %s. Its data stays on %s; backup %s was taken first.\n' "$name" "$HIVE_ID" "$host" "$archive"
}
