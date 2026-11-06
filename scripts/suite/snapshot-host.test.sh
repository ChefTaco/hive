#!/usr/bin/env bash
# The online backup host action against a fake Docker: capture order, which services pause,
# each store's snapshot path, refusals, failures, retries and archive compatibility.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
user="$(id -u):$(id -g)"
image() { printf 'example.com/%s@sha256:%064d' "$1" 0; }

# ---- A fake Docker. Containers are named by service; state lives in files. ----
mkdir -p "$temporary/bin" "$temporary/state/paused" "$temporary/state/mounts"
cat > "$temporary/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
state=$STUB_STATE
log() { printf '%s\n' "$*" >> "$state/calls"; }
failing() { [[ -n "${STUB_FAIL:-}" && "$*" == *"$STUB_FAIL"* ]]; }
id_of() { printf '%012x' "$(printf '%s' "$1" | cksum | cut -d ' ' -f1)"; }
service_of() { jq -r --arg id "$1" '.services|keys[]' "$STUB_COMPOSE" | while read -r name; do [[ $(id_of "$name") != "$1" ]] || printf '%s' "$name"; done; }
mount_of() { sed -n "s|^$2 ||p" "$state/mounts/$1" 2>/dev/null | head -n 1; }
if [[ "$1" == compose ]]; then
  shift 2; shift # -f FILE
  case "$1" in
    ps)
      if [[ "${2:-}" == --format ]]; then
        jq -r '.services|keys[]' "$STUB_COMPOSE" | while read -r name; do
          health=healthy; grep -qx "$name" "$state/down" 2>/dev/null && health=unhealthy
          jq -nc --arg s "$name" --arg h "$health" '{Service:$s,State:"running",Health:$h}'
        done
      elif [[ "${2:-}" == -q ]]; then id_of "$3"; fi;;
    *) log "compose $*";;
  esac
  exit 0
