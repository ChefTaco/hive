#!/usr/bin/env bash
# Off-host copies of backups. backups export ARCHIVE --to DESTINATION [--encrypt RECIPIENT] copies
# one verified backup from every host into a new directory, hive-backup-INSTALLATION-ARCHIVE, in a
# local directory or over SSH (user@host:/path), with a manifest of each file's SHA-256; with
# --encrypt each host's file is encrypted to an age recipient first. backups import --from
# DIRECTORY [--identity FILE] puts such a copy back on every host, where each host checks it
# before it becomes a backup again. Archives hold product secrets, keys and certificates: the files
# are owner-only, and an export without --encrypt says so. See deployment/BACKUPS.md#off-host-copies.

hive_backup_transfer_action() { # HOST ACTION ARCHIVE [STDIN_FILE]
  local sudo=false
  # The host that places Magnus keeps root-owned backups, as the lifecycle writes them there.
  if [[ $(id -u) != 0 ]] && jq -e --arg host "$1" '.hosts[$host].target=="local" and .components.magnus.host==$host' "$HIVE_CONFIG" >/dev/null; then sudo=true; fi
  HIVE_HOST_LOCAL_SUDO=$sudo HIVE_HOST_ACTION=$2 HIVE_BACKUP_TRANSFER_INPUT=$(jq -nc --arg archive "$3" '{archive:$archive}') HIVE_HOST_STDIN_FILE=${4:-} \
    hive_host "$1" "$(cat "$HIVE_ROOT/scripts/suite/backup-transfer-host.sh")"
}

# The controller's record of exports, beside the daily prune's log.
hive_backup_exports_file() { printf '%s/hive/%s/exports.jsonl\n' "${XDG_STATE_HOME:-$HOME/.local/state}" "$HIVE_ID"; }

hive_backup_recipient_valid() { [[ $1 =~ ^age1[0-9a-z]{58}$ || $1 =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]{20,}$ ]]; }

hive_backups_export() ( # ARCHIVE
  local archive=${1:-} destination=${HIVE_BACKUP_TO:-} recipient=${HIVE_BACKUP_ENCRYPT:-} work name host file remote='' path files='{}' target stamp record
  local -a ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
  [[ -n "$archive" && -n "$destination" ]] || hive_die 'Use: backups export ARCHIVE --to DIRECTORY|USER@HOST:/PATH [--encrypt AGE_RECIPIENT]'
  [[ "$archive" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$ ]] || hive_die 'Archive IDs use letters, digits, dots and hyphens; ./hive.sh backups list shows them'
  if [[ -n "$recipient" ]]; then
    hive_backup_recipient_valid "$recipient" || hive_die '--encrypt takes an age recipient (age1...) or an SSH public key (ssh-ed25519 ...)'
    command -v age >/dev/null || hive_die '--encrypt needs the age tool on this machine (https://age-encryption.org); nothing was exported'
  fi
  name="hive-backup-$HIVE_ID-$archive"
  if [[ "$destination" =~ ^([a-zA-Z_][a-zA-Z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*):(/[A-Za-z0-9._/-]+)$ ]]; then
    remote=${BASH_REMATCH[1]} path=${BASH_REMATCH[2]}
    [[ "/$path/" != *'/../'* ]] || hive_die 'The export path must not contain ..'
    path=${path%/}/$name
  else
    [[ -d "$destination" && -w "$destination" ]] || hive_die "$destination is not a writable directory"
    path=$(realpath -e -- "$destination")/$name
    [[ ! -e "$path" && ! -L "$path" ]] || hive_die "$path already exists; nothing was exported"
  fi
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  while IFS= read -r host; do
    file="$host.tar"
    hive_backup_transfer_action "$host" backup-export "$archive" > "$work/$file" || hive_die "Backup $archive could not be read on host $host; nothing was exported. See above"
    if [[ -n "$recipient" ]]; then
      age -r "$recipient" -o "$work/$file.age" -- "$work/$file" || hive_die 'age could not encrypt the export; nothing was exported'
      rm -f -- "$work/$file"; file+=.age
    fi
    files=$(jq -c --arg host "$host" --arg file "$file" --arg sha "$(sha256sum -- "$work/$file" | cut -d ' ' -f1)" --argjson bytes "$(stat -c %s -- "$work/$file")" \
      '.[$host]={file:$file,sha256:$sha,bytes:$bytes}' <<< "$files")
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  stamp=$(date -u +%FT%TZ)
  jq -n --arg installation "$HIVE_ID" --arg archive "$archive" --arg at "$stamp" --arg recipient "$recipient" --argjson hosts "$files" \
    --arg release "$(jq -r .release "$HIVE_CONFIG")" \
    '{schema:1,kind:"hive-backup-export",installation:$installation,archive:$archive,exportedAt:$at,installationRelease:$release,
      encrypted:($recipient!=""),recipient:(if $recipient=="" then null else $recipient end),hosts:$hosts}' > "$work/manifest.json"
  chmod 600 "$work"/*
  if [[ -n "$remote" ]]; then
    target=$remote
    # The remote command is fixed apart from the checked path; every file travels on stdin.
    ssh "${ssh_options[@]}" -- "$target" "umask 077 && test ! -e '$path' && mkdir -p -- '${path%/*}' && mkdir -- '$path'" || hive_die "$path could not be created on $target (or it exists); nothing was exported"
    for file in "$work"/*; do
      ssh "${ssh_options[@]}" -- "$target" "umask 077 && cat > '$path/${file##*/}'" < "$file" || hive_die "Copying ${file##*/} to $target failed; the partial export is in $path there"
    done
  else
    install -d -m 700 -- "$path"
    for file in "$work"/*; do install -m 600 -- "$file" "$path/${file##*/}"; done
  fi
  record=$(hive_backup_exports_file)
  install -d -m 700 -- "$(dirname -- "$record")"
  jq -nc --arg archive "$archive" --arg destination "${remote:+$remote:}$path" --arg at "$stamp" --argjson encrypted "$([[ -n "$recipient" ]] && printf true || printf false)" --argjson hosts "$files" \
    '{archive:$archive,destination:$destination,at:$at,encrypted:$encrypted,hosts:$hosts}' >> "$record"
  chmod 600 -- "$record"
  printf 'Exported backup %s of %s host(s) to %s%s.\n' "$archive" "$(jq length <<< "$files")" "${remote:+$remote:}$path" "$([[ -n "$recipient" ]] && printf ', encrypted to %s' "$recipient")"
  if [[ -z "$recipient" ]]; then
    printf 'Hive: the export is not encrypted and holds product secrets, keys and certificates. Keep it owner-only, or export again with --encrypt AGE_RECIPIENT.\n' >&2
  fi
  printf 'Restore it on a host of this installation with: ./hive.sh backups import --from DIRECTORY%s, then ./hive.sh rehearse --archive %s\n' "$([[ -n "$recipient" ]] && printf ' --identity AGE_IDENTITY_FILE')" "$archive"
)

