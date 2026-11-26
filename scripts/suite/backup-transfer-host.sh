#!/usr/bin/env bash
# Host side of backups export and import, transported verbatim by the controller
# (scripts/suite/backup-transfer.sh). backup-export writes one verified backup of this host as a
# tar stream on standard output. backup-import reads such a stream after its JSON input, checks
# every member and the backup's receipt and checksum, and only then moves it into backups/ under
# the controller lock. Neither changes any other backup.
set -Eeuo pipefail
umask 077
read -r input
die() { printf 'Hive host: %s\n' "$*" >&2; exit 1; }
directory=$(jq -er .directory <<< "$input")
installation=$(jq -er .installation <<< "$input")
host=$(jq -er .host <<< "$input")
action=$(jq -er .action <<< "$input")
archive=$(jq -er '.backupTransfer.archive // empty' <<< "$input") || die 'Missing archive'
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ${#directory} -gt 4 && ! -L "$directory" ]] || die 'Invalid installation path'
[[ "$installation" =~ ^[a-z][a-z0-9-]{0,47}$ && "$host" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'Invalid installation identity'
[[ "$archive" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$ ]] || die 'Invalid archive ID'
[[ -f "$directory/installation.json" && ! -L "$directory/installation.json" ]] || die 'Installation is not initialized'
jq -e --arg id "$installation" --arg host "$host" '.installation==$id and .host==$host' "$directory/installation.json" >/dev/null || die 'Installation or host ownership differs'
identity=$(jq -er .uuid "$directory/installation.json")
digest() { sha256sum -- "$1" | cut -d ' ' -f1; }
# A backup of this installation and host, verified when it was written, whose archive still has
# that checksum, holding only regular files and directories.
verified() { # BACKUP_DIRECTORY
  local backup=$1
  [[ -d "$backup" && ! -L "$backup" && -f "$backup/receipt.json" && ! -L "$backup/receipt.json" && -f "$backup/state.tar.gz" && ! -L "$backup/state.tar.gz" ]] || return 1
  [[ -z $(find "$backup" ! -type f ! -type d -print -quit) ]] || return 1
  jq -e --arg uuid "$identity" --arg id "$installation" --arg host "$host" \
    '.uuid==$uuid and .installation==$id and .host==$host and .verified==true and (.sha256|test("^[a-f0-9]{64}$"))' "$backup/receipt.json" >/dev/null 2>&1 || return 1
  [[ $(digest "$backup/state.tar.gz") == "$(jq -r .sha256 "$backup/receipt.json")" ]]
}
backup="$directory/backups/$archive"
case "$action" in
  backup-export)
    [[ -d "$backup" ]] || die "There is no backup $archive on this host"
    verified "$backup" || die "Backup $archive on this host does not verify against its receipt; it was not exported"
    tar -C "$directory/backups" --numeric-owner -cf - -- "$archive"
    ;;
  backup-import)
    [[ ! -L "$directory/controller.lock" ]] || die 'Unsafe controller lock'
    exec 9>"$directory/controller.lock"
    flock -n 9 || die 'Another controller holds this host; import the backup once it finishes'
    [[ ! -L "$directory/backups" ]] || die 'Unsafe backups directory'
    install -d -m 700 "$directory/backups"
    [[ ! -L "$backup" ]] || die "Unsafe backup $archive on this host"
    staging=$(mktemp -d "$directory/backups/.importing-XXXXXXXX")
    trap 'rm -rf -- "$staging"' EXIT
    cat > "$staging/stream.tar"
    # Every member is a regular file or directory below ARCHIVE/; nothing else is extracted.
    tar -tvf "$staging/stream.tar" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' || die 'The import holds a member that is not a regular file or directory'
    while IFS= read -r member; do
      [[ "$member" == "$archive" || "$member" == "$archive/" || "$member" == "$archive/"* ]] || die 'The import holds a member outside its backup'
      [[ "$member" != /* && "/$member/" != *'/../'* && "$member" != *\\* ]] || die 'Unsafe member path in the import'
    done < <(tar -tf "$staging/stream.tar")
    mkdir "$staging/content"
    tar -C "$staging/content" --no-same-owner --no-same-permissions -xf "$staging/stream.tar"
    verified "$staging/content/$archive" || die "The imported backup $archive is not a verified backup of installation $installation on host $host; nothing was imported"
    # A repeated import after another host failed: the copy here is accepted when it verifies and
    # is the same archive; any other backup of that name is never replaced.
    if [[ -e "$backup" ]]; then
      verified "$backup" && [[ $(jq -r .sha256 "$backup/receipt.json") == "$(jq -r .sha256 "$staging/content/$archive/receipt.json")" ]] ||
        die "Backup $archive already exists on this host and is not the imported one; nothing was imported"
      jq -nc --arg host "$host" --arg archive "$archive" --arg sha "$(jq -r .sha256 "$backup/receipt.json")" '{host:$host,archive:$archive,imported:true,alreadyPresent:true,sha256:$sha}'
      exit 0
    fi
    chmod -R go-rwx -- "$staging/content/$archive"
    mv -T -- "$staging/content/$archive" "$backup"
    [[ ! -L "$directory/retention" ]] || die 'Unsafe retention record directory'
    install -d -m 700 "$directory/retention"
    record="$directory/retention/import-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).json"
    jq -n --arg archive "$archive" --arg at "$(date -u +%FT%TZ)" --arg host "$host" --arg sha "$(jq -r .sha256 "$backup/receipt.json")" \
      '{schema:1,at:$at,host:$host,imported:$archive,sha256:$sha}' > "$record.tmp"
    chmod 600 "$record.tmp"; mv -T -- "$record.tmp" "$record"
    jq -nc --arg host "$host" --arg archive "$archive" --arg sha "$(jq -r .sha256 "$backup/receipt.json")" '{host:$host,archive:$archive,imported:true,sha256:$sha}'
    ;;
  *) die 'Unknown backup transfer action';;
esac