fi
command=$1; shift
case "$command" in
  inspect)
    format=$2 target=$3
    case "$format" in
      *Running*) [[ -f "$state/paused/$target" ]] && printf 'true true\n' || printf 'true false\n';;
      *Paused*) [[ -f "$state/paused/$target" ]] && printf 'true\n' || printf 'false\n';;
      *ExitCode*) printf '0\n';;
    esac;;
  pause) log "pause $(service_of "$1")"; touch "$state/paused/$1";;
  unpause) log "unpause $(service_of "$1")"; failing "unpause $(service_of "$1")" && exit 1; rm -f "$state/paused/$1";;
  image|pull|rm|stop|wait) ;;
  ps) ;;
  run)
    name='' detached=false
    args=("$@")
    for ((index = 0; index < ${#args[@]}; index++)); do
      case "${args[index]}" in
        --name) name=${args[index + 1]};;
        -d) detached=true;;
        --mount) [[ -z "$name" ]] || { source=${args[index + 1]#*source=}; source=${source%%,*}; target=${args[index + 1]#*target=}; target=${target%%,*}; printf '%s %s\n' "$target" "$source" >> "$state/mounts/$name"; };;
      esac
    done
    if [[ "$detached" == true ]]; then log "start $name"; printf 'container\n'; exit 0; fi
    log "run ${args[*]: -1}"
    # The one-off helper reads the restored vector store of a verification container.
    if [[ "${args[*]: -1}" == *qdrant-inventory* ]]; then printf '{"collections":{"memories":{"points":3,"contentSHA256":"synthetic"}}}\n'; fi;;
  exec)
    [[ "$1" != -i ]] || shift
    target=$1; shift
    request=${!#}
    if [[ "$1" == node ]]; then
      phase=$(jq -r .command <<< "$request")
      case "$target" in *-files-*) helper=files-${target##*-files-};; *-qdrant-*) helper=qdrant-${target##*-qdrant-};; *) helper=$target;; esac
      log "$phase $helper"
      failing "$phase $helper" && exit 1
      busy=$state/busy-$helper
      if [[ "$phase" == capture && -f "$busy" && $(cat "$busy") -gt 0 ]]; then echo $(( $(cat "$busy") - 1 )) > "$busy"; exit 75; fi
      out=$(mount_of "$target" /out) work=$(mount_of "$target" /work) data=$(mount_of "$target" /data)
      case "$phase" in
        precopy) printf '{"files":1,"bytes":1}\n';;
        capture) [[ ! -f "$data/state.db" ]] || cp "$data/state.db" "$out/state.db"; printf '{"sqlite":0}\n';;
        verify) printf '{"files":[],"sqlite":[]}' > "$work/manifest.json"; printf '{"files":1,"bytes":1,"sqlite":[]}\n';;
        qdrant-snapshot)
          live=$STUB_DATA/hivemem-qdrant/snapshots; mkdir -p "$live"; printf 'vectors' > "$live/full.snapshot"
          jq -nc --arg sum "$(sha256sum "$live/full.snapshot" | cut -d ' ' -f1)" '{name:"full.snapshot",checksum:$sum,size:7,directory:"snapshots",collections:{memories:3}}';;
        qdrant-inventory) printf '{"collections":{"memories":{"points":3,"contentSHA256":"synthetic"}}}\n';;
      esac
      exit 0
    fi
    script=$(cat 2>/dev/null || true)
    if [[ "$script" == *'bgsave'* ]]; then log "redis-bgsave $(service_of "$target")"; failing redis-bgsave && exit 1; printf '{"file":"dump.rdb","keys":2}\n'; exit 0; fi
    if [[ "$script" == *'appendonly yes'* ]]; then mkdir -p "$(mount_of "$target" /data)/appendonlydir"; touch "$(mount_of "$target" /data)/appendonlydir/appendonly.aof.manifest"; printf '{"loaded":2,"expiredAtLoad":0,"keys":2}\n'; exit 0; fi
    if [[ "$1" == pg_basebackup ]]; then
      log "pg_basebackup $(service_of "$target")"; failing pg_basebackup && exit 1
      while [[ "$1" != -D ]]; do shift; done
      mkdir -p "$STUB_DATA/magnus-postgres/${2#/data/}"; echo 17 > "$STUB_DATA/magnus-postgres/${2#/data/}/PG_VERSION"; exit 0
    fi
    if [[ "$1" == psql ]]; then printf '[{"name":"magnus","bytes":1}]\n'; exit 0; fi
    ;;
esac
STUB
chmod +x "$temporary/bin/docker"

# ---- One installation: identity, memory and Magnus groups, the edge, and the static UI. ----
directory=$temporary/install
plan=$(printf 'plan' | sha256sum | cut -d ' ' -f1)
install -d -m 700 "$directory" "$directory/data" "$directory/config" "$directory/releases" "$directory/backups" "$directory/rehearsals"
for service in oathweave oathweave-redis hivemem hivemem-qdrant magnus magnus-postgres ingress; do install -d -m 700 "$directory/data/$service" "$directory/config/$service"; done
printf 'synthetic' > "$directory/data/oathweave/state.db"; printf 'dump' > "$directory/data/oathweave-redis/dump.rdb"; printf 'requirepass synthetic\n' > "$directory/config/oathweave-redis/redis.conf"
printf 'api_key: synthetic\n' > "$directory/config/hivemem-qdrant/qdrant.yaml"
jq -n --arg d "$directory" --arg u "$user" --arg redis "$(image redis)" --arg qdrant "$(image qdrant)" --arg postgres "$(image postgres)" --arg app "$(image app)" '
  def svc($name): {image:$app,user:$u,volumes:[{type:"bind",source:($d+"/data/"+$name),target:"/data"},{type:"bind",source:($d+"/config/"+$name),target:"/config",read_only:true}]};
  {name:"synthetic-control",services:{
    oathweave:(svc("oathweave")+{depends_on:{"oathweave-redis":{condition:"service_healthy"}}}),
    "oathweave-redis":(svc("oathweave-redis")+{image:$redis,command:["redis-server","/config/redis.conf"]}),
    hivemem:(svc("hivemem")+{depends_on:{"hivemem-qdrant":{condition:"service_healthy"}}}),
    "hivemem-qdrant":(svc("hivemem-qdrant")+{image:$qdrant,entrypoint:["/qdrant/qdrant"],command:["--config-path","/config/qdrant.yaml"]}),
    magnus:(svc("magnus")+{depends_on:{"magnus-postgres":{condition:"service_healthy"}}}),
    "magnus-postgres":(svc("magnus-postgres")+{image:$postgres,environment:{PGDATA:"/data/pgdata",POSTGRES_USER:"magnus"}}),
    ingress:svc("ingress"),
    hivexui:{image:$app,user:$u,volumes:[{type:"bind",source:($d+"/config/runtime.json"),target:"/usr/share/nginx/html/runtime.json"}]}}}' > "$directory/compose.json"