hive_backups_import() (
  local source=${HIVE_BACKUP_FROM:-} identity=${HIVE_BACKUP_IDENTITY:-} manifest archive host file work sha imported=0
  [[ -n "$source" && -d "$source" && -f "$source/manifest.json" && ! -L "$source/manifest.json" ]] || hive_die 'Use: backups import --from EXPORT_DIRECTORY [--identity AGE_IDENTITY_FILE]; copy an export made over SSH to this machine first'
  manifest=$(jq -ce 'select(.schema==1 and .kind=="hive-backup-export")' "$source/manifest.json") || hive_die "$source/manifest.json is not a Hive backup export"
  [[ $(jq -r .installation <<< "$manifest") == "$HIVE_ID" ]] || hive_die "This export belongs to installation $(jq -r .installation <<< "$manifest"), not $HIVE_ID"
  archive=$(jq -r .archive <<< "$manifest")
  [[ "$archive" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$ ]] || hive_die 'The export names an invalid archive'
  # One restore point is every host's backup: an export of other hosts cannot become one here.
  jq -e --slurpfile config "$HIVE_CONFIG" '(.hosts|keys) == ($config[0].hosts|keys)' <<< "$manifest" >/dev/null ||
    hive_die "The export holds hosts $(jq -r '.hosts|keys|join(", ")' <<< "$manifest"); this installation has $(jq -r '.hosts|keys|join(", ")' "$HIVE_CONFIG")"
  if jq -e '.encrypted' <<< "$manifest" >/dev/null; then
    [[ -n "$identity" && -f "$identity" && ! -L "$identity" ]] || hive_die 'This export is encrypted: pass --identity AGE_IDENTITY_FILE'
    (( (8#$(stat -c %a "$identity") & 077)==0 )) || hive_die 'The age identity file must be owner-only'
    command -v age >/dev/null || hive_die 'Importing an encrypted export needs the age tool on this machine'
  fi
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  # Every file is checked before any host is changed.
  while IFS= read -r host; do
    file=$(jq -r --arg host "$host" '.hosts[$host].file' <<< "$manifest")
    [[ "$file" =~ ^[a-z][a-z0-9-]{0,47}\.tar(\.age)?$ && -f "$source/$file" && ! -L "$source/$file" ]] || hive_die "The export lacks the file of host $host"
    sha=$(sha256sum -- "$source/$file" | cut -d ' ' -f1)
    [[ "$sha" == "$(jq -r --arg host "$host" '.hosts[$host].sha256' <<< "$manifest")" ]] || hive_die "The file of host $host does not match the export manifest; nothing was imported"
    if [[ "$file" == *.age ]]; then
      age -d -i "$identity" -o "$work/$host.tar" -- "$source/$file" || hive_die "The file of host $host could not be decrypted with $identity; nothing was imported"
    else
      cp -- "$source/$file" "$work/$host.tar"
    fi
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  while IFS= read -r host; do
    if ! hive_backup_transfer_action "$host" backup-import "$archive" "$work/$host.tar" > /dev/null; then
      ((imported == 0)) || printf 'Hive: backup %s was imported on %s host(s) before host %s refused it; it is restorable only once every host has it.\n' "$archive" "$imported" "$host" >&2
      hive_die "Host $host did not import backup $archive; see above"
    fi
    imported=$((imported + 1))
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  printf 'Imported backup %s on %s host(s). Rehearse it before a restore: ./hive.sh rehearse --archive %s\n' "$archive" "$imported" "$archive"
)

# backups list: what this controller exported, newest last.
hive_backup_exports_print() {
  local record
  record=$(hive_backup_exports_file)
  [[ -f "$record" ]] || return 0
  printf 'Exported from this machine:\n'
  jq -r '"  \(.archive) to \(.destination) at \(.at)" + (if .encrypted then " (encrypted)" else " (not encrypted)" end)' "$record" 2>/dev/null | tail -n 20
}
