#!/usr/bin/env bash
# Off-host backup copies and scheduled backups: export to a directory and over SSH, the manifest,
# owner-only files, refusal of unverified backups, import with every check before any change,
# unsafe archive members, the age requirement, scheduled-backup retention and the scheduled
# backup step. No containers are started.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
export XDG_STATE_HOME="$temporary/state"
mkdir -p "$temporary/bin" "$temporary/out"
# An ssh that runs the fixed remote command here, as the retention schedule test does.
cat > "$temporary/bin/ssh" <<SSH
#!/usr/bin/env bash
set -euo pipefail
command=\${!#}
printf '%s\n' "\$command" >> '$temporary/ssh.log'
eval "\$command"
SSH
chmod 700 "$temporary/bin/ssh"
export PATH="$temporary/bin:$PATH"

ago() { date -d "@$(( $(date +%s) - $1 * 86400 - 600 ))" '+%Y-%m-%d %H:%M:%S'; }
backup() { # HOST NAME DAYS
  local base="$temporary/$1"
  mkdir -p "$base/backups/$2"
  printf 'synthetic archive %s %s\n' "$1" "$2" | gzip -n > "$base/backups/$2/state.tar.gz"
  jq -n --arg host "$1" --arg sha "$(sha256sum "$base/backups/$2/state.tar.gz" | cut -d ' ' -f1)" '{schema:1,uuid:"fixture-uuid",installation:"example-suite",host:$host,sha256:$sha,verified:true}' > "$base/backups/$2/receipt.json"
  touch -d "$(ago "$3")" "$base/backups/$2/receipt.json"
}
setup() {
  rm -rf -- "$temporary/a" "$temporary/b"
  for host in a b; do
    mkdir -p "$temporary/$host"
    jq -nc --arg host "$host" '{installation:"example-suite",host:$host,uuid:"fixture-uuid"}' > "$temporary/$host/installation.json"
    printf '{"version":"0.1.0"}\n' > "$temporary/$host/receipt.json"
    printf '{"phase":"complete"}\n' > "$temporary/$host/transaction.json"
    backup "$host" manual-one 3
  done
}
jq -nc --arg base "$temporary" '{installation:"example-suite",release:"0.1.0",origin:"https://hive.example.com",hosts:{a:{target:"local",directory:($base+"/a")},b:{target:"local",directory:($base+"/b")}},components:{},agents:[],inference:[]}' > "$temporary/config.json"

(
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"; source "$ROOT/scripts/suite/retention-schedule.sh"; source "$ROOT/scripts/suite/backup-transfer.sh"
  HIVE_CONFIG=$temporary/config.json HIVE_ROOT=$ROOT HIVE_VERSION=0.1.0 HIVE_ID=example-suite
  setup
  # Export to a local directory: one owner-only file per host and a manifest of their digests.
  HIVE_BACKUP_TO=$temporary/out hive_backups_export manual-one > "$temporary/export" 2> "$temporary/export.err" || { cat "$temporary/export.err" >&2; exit 1; }
  export_dir=$temporary/out/hive-backup-example-suite-manual-one
  [[ $(stat -c %a "$export_dir") == 700 && $(stat -c %a "$export_dir/a.tar") == 600 && $(stat -c %a "$export_dir/manifest.json") == 600 ]] || exit 2
  jq -e --arg sha "$(sha256sum "$export_dir/b.tar" | cut -d ' ' -f1)" '.kind=="hive-backup-export" and .archive=="manual-one" and .encrypted==false and .hosts.b.sha256==$sha and .hosts.a.file=="a.tar"' "$export_dir/manifest.json" >/dev/null || exit 3
  tar -tf "$export_dir/a.tar" | grep -qx 'manual-one/state.tar.gz' || exit 4
  grep -q 'not encrypted and holds product secrets' "$temporary/export.err" || exit 5
  jq -e '.archive=="manual-one" and .encrypted==false' "$XDG_STATE_HOME/hive/example-suite/exports.jsonl" >/dev/null || exit 6
  if (HIVE_BACKUP_TO=$temporary/out hive_backups_export manual-one) > /dev/null 2>&1; then exit 7; fi
  # An export over SSH: fixed remote commands, every file on standard input.
  mkdir -p "$temporary/remote"
  HIVE_BACKUP_TO="deploy@backup.example.com:$temporary/remote/hive" hive_backups_export manual-one > /dev/null 2>&1 || exit 8
  cmp -s "$export_dir/a.tar" "$temporary/remote/hive/hive-backup-example-suite-manual-one/a.tar" || exit 9
  if (HIVE_BACKUP_TO="deploy@backup.example.com:$temporary/remote/../x" hive_backups_export manual-one) > /dev/null 2>&1; then exit 10; fi
  # A backup whose archive no longer matches its receipt is not exported anywhere.
  printf 'tampered\n' >> "$temporary/b/backups/manual-one/state.tar.gz"
  mkdir -p "$temporary/out2"
  if (HIVE_BACKUP_TO=$temporary/out2 hive_backups_export manual-one) > /dev/null 2> "$temporary/tampered"; then exit 11; fi
  grep -q 'does not verify against its receipt' "$temporary/tampered" && [[ -z $(ls -A "$temporary/out2") ]] || exit 12
  # Encryption needs age; without it nothing is exported.
  if ! command -v age >/dev/null; then
    if (HIVE_BACKUP_TO=$temporary/out2 HIVE_BACKUP_ENCRYPT=age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq hive_backups_export manual-one) > /dev/null 2> "$temporary/age"; then exit 13; fi
    grep -q 'needs the age tool' "$temporary/age" || exit 14
  fi
  if (HIVE_BACKUP_TO=$temporary/out2 HIVE_BACKUP_ENCRYPT='not a recipient' hive_backups_export manual-one) > /dev/null 2>&1; then exit 15; fi
  # Import: the hosts lost the backup; every file is checked, then each host takes it back.
  setup; cp -a "$temporary/a/backups/manual-one" "$temporary/original-a"
  rm -rf -- "$temporary/a/backups/manual-one" "$temporary/b/backups/manual-one"
  HIVE_BACKUP_FROM=$export_dir hive_backups_import > "$temporary/import" 2>&1 || { cat "$temporary/import" >&2; exit 16; }
  cmp -s "$temporary/original-a/state.tar.gz" "$temporary/a/backups/manual-one/state.tar.gz" && [[ -f "$temporary/b/backups/manual-one/receipt.json" ]] || exit 17
  [[ $(stat -c %a "$temporary/a/backups/manual-one") == 700 ]] || exit 18
  jq -e '.imported=="manual-one"' "$temporary/a"/retention/import-*.json >/dev/null || exit 19
  grep -q 'rehearse --archive manual-one' "$temporary/import" || exit 20
  # An existing backup is never replaced.
  if (HIVE_BACKUP_FROM=$export_dir hive_backups_import) > /dev/null 2> "$temporary/exists"; then exit 21; fi
  grep -q 'already exists on this host' "$temporary/exists" || exit 22
  # A changed file is refused before any host is contacted.
  cp -a "$export_dir" "$temporary/changed"; printf 'x' >> "$temporary/changed/b.tar"
  rm -rf -- "$temporary/a/backups/manual-one" "$temporary/b/backups/manual-one"
  if (HIVE_BACKUP_FROM=$temporary/changed hive_backups_import) > /dev/null 2> "$temporary/changed.err"; then exit 23; fi
  grep -q 'does not match the export manifest' "$temporary/changed.err" && [[ ! -e "$temporary/a/backups/manual-one" ]] || exit 24
  # Another installation's export, or one of other hosts, is refused.
  jq '.installation="other-suite"' "$export_dir/manifest.json" > "$temporary/changed/manifest.json"
  if (HIVE_BACKUP_FROM=$temporary/changed hive_backups_import) > /dev/null 2>&1; then exit 25; fi
  # Unsafe members never reach backups/: a path outside the backup, and a symbolic link.
  mkdir -p "$temporary/evil/manual-one"; ln -s /etc/passwd "$temporary/evil/manual-one/receipt.json"
  tar -C "$temporary/evil" -cf "$temporary/link.tar" manual-one
  if (hive_backup_transfer_action a backup-import manual-one "$temporary/link.tar") > /dev/null 2> "$temporary/link.err"; then exit 26; fi
  grep -q 'not a regular file or directory' "$temporary/link.err" || { cat "$temporary/link.err" >&2; exit 27; }
  mkdir -p "$temporary/evil2/other"; printf x > "$temporary/evil2/other/file"
  tar -C "$temporary/evil2" -cf "$temporary/outside.tar" other
  if (hive_backup_transfer_action a backup-import manual-one "$temporary/outside.tar") > /dev/null 2> "$temporary/outside.err"; then exit 28; fi
  grep -q 'member outside its backup' "$temporary/outside.err" && [[ ! -e "$temporary/a/backups/manual-one" && ! -e "$temporary/a/backups/other" ]] || exit 29
  ! compgen -G "$temporary/a/backups/.importing-*" >/dev/null || exit 30
  # A backup of another host does not verify here.
  setup; tar -C "$temporary/b/backups" -cf "$temporary/b.tar" manual-one; rm -rf -- "$temporary/a/backups/manual-one"
  if (hive_backup_transfer_action a backup-import manual-one "$temporary/b.tar") > /dev/null 2> "$temporary/host.err"; then exit 31; fi
  grep -q 'is not a verified backup of installation example-suite on host a' "$temporary/host.err" || exit 32
) || fail "Backup export or import failed (status $?)"

# Scheduled backups have their own count; every other backup without a rehearsal stays.
(
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"
  HIVE_CONFIG=$temporary/config.json HIVE_ROOT=$ROOT HIVE_VERSION=0.1.0 HIVE_ID=example-suite
  setup
  for host in a b; do
    backup "$host" scheduled-20260101000000-0001 5; backup "$host" scheduled-20260102000000-0002 4; backup "$host" scheduled-20260103000000-0003 1
  done
  # Without retention.backup every backup without a rehearsal is kept.
  plans=$(hive_retention_plans "$(hive_retention_input 2 0)")
  [[ $(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans") == 0 ]] || exit 1
  jq '.retention={backup:{keep:2},multiHost:true}' "$temporary/config.json" > "$temporary/scheduled.json"
  HIVE_CONFIG=$temporary/scheduled.json
  hive_retention_validate
  plans=$(hive_retention_plans "$(hive_retention_input 2 14)")
  jq -e 'all(.[]; [.entries[]|select(.remove)|.name]==["scheduled-20260101000000-0001"])' <<< "$plans" >/dev/null || { jq . <<< "$plans" >&2; exit 2; }
  jq -e 'all(.[]; (.entries[]|select(.name=="scheduled-20260103000000-0003")|.reasons)==["one of the newest 2 scheduled backups"])' <<< "$plans" >/dev/null || exit 3
  HIVE_RETENTION_APPLY=true hive_backups_command prune > "$temporary/prune" 2>&1 || { cat "$temporary/prune" >&2; exit 4; }
  for host in a b; do
    [[ ! -e "$temporary/$host/backups/scheduled-20260101000000-0001" && -d "$temporary/$host/backups/scheduled-20260102000000-0002" && -d "$temporary/$host/backups/manual-one" ]] || exit 5
  done
  for invalid in '{backup:{keep:0}}' '{backup:{keep:400}}' '{backup:{keep:2,extra:1}}' '{backup:true}'; do
    jq --argjson retention "$(jq -nc "$invalid")" '.retention=$retention' "$temporary/config.json" > "$temporary/invalid.json"
    if (HIVE_CONFIG=$temporary/invalid.json; hive_retention_validate) 2>/dev/null; then printf 'Accepted %s\n' "$invalid" >&2; exit 6; fi
  done
) || fail "Scheduled backups were not kept by their own count (status $?)"

# The daily run takes the backup through this controller's own backup command first.
(
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"; source "$ROOT/scripts/suite/retention-schedule.sh"
  fake=$temporary/fake-root; mkdir -p "$fake"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> %q\n[[ -z "${FAKE_BACKUP_FAIL:-}" ]]\n' "$temporary/backup.calls" > "$fake/hive.sh"; chmod 700 "$fake/hive.sh"
  HIVE_ROOT=$fake
  hive_retention_schedule_backup "$temporary/scheduled.json" > "$temporary/scheduled.log" 2>&1 || exit 1
  grep -Eq "^backup --config $temporary/scheduled.json --archive scheduled-[0-9]{14}-[0-9a-f]{8} --yes --non-interactive$" "$temporary/backup.calls" || { cat "$temporary/backup.calls" >&2; exit 2; }
  grep -q 'scheduled backup end: scheduled-.* verified' "$temporary/scheduled.log" || exit 3
  if FAKE_BACKUP_FAIL=1 hive_retention_schedule_backup "$temporary/scheduled.json" > "$temporary/scheduled.log" 2>&1; then exit 4; fi
  grep -q 'scheduled backup end: failed' "$temporary/scheduled.log" || exit 5
) || fail "The scheduled backup step did not run the backup command (status $?)"
printf 'Passed: exports are owner-only with a manifest, locally and over SSH, only of verified backups; imports check every file and member before any host changes; scheduled backups keep their own count; the daily run backs up first.\n'