jq -n '{schema:1,version:"0.1.0",components:{oathweave:{kind:"application"},hivemem:{kind:"application"},magnus:{kind:"application"},
  "oathweave-redis":{kind:"datastore",storageFormat:"redis-aof-v1"},"hivemem-qdrant":{kind:"datastore",storageFormat:"qdrant-v1.18.3"},"magnus-postgres":{kind:"datastore",storageFormat:"magnus-postgres-17"},
  ingress:{kind:"ingress"},hivexui:{kind:"static-ui"}}}' > "$directory/manifest.$plan.json"
digest=$(sha256sum "$directory/manifest.$plan.json" | cut -d ' ' -f1)
uuid=$(printf 'uuid' | sha256sum | cut -c1-48)
jq -n --arg uuid "$uuid" '{schema:1,installation:"synthetic",host:"control",uuid:$uuid}' > "$directory/installation.json"
jq -n --arg digest "$digest" '{schema:1,installation:"synthetic",host:"control",version:"0.1.0",digest:$digest}' > "$directory/receipt.json"
prepared() { jq -n --arg plan "$plan" '{schema:1,plan:$plan,phase:"prepared",version:"0.1.0",operation:"backup"}' > "$directory/transaction.json"; }
phase() { jq -r .phase "$directory/transaction.json"; }
script=''; for file in integrity-host.sh adapters-host.sh snapshot-host.sh host-runtime.sh; do script+=$(cat "$ROOT/scripts/suite/$file")$'\n'; done
export STUB_STATE=$temporary/state STUB_COMPOSE=$directory/compose.json STUB_DATA=$directory/data PATH="$temporary/bin:$PATH"
backup() {
  local archive=$1 minimum=${2:-1}
  : > "$STUB_STATE/calls"
  jq -nc --arg directory "$directory" --arg plan "$plan" --arg digest "$digest" --arg archive "$archive" --argjson minimum "$minimum" \
    --arg tool "$(printf 'export {}' | base64 -w0)" --arg integrity "$(printf 'export {}' | base64 -w0)" \
    '{directory:$directory,installation:"synthetic",host:"control",action:"snapshot",operation:"backup",plan:$plan,version:"0.1.0",digest:$digest,archive:$archive,
      minimumFreeMiB:$minimum,snapshotTool:$tool,integrityScript:$integrity,agents:[],inference:[]}' | bash -c "$script"
}
calls() { cat "$STUB_STATE/calls"; }
line() { grep -nx -- "$1" "$STUB_STATE/calls" | head -n 1 | cut -d: -f1; }
before() { local a b; a=$(line "$1") b=$(line "$2"); [[ -n "$a" && -n "$b" ]] && ((a < b)) || fail "Expected '$1' before '$2'"; }

# ---- A complete online backup. ----
prepared
backup online-a > "$temporary/out" 2> "$temporary/err" || { cat "$temporary/err" >&2; fail 'The online backup failed'; }
receipt=$directory/backups/online-a/receipt.json
jq -e --arg uuid "$uuid" '.mode=="online" and .verified==true and .uuid==$uuid and (.snapshot.pauses|length)==3 and .snapshot.longestPauseSeconds>=0' "$receipt" >/dev/null || fail 'Online receipt is incomplete'
jq -e '[.snapshot.pauses[].pause[0]]==["hivemem","magnus","oathweave"]' "$receipt" >/dev/null || fail 'The identity provider is not captured last'
jq -e '.snapshot.stores["oathweave-redis"].store.method=="redis-bgsave" and .snapshot.stores["hivemem-qdrant"].store.method=="qdrant-storage-snapshot" and .snapshot.stores["magnus-postgres"].store.method=="pg_basebackup"' "$receipt" >/dev/null || fail 'A store snapshot method is missing'
jq -e '.snapshot.stores["hivemem-qdrant"].store.verified.collections.memories.points==3 and .snapshot.stores["oathweave-redis"].store.verified.loaded==2' "$receipt" >/dev/null || fail 'A materialized store was not verified'
[[ $(jq -r .sha256 "$receipt") == $(sha256sum "$directory/backups/online-a/state.tar.gz" | cut -d ' ' -f1) ]] || fail 'Archive checksum differs'
[[ $(phase) == complete ]] || fail 'The transaction is not closed'
for service in ingress oathweave-redis hivemem-qdrant magnus-postgres hivexui; do ! calls | grep -qx "pause $service" || fail "$service was paused"; done
for service in oathweave hivemem magnus; do
  before "precopy files-$service" "pause $service"
  before "pause $service" "capture files-$service"
  before "capture files-$service" "unpause $service"
  before "unpause $service" "verify files-$service"
done
before 'pause oathweave' 'redis-bgsave oathweave-redis'; before 'redis-bgsave oathweave-redis' 'unpause oathweave'
before 'pause hivemem' 'qdrant-snapshot qdrant-hivemem-qdrant'; before 'qdrant-snapshot qdrant-hivemem-qdrant' 'unpause hivemem'
before 'pause magnus' 'pg_basebackup magnus-postgres'; before 'pg_basebackup magnus-postgres' 'unpause magnus'
# Stores are rebuilt as stopped stores; nothing temporary stays in the live directories.
tar -tzf "$directory/backups/online-a/state.tar.gz" > "$temporary/members"
for member in data/oathweave/state.db data/oathweave-redis/dump.rdb data/oathweave-redis/appendonlydir/appendonly.aof.manifest data/magnus-postgres/pgdata/PG_VERSION compose.json receipt.json installation.json; do grep -qx "$member" "$temporary/members" || fail "Archive member is missing: $member"; done
! grep -q 'hive-snapshot\|storage.snapshot\|\.online-' "$temporary/members" || fail 'A temporary file was archived'
[[ ! -e "$directory/data/hivemem-qdrant/snapshots/full.snapshot" && -z $(find "$directory/data/magnus-postgres" -name '.hive-snapshot-*') ]] || fail 'A store temporary stayed in the live data'
[[ -z $(find "$directory/backups" -mindepth 1 -maxdepth 1 -name '.online-*') ]] || fail 'Staging was left behind'
[[ -z $(ls "$STUB_STATE/paused") ]] || fail 'A service stayed paused'
printf 'Passed: online backup captures each group in one pause, in order, with every store method.\n'

# ---- Archive compatibility: a repeated ID verifies the existing archive, in either format. ----
cp -a "$directory/backups/online-a" "$directory/backups/stopped-a"
jq 'del(.mode,.snapshot)' "$directory/backups/stopped-a/receipt.json" > "$temporary/receipt" && mv "$temporary/receipt" "$directory/backups/stopped-a/receipt.json"
for archive in online-a stopped-a; do prepared; backup "$archive" > /dev/null 2>&1 || fail "An existing $archive archive did not verify"; ! calls | grep -q '^pause' || fail 'A repeated ID captured again'; done
printf 'Passed: online and stopped-format archives both verify.\n'
kept=$(cd "$directory/backups" && find online-a stopped-a -type f -print0 | sort -z | xargs -0 sha256sum)

failed() {
  # failed ARCHIVE PATTERN [MINIMUM]: nothing is paused afterwards, nothing is kept.
  prepared
  if backup "$1" "${3:-1}" > "$temporary/out" 2> "$temporary/err"; then fail "Backup $1 succeeded"; fi
  grep -q -- "$2" "$temporary/err" || { cat "$temporary/err" >&2; fail "Backup $1 did not report: $2"; }
  [[ ! -e "$directory/backups/$1" ]] || fail "A failed backup kept an archive: $1"
  [[ -z $(find "$directory/backups" -mindepth 1 -maxdepth 1 -name '.online-*') ]] || fail 'Staging was left behind'
  [[ -z $(ls "$STUB_STATE/paused") ]] || fail 'A service stayed paused'
  [[ $(cd "$directory/backups" && find online-a stopped-a -type f -print0 | sort -z | xargs -0 sha256sum) == "$kept" ]] || fail 'Another archive changed or was removed'
  [[ ! -e "$directory/data/hivemem-qdrant/snapshots/full.snapshot" && -z $(find "$directory/data/magnus-postgres" -name '.hive-snapshot-*') ]] || fail 'A store temporary stayed in the live data'
  { calls | grep '^pause' || true; } | sed 's/^pause/unpause/' | while read -r expected; do calls | grep -qx "$expected" || fail "Not resumed: $expected"; done
}
# ---- Refusals before anything pauses. ----
failed space-a 'MiB free' 999999999
[[ $(phase) == complete ]] || fail 'A refused backup left its transaction open'
! calls | grep -q '^pause' || fail 'A refused backup paused a service'
printf 'oathweave\n' > "$STUB_STATE/down"
failed down-a 'every suite service running and healthy'
! calls | grep -q '^pause' || fail 'A refused backup paused a service'
rm -f "$STUB_STATE/down"
printf 'Passed: refusals for disk space and an unhealthy service change nothing.\n'

# ---- Failures while paused and after: services resume, no archive, nothing pruned. ----
for step in redis-bgsave qdrant-snapshot pg_basebackup 'capture files-magnus' 'verify files-hivemem'; do
  STUB_FAIL=$step failed "fail-$(tr -c 'a-z' '-' <<< "$step" | sed 's/-*$//')" 'online backup failed'
  [[ $(phase) == complete ]] || fail "A failed backup left its transaction open: $step"
done
printf 'Passed: a failed store snapshot resumes every service, keeps no archive and changes no other archive.\n'

# ---- A writer paused inside a SQLite commit: resume, then capture again. ----
echo 2 > "$STUB_STATE/busy-files-hivemem"; prepared
backup busy-a > /dev/null 2> "$temporary/err" || { cat "$temporary/err" >&2; fail 'A busy capture was not retried'; }
jq -e '[.snapshot.pauses[]|select(.pause==["hivemem"])|.attempt]==[1,2,3]' "$directory/backups/busy-a/receipt.json" >/dev/null || fail 'Retries were not recorded'
[[ $(calls | grep -cx 'pause hivemem') == 3 && $(calls | grep -cx 'unpause hivemem') == 3 ]] || fail 'Each retry did not resume the writer'
echo 9 > "$STUB_STATE/busy-files-hivemem"; failed busy-b 'Snapshot failed: hivemem'; rm -f "$STUB_STATE/busy-files-hivemem"
printf 'Passed: a held SQLite lock is retried with the writer resumed, and fails after five attempts.\n'

# ---- A service that cannot be resumed holds the transaction for recovery. ----
prepared
if STUB_FAIL='unpause magnus' backup resume-a > "$temporary/out" 2> "$temporary/err"; then fail 'A backup succeeded without resuming a service'; fi
grep -q 'could not be resumed' "$temporary/err" || fail 'An unresumed service was not reported'
[[ $(phase) == recovery-required ]] || fail 'An unresumed service did not hold the transaction'
[[ ! -e "$directory/backups/resume-a" ]] || fail 'An archive was kept'
# Its watchdog keeps trying to resume it; this fake service is not resumable, so stop it.
pkill -f 'sleep 600; docker unpause' || true
rm -f "$STUB_STATE"/paused/*
printf 'Passed: a service that cannot be resumed is reported and holds the transaction.\n'
