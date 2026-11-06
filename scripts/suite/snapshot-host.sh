#!/usr/bin/env bash
# Definitions only. The online backup behind hive.sh backup: the suite keeps serving while
# every store is captured by its own consistent method. See deployment/BACKUPS.md.
#
# Services are captured in groups: one application and the datastores it depends on. Each
# application is paused (cgroup freezer, docker pause) only while its group is captured, so
# its datastores and files all hold the state of one instant, as if the application had been
# killed then. Requests to that application wait for the pause and are then answered.
snapshot_paused=() snapshot_containers=() snapshot_watchdog='' snapshot_created='' snapshot_staging='' snapshot_succeeded=false
snapshot_service() { jq -r --arg name "$1" "$2" "$directory/compose.json"; }
snapshot_mount() { jq -r --arg name "$1" --arg target "$2" '[.services[$name].volumes[]?|select(.target==$target)|.source][0] // empty' "$directory/compose.json"; }
snapshot_kind() { jq -r --arg name "$1" '.components[$name].kind // "application"' "$snapshot_manifest"; }
snapshot_now() { printf '%s' "$EPOCHREALTIME"; }
snapshot_seconds() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.3f", b-a}'; }
snapshot_id() {
  local id
  id=$(compose ps -q "$1") || die "No container for $1"
  [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || die "Exactly one running container is required for $1"
  printf '%s' "$id"
}
# The store a service holds, from its signed storage format. Applications hold files and SQLite.
snapshot_store() {
  local format
  format=$(jq -r --arg name "$1" '.components[$name] | if (.kind // "application")=="datastore" then (.storageFormat // "") else "-" end' "$snapshot_manifest")
  case "$format" in -) printf 'files';; redis-*) printf 'redis';; qdrant-*) printf 'qdrant';; *postgres*) printf 'postgres';; *) printf 'unknown';; esac
}
# Store files captured by the store's own method, never copied from the live directory.
snapshot_excludes() {
  case $(snapshot_store "$1") in
    redis) printf '["appendonlydir","dump.rdb","temp-*.rdb","temp-*.aof"]';;
    qdrant) printf '["storage","snapshots",".qdrant-initialized"]';;
    postgres) printf '["pgdata",".hive-snapshot-*"]';;
    *) printf '[]';;
  esac
}
# Ordered capture groups. The edge (ingress) and unowned datastores are never paused. The
# identity provider is captured last, so every account or client another product refers to
# is already in the archive.
snapshot_groups() {
  jq -c --slurpfile release "$snapshot_manifest" '
    ($release[0].components) as $c | .services as $s |
    def kind($n): ($c[$n].kind // "application");
    def data($n): any($s[$n].volumes[]?; .target=="/data");
    def stores($n): [($s[$n].depends_on // {}) | if type=="array" then .[] else keys[] end | select(kind(.)=="datastore")];
    [$s|keys[]|select(kind(.)=="application")|{pause:[.],files:(if data(.) then [.] else [] end),stores:stores(.)}] as $owned |
    ([$owned[].stores[]]|group_by(.)|map(select(length>1))|length) as $shared |
    if $shared>0 then error("A datastore shared by two applications needs the stopped backup") else . end |
    ([$s|keys[]|select(kind(.)=="datastore")] - [$owned[].stores[]]) as $alone |
    [$s|keys[]|select(kind(.)!="application" and kind(.)!="datastore" and data(.))] as $edge |
    ([$edge[]|{pause:[],files:[.],stores:[]}] + [$alone[]|{pause:[],files:[],stores:[.]}] +
      ($owned|map(select(.pause[0]!="oathweave"))) + ($owned|map(select(.pause[0]=="oathweave"))))[]' "$directory/compose.json"
}
snapshot_tool() {
  # snapshot_tool USER REQUEST [docker run options]. The pinned recovery image runs the helper.
  local user=$1 request=$2 name="hive-snapshot-$archive-$RANDOM$RANDOM"; shift 2
  snapshot_containers+=("$name")
  timeout 1800 docker run --rm --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user "$user" --tmpfs /tmp:mode=1777 "$@" \
    --entrypoint node "$recovery_image" --input-type=module -e "$snapshot_code" "$request"
}
# A helper started before a pause, so the pause holds only a docker exec, not a container start.
snapshot_helper() {
  # snapshot_helper NAME USER [docker run options]
  local name="hive-snapshot-$archive-$1" user=$2; shift 2
  [[ -z $(docker ps -q --filter "name=^$name\$") ]] || return 0
  snapshot_containers+=("$name")
  docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges:true --user "$user" --tmpfs /tmp:mode=1777 "$@" \
    --entrypoint sleep "$recovery_image" infinity >/dev/null || die 'A snapshot helper could not start'
}
snapshot_run() { timeout 1800 docker exec "hive-snapshot-$archive-$1" node --input-type=module -e "$snapshot_code" "$2"; }
snapshot_files() {
  # snapshot_files precopy|capture|verify SERVICE
  local phase=$1 service=$2 source readonly='' request
  source=$(snapshot_mount "$service" /data)
  [[ "$source" == "$directory/data/$service" && -d "$source" && ! -L "$source" ]] || die "Data directory differs for $service"
  # SQLite readers need the shared-memory sidecar writable, as the product has it. Datastore
  # directories hold no SQLite and are only read.
  [[ $(snapshot_kind "$service") != datastore ]] || readonly=',readonly'
  request=$(jq -nc --arg command "$phase" --argjson exclude "$(snapshot_excludes "$service")" '{command:$command,source:"/data",target:"/out",work:"/work",exclude:$exclude}')
  snapshot_helper "files-$service" "$(snapshot_service "$service" '.services[$name].user')" --network none --mount "type=bind,source=$source,target=/data$readonly" \
    --mount "type=bind,source=$snapshot_staging/data/$service,target=/out" --mount "type=bind,source=$snapshot_staging/work/$service,target=/work"
  snapshot_run "files-$service" "$request"
}
snapshot_prepare() {
  local service=$1 source
  source="$directory/data/$service"
  [[ -d "$source" && ! -L "$source" ]] || die "Data directory is missing for $service"
  install -d -m "$(stat -c %a "$source")" -o "$(stat -c %u "$source")" -g "$(stat -c %g "$source")" "$snapshot_staging/data/$service"
  install -d -m 700 -o "$(stat -c %u "$source")" -g "$(stat -c %g "$source")" "$snapshot_staging/work/$service"
}
snapshot_pause() {
  local id
  for id in "$@"; do
    [[ $(docker inspect -f '{{.State.Running}} {{.State.Paused}}' "$id") == 'true false' ]] || die 'A service stopped before its capture'
    docker pause "$id" >/dev/null || die 'A service could not be paused'
    snapshot_paused+=("$id")
  done
  # Belt and braces: whatever happens to this script, nothing stays paused for long.
  if ((${#snapshot_paused[@]})); then
    # It never holds the controller lock.
    setsid bash -c 'sleep 600; docker unpause "$@"' _ "${snapshot_paused[@]}" </dev/null >/dev/null 2>&1 9>&- &
    snapshot_watchdog=$!
  fi
}
snapshot_resume() {
  local id
  local -a failed=()
  for id in "${snapshot_paused[@]}"; do
    [[ $(docker inspect -f '{{.State.Paused}}' "$id") != true ]] || docker unpause "$id" >/dev/null || failed+=("$id")
  done
  # A container that could not be resumed stays listed, and the watchdog keeps trying.
  snapshot_paused=("${failed[@]}")
  ((${#failed[@]} == 0)) || return 1
  if [[ -n "$snapshot_watchdog" ]]; then kill -- "-$snapshot_watchdog" 2>/dev/null || kill "$snapshot_watchdog" 2>/dev/null || true; snapshot_watchdog=''; fi
}
snapshot_still_paused() {
  local id
  for id in "${snapshot_paused[@]}"; do [[ $(docker inspect -f '{{.State.Paused}}' "$id") == true ]] || return 1; done
}

# ---- Capture: runs while the group's application is paused. ----
snapshot_redis_capture() {
  local service=$1 container result name source
  container=$(snapshot_id "$service"); source="$directory/data/$service"
  # A background save forks at once: its child holds the state of this instant. The password
  # is read inside the container, from its own configuration, never passed in.
  result=$(timeout 300 docker exec -i "$container" sh -s <<'EOF'
set -eu
REDISCLI_AUTH=$(sed -n 's/^requirepass[[:space:]]*//p' /config/redis.conf | tail -n 1); export REDISCLI_AUTH
r() { redis-cli --no-auth-warning "$@" | tr -d '\r'; }
field() { r info persistence | sed -n "s/^$1://p"; }
[ "$(r config get dir | sed -n 2p)" = /data ]
name=$(r config get dbfilename | sed -n 2p)
before=$(field rdb_saves); keys=$(r dbsize)
case "$(r bgsave schedule)" in 'Background saving started'|'Background saving scheduled') ;; *) exit 1;; esac
count=0
until [ "$(field rdb_bgsave_in_progress)" = 0 ] && [ "$(field rdb_saves)" -gt "$before" ]; do
  count=$((count + 1)); [ "$count" -lt 1200 ]; sleep 0.1
done
[ "$(field rdb_last_bgsave_status)" = ok ]
printf '{"file":"%s","keys":%s}\n' "$name" "$keys"
EOF
  ) || die "Redis snapshot failed: $service"
  name=$(jq -er .file <<< "$result") && [[ "$name" =~ ^[A-Za-z0-9._-]+$ && -f "$source/$name" && ! -L "$source/$name" ]] || die "Redis snapshot file is missing: $service"
  cp --reflink=auto --preserve=mode,ownership,timestamps -- "$source/$name" "$snapshot_staging/data/$service/$name"
  jq -c --arg at "$(date -u +%FT%T.%3NZ)" '{method:"redis-bgsave",file,keysAtCapture:.keys,capturedAt:$at}' <<< "$result" > "$snapshot_staging/work/$service/store.json"
}
snapshot_qdrant_capture() {
  local service=$1 container config result
  container=$(snapshot_id "$service"); config=$(snapshot_mount "$service" /config)
  [[ -n "$config" && -f "$config/qdrant.yaml" ]] || die "Qdrant configuration is missing: $service"
  snapshot_helper "qdrant-$service" "$(snapshot_service "$service" '.services[$name].user')" --network "container:$container" --mount "type=bind,source=$config,target=/config,readonly"
  result=$(snapshot_run "qdrant-$service" '{"command":"qdrant-snapshot","url":"http://127.0.0.1:6333","config":"/config/qdrant.yaml"}') || die "Qdrant snapshot failed: $service"
  jq -c --arg at "$(date -u +%FT%T.%3NZ)" '{method:"qdrant-collection-snapshots",directory,snapshots,collections,aliases,capturedAt:$at}' <<< "$result" > "$snapshot_staging/work/$service/store.json"
}
snapshot_postgres_capture() {
  local service=$1 container user
  container=$(snapshot_id "$service")
  user=$(snapshot_service "$service" '.services[$name].environment.POSTGRES_USER // "postgres"')
  [[ "$user" =~ ^[a-z_][a-z0-9_]{0,62}$ && $(snapshot_service "$service" '.services[$name].environment.PGDATA') == /data/pgdata ]] || die "PostgreSQL layout differs: $service"
  # A physical base backup over the local socket, with the WAL it needs streamed beside it.
  timeout 3600 docker exec "$container" pg_basebackup -h /var/run/postgresql -U "$user" -D "/data/.hive-snapshot-$archive" \
    -X stream --checkpoint=fast --no-password >/dev/null || die "PostgreSQL base backup failed: $service"
  jq -nc --arg at "$(date -u +%FT%T.%3NZ)" '{method:"pg_basebackup",capturedAt:$at}' > "$snapshot_staging/work/$service/store.json"
}
snapshot_capture() {
  local group=$1 service
  # Files first: a SQLite lock held by the paused writer is retried before any store snapshot.
  for service in $(jq -r '.files[]' <<< "$group"); do snapshot_files capture "$service" > "$snapshot_staging/work/$service/capture.out"; done
  for service in $(jq -r '.stores[]' <<< "$group"); do
    case $(snapshot_store "$service") in
      redis) snapshot_redis_capture "$service";;
      qdrant) snapshot_qdrant_capture "$service";;
      postgres) snapshot_postgres_capture "$service";;
      *) die "No online snapshot method for $service; use --stopped";;
    esac
  done
}

# ---- Materialize and verify: runs while everything serves again. ----
# Each store is rebuilt as the stopped store it would be, by its own product, in a container
# without a network. The archive then restores with the unchanged restore path.
snapshot_temporary() {
  local name="hive-snapshot-$archive-$RANDOM$RANDOM"
  snapshot_containers+=("$name")
  docker run -d --name "$name" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:mode=1777 "$@" >/dev/null || die 'A verification container could not start'
  printf '%s' "$name"
}
snapshot_redis_verify() {
  local service=$1 name image user config result
  image=$(snapshot_service "$service" '.services[$name].image'); user=$(snapshot_service "$service" '.services[$name].user'); config=$(snapshot_mount "$service" /config)
  mapfile -t command < <(snapshot_service "$service" '.services[$name].command[]')
  # The dump is loaded with the append-only file off, then the product writes its own AOF.
  name=$(snapshot_temporary --user "$user" --mount "type=bind,source=$snapshot_staging/data/$service,target=/data" --mount "type=bind,source=$config,target=/config,readonly" "$image" "${command[@]}" --appendonly no)
  result=$(timeout 600 docker exec -i "$name" sh -s <<'EOF'
set -eu
REDISCLI_AUTH=$(sed -n 's/^requirepass[[:space:]]*//p' /config/redis.conf | tail -n 1); export REDISCLI_AUTH
r() { redis-cli --no-auth-warning "$@" 2>/dev/null | tr -d '\r'; }
field() { r info persistence | sed -n "s/^$1://p"; }
count=0
until [ "$(r ping)" = PONG ] && [ "$(field loading)" = 0 ]; do count=$((count + 1)); [ "$count" -lt 600 ]; sleep 0.2; done
loaded=$(field rdb_last_load_keys_loaded); expired=$(field rdb_last_load_keys_expired); keys=$(r dbsize)
[ "$(r config set appendonly yes)" = OK ]
count=0
until [ "$(field aof_enabled)" = 1 ] && [ "$(field aof_rewrite_in_progress)" = 0 ] && [ "$(field aof_rewrite_scheduled)" = 0 ]; do count=$((count + 1)); [ "$count" -lt 3000 ]; sleep 0.2; done
[ "$(field aof_last_bgrewrite_status)" = ok ]
printf '{"loaded":%s,"expiredAtLoad":%s,"keys":%s}\n' "$loaded" "$expired" "$keys"
EOF
  ) || die "Redis snapshot did not load: $service"
  # A clean shutdown syncs the append-only file the product will load.
  timeout 120 docker stop --time 60 "$name" >/dev/null
  [[ $(docker inspect -f '{{.State.ExitCode}}' "$name") == 0 ]] || die "Redis verification did not shut down cleanly: $service"
  docker rm "$name" >/dev/null
  compgen -G "$snapshot_staging/data/$service/appendonlydir/*.manifest" >/dev/null || die "Redis append-only files were not written: $service"
  # Every key saved at capture loaded, or had already reached its absolute expiry.
  jq -e --argjson verified "$result" '($verified.loaded + $verified.expiredAtLoad) <= .keysAtCapture and $verified.keys == $verified.loaded' "$snapshot_staging/work/$service/store.json" >/dev/null || die "Redis key count differs after loading: $service"
  jq -c --argjson verified "$result" '.+{verified:$verified}' "$snapshot_staging/work/$service/store.json" > "$snapshot_staging/work/$service/store.json.next"
  mv -T -- "$snapshot_staging/work/$service/store.json.next" "$snapshot_staging/work/$service/store.json"
}
# Collection snapshots that Qdrant wrote into its live directory, one path per line.
snapshot_qdrant_files() {
  local store=$1 service=$2 relative
  relative=$(jq -r .directory "$store")
  [[ "$relative" =~ ^[A-Za-z0-9._/-]+$ && "$relative" != *..* ]] || return 1
  jq -r --arg base "$directory/data/$service/$relative" '.snapshots|to_entries[]|select((.key|test("^[A-Za-z0-9_.-]+$")) and (.value.name|test("^[A-Za-z0-9_.-]+$")))|$base+"/"+.key+"/"+.value.name' "$store"
}
snapshot_qdrant_verify() {
  local service=$1 store name image user config attempt inventory='' collection file index=0
  store="$snapshot_staging/work/$service/store.json"
  image=$(snapshot_service "$service" '.services[$name].image'); user=$(snapshot_service "$service" '.services[$name].user'); config=$(snapshot_mount "$service" /config)
  install -d -m 700 "$snapshot_staging/work/$service/snapshots"
  local -a restore=()
  # Each collection is restored from its own snapshot, through the product's startup restore.
  local relative; relative=$(jq -r .directory "$store")
  [[ "$relative" =~ ^[A-Za-z0-9._/-]+$ && "$relative" != *..* ]] || die "Qdrant snapshot directory differs: $service"
  while IFS=$'\t' read -r collection file; do
    file="$directory/data/$service/$relative/$collection/$file"
    [[ -f "$file" && ! -L "$file" ]] || die "Qdrant snapshot file is missing: $service $collection"
    mv -T -- "$file" "$snapshot_staging/work/$service/snapshots/$index.snapshot"; rm -f -- "$file.checksum"; rmdir -- "$(dirname -- "$file")" 2>/dev/null || true
    [[ $(digest "$snapshot_staging/work/$service/snapshots/$index.snapshot") == "$(jq -er --arg c "$collection" '.snapshots[$c].checksum' "$store")" ]] || die "Qdrant snapshot checksum differs: $service $collection"
    restore+=(--snapshot "/snapshots/$index.snapshot:$collection"); index=$((index + 1))
  done < <(jq -r '.snapshots|to_entries[]|select((.key|test("^[A-Za-z0-9_.-]+$")) and (.value.name|test("^[A-Za-z0-9_.-]+$")))|[.key,.value.name]|@tsv' "$store")
  [[ $index == $(jq '.snapshots|length' "$store") && $index == $(jq '.collections|length' "$store") ]] || die "Qdrant snapshots are incomplete: $service"
  mapfile -t entry < <(snapshot_service "$service" '.services[$name].entrypoint[]?')
  ((${#entry[@]})) || entry=(/qdrant/qdrant)
  mapfile -t command < <(snapshot_service "$service" '.services[$name].command[]?')
  name=$(snapshot_temporary --user "$user" --workdir /data --mount "type=bind,source=$snapshot_staging/data/$service,target=/data" --mount "type=bind,source=$config,target=/config,readonly" \
    --mount "type=bind,source=$snapshot_staging/work/$service/snapshots,target=/snapshots,readonly" --entrypoint "${entry[0]}" "$image" "${entry[@]:1}" "${command[@]}" "${restore[@]}")
  snapshot_helper "qdrant-verify-$service" "$user" --network "container:$name" --mount "type=bind,source=$config,target=/config,readonly"
  for attempt in $(seq 1 120); do
    inventory=$(snapshot_run "qdrant-verify-$service" '{"command":"qdrant-inventory","url":"http://127.0.0.1:6333","config":"/config/qdrant.yaml"}' 2>/dev/null) &&
      jq -e --argjson inventory "$inventory" '(.collections|keys)==($inventory.collections|keys)' "$store" >/dev/null && break
    inventory=''; sleep 1
  done
  [[ -n "$inventory" ]] || die "Qdrant snapshots did not restore: $service"
  local aliases
  aliases=$(snapshot_run "qdrant-verify-$service" "$(jq -c '{command:"qdrant-aliases",url:"http://127.0.0.1:6333",config:"/config/qdrant.yaml",aliases}' "$store")") || die "Qdrant aliases could not be restored: $service"
  docker rm -f "hive-snapshot-$archive-qdrant-verify-$service" >/dev/null
  timeout 120 docker stop --time 60 "$name" >/dev/null; docker rm "$name" >/dev/null
  rm -rf -- "$snapshot_staging/work/$service/snapshots"
  jq -e --argjson inventory "$inventory" --argjson restored "$aliases" '.collections == ($inventory.collections|map_values(.points)) and (.aliases|sort) == ($restored.aliases|sort)' "$store" >/dev/null || die "Qdrant collections, point counts or aliases differ after restore: $service"
  jq -c --argjson inventory "$inventory" '.+{verified:$inventory}' "$store" > "$store.next"; mv -T -- "$store.next" "$store"
}
snapshot_postgres_verify() {
  local service=$1 store name image user owner attempt databases=''
  store="$snapshot_staging/work/$service/store.json"
  image=$(snapshot_service "$service" '.services[$name].image'); user=$(snapshot_service "$service" '.services[$name].user')
  owner=$(snapshot_service "$service" '.services[$name].environment.POSTGRES_USER // "postgres"')
  mv -T -- "$directory/data/$service/.hive-snapshot-$archive" "$snapshot_staging/data/$service/pgdata"
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user "$user" --mount "type=bind,source=$snapshot_staging/data/$service,target=/data,readonly" \
    --entrypoint pg_verifybackup "$image" --quiet /data/pgdata || die "PostgreSQL base backup verification failed: $service"
  rm -f -- "$snapshot_staging/data/$service/pgdata/backup_manifest"
  # Recovery replays the streamed WAL to the end of the backup, then shuts down cleanly, so
  # the offline checksum verification and a later start see a stopped cluster.
  name=$(snapshot_temporary --user "$user" --tmpfs "/var/run/postgresql:uid=${user%:*},gid=${user#*:},mode=700" -e PGDATA=/data/pgdata \
    --mount "type=bind,source=$snapshot_staging/data/$service,target=/data" "$image")
  for attempt in $(seq 1 180); do
    databases=$(docker exec "$name" psql -h /var/run/postgresql -U "$owner" -d postgres -Atc "SELECT json_agg(json_build_object('name',datname,'bytes',pg_database_size(datname)) ORDER BY datname) FROM pg_database WHERE NOT datistemplate AND NOT pg_is_in_recovery()" 2>/dev/null) && [[ "$databases" == '['* ]] && break
    databases=''; sleep 1
  done
  [[ -n "$databases" ]] || die "PostgreSQL base backup did not recover: $service"
  timeout 180 docker stop --time 120 "$name" >/dev/null
  [[ $(docker inspect -f '{{.State.ExitCode}}' "$name") == 0 ]] || die "PostgreSQL verification did not shut down cleanly: $service"
  docker rm "$name" >/dev/null
  jq -c --argjson databases "$databases" '.+{verified:{databases:$databases}}' "$store" > "$store.next"; mv -T -- "$store.next" "$store"
}
snapshot_verify() {
  local group=$1 service
  for service in $(jq -r '.stores[]' <<< "$group"); do
    case $(snapshot_store "$service") in redis) snapshot_redis_verify "$service";; qdrant) snapshot_qdrant_verify "$service";; postgres) snapshot_postgres_verify "$service";; esac
    # Anything else in a datastore directory is copied as files, without a pause.
    snapshot_files precopy "$service" >/dev/null || die "Snapshot failed: $service"
    snapshot_files capture "$service" > "$snapshot_staging/work/$service/capture.out" || die "Snapshot failed: $service"
  done
  for service in $(jq -r '(.files+.stores)[]' <<< "$group"); do
    snapshot_files verify "$service" > "$snapshot_staging/work/$service/verify.json" || die "Snapshot verification failed: $service"
  done
}

snapshot_group() {
  local group=$1 service attempt status started finished pid
  local -a ids=()
  for service in $(jq -r '(.files+.stores)[]' <<< "$group"); do snapshot_prepare "$service"; done
  # Ordinary files are copied first while serving; the pause only brings them up to date.
  for service in $(jq -r '.files[]' <<< "$group"); do snapshot_files precopy "$service" >/dev/null || die "Snapshot failed: $service"; done
  for service in $(jq -r '.pause[]' <<< "$group"); do ids+=("$(snapshot_id "$service")"); done
  for service in $(jq -r '.stores[]' <<< "$group"); do
    [[ $(snapshot_store "$service") != qdrant ]] || snapshot_helper "qdrant-$service" "$(snapshot_service "$service" '.services[$name].user')" \
      --network "container:$(snapshot_id "$service")" --mount "type=bind,source=$(snapshot_mount "$service" /config),target=/config,readonly"
  done
  for attempt in 1 2 3 4 5; do
    snapshot_pause "${ids[@]}"
    started=$(snapshot_now)
    # A background subshell keeps errexit for every capture step.
    status=0
    snapshot_capture "$group" & pid=$!
    wait "$pid" || status=$?
    snapshot_still_paused || die 'A paused service resumed before its capture finished'
    snapshot_resume || die 'Paused services could not be resumed'
    finished=$(snapshot_now)
    jq -nc --argjson group "$group" --arg seconds "$(snapshot_seconds "$started" "$finished")" --argjson attempt "$attempt" \
      '$group+{pausedSeconds:($seconds|tonumber),attempt:$attempt}' >> "$snapshot_staging/work/pauses.jsonl"
    ((status == 0)) && break
    # A paused writer held a SQLite lock: resume it and capture again.
    ((status == 75 && attempt < 5)) || die "Snapshot failed: $(jq -r '(.pause+.files+.stores)|unique|join(", ")' <<< "$group")"
    sleep "$attempt"
  done
  snapshot_verify "$group"
  for service in $(jq -r '(.files+.stores)[]' <<< "$group"); do docker rm -f "hive-snapshot-$archive-files-$service" "hive-snapshot-$archive-qdrant-$service" >/dev/null 2>&1 || true; done
}

# Free space for the staged snapshot and the compressed archive, which can at most reach the
# size of the data, with the configured reserve left over. Checked before anything is written.
snapshot_space() {
  local data minimum need free
  minimum=$(jq -r '.minimumFreeMiB // 2048' <<< "$input")
  # A serving product may remove a file while du walks the tree: its total still counts.
  data=$({ du -sk -- "$directory/data" 2>/dev/null || true; } | cut -f1)
  [[ "$data" =~ ^[0-9]+$ ]] || die 'The data directory size could not be read'
  need=$(( data * 3 + minimum * 1024 ))
  free=$(df -Pk -- "$directory/backups" | awk 'NR==2 {print $4}')
  ((free >= need)) || die "Online backup needs $((need / 1024)) MiB free for its snapshot and archive; $((free / 1024)) MiB are available. Nothing was changed"
  if [[ $(stat -c %d "$directory/data") != $(stat -c %d "$directory/backups") ]]; then
    free=$(df -Pk -- "$directory/data" | awk 'NR==2 {print $4}')
    ((free >= data + minimum * 1024)) || die "Online backup needs $(((data + minimum * 1024) / 1024)) MiB free beside the data for store snapshots. Nothing was changed"
  fi
}
snapshot_serving() {
  local expected running
  expected=$(jq -r '.services|keys[]' "$directory/compose.json" | sort)
  running=$(compose ps --format json | jq -rs 'flatten|map(select(.State=="running" and ((.Health // "")=="" or .Health=="healthy")))[].Service' | sort)
  [[ -n "$expected" && "$running" == "$expected" ]] || die 'Online backup needs every suite service running and healthy. Nothing was changed; --stopped backs up a stopped suite'
}
snapshot_finish() {
  local status=$? resumed=true name
  trap - EXIT HUP INT TERM
  if ((${#snapshot_paused[@]})); then snapshot_resume || resumed=false; fi
  # Helper and verification containers, including any a timed-out capture left behind.
  for name in "${snapshot_containers[@]}" $(docker ps -aq --filter "name=^hive-snapshot-$archive-" 2>/dev/null); do docker rm -f "$name" >/dev/null 2>&1 || true; done
  for name in "$directory"/data/*/".hive-snapshot-$archive"; do [[ ! -d "$name" || -L "$name" ]] || rm -rf -- "$name"; done
  if [[ -n "$snapshot_staging" && -d "$snapshot_staging/work" ]]; then
    # A Qdrant snapshot that was never moved out of the live store is removed again.
    local file
    for name in "$snapshot_staging"/work/*/store.json; do
      [[ -f "$name" ]] && jq -e '.method=="qdrant-collection-snapshots"' "$name" >/dev/null 2>&1 || continue
      while IFS= read -r file; do [[ ! -f "$file" || -L "$file" ]] || rm -f -- "$file" "$file.checksum"; done < <(snapshot_qdrant_files "$name" "$(basename -- "$(dirname -- "$name")")")
    done
  fi
  [[ -z "$snapshot_staging" ]] || rm -rf -- "$snapshot_staging"
  if [[ "$snapshot_succeeded" != true && -n "$snapshot_created" ]]; then rm -rf -- "$snapshot_created"; fi
  if [[ "$resumed" != true ]]; then
    record recovery-required
    printf 'Hive host: paused services could not be resumed: run docker unpause for the installation containers\n' >&2
    exit 1
  fi
  if [[ "$snapshot_succeeded" != true ]]; then
    # Nothing in the installation changed: the transaction closes and services keep serving.
    record complete
    printf 'Hive host: online backup failed; every service kept serving and no archive was kept\n' >&2
    ((status != 0)) || status=1
  fi
  exit "$status"
}

snapshot_online() {
  assert_transaction
  [[ $(phase) == prepared ]] || die 'Online backup needs a prepared backup transaction'
  [[ "$archive" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$ ]] || die 'A backup ID is required'
  backup="$directory/backups/$archive"
  if [[ -e "$backup" ]]; then verify_archive; record complete; exit 0; fi
  # From here on a failure closes the transaction: nothing in the installation is changed.
  trap snapshot_finish EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
  [[ -f "$directory/compose.json" && -f "$directory/receipt.json" ]] || die 'Online backup needs an active installation'
  snapshot_manifest="$directory/manifest.$plan.json"
  [[ -f "$snapshot_manifest" && $(digest "$snapshot_manifest") == "$(jq -er .digest <<< "$input")" ]] || die 'Release digest differs'
  snapshot_code=$(jq -er .snapshotTool <<< "$input" | base64 -d) && [[ -n "$snapshot_code" ]] || die 'Snapshot helper is missing'
  snapshot_serving
  snapshot_space
  local groups=() group started name agents
  mapfile -t groups < <(snapshot_groups) && ((${#groups[@]})) || die 'Capture groups could not be planned'
  for name in $(jq -r '.services|keys[]' "$directory/compose.json"); do
    [[ $(snapshot_kind "$name") != datastore || $(snapshot_store "$name") != unknown ]] || die "No online snapshot method for $name. Nothing was changed; --stopped backs it up"
  done
  [[ -z $(find "$directory/config" "$directory/releases" ! -type f ! -type d -print -quit) ]] || die 'Backup tree contains unsupported links or special files'
  # The controller lock is held, so any earlier staging is from an interrupted run.
  for name in "$directory"/backups/.online-*; do [[ ! -d "$name" || -L "$name" ]] || rm -rf -- "$name"; done
  snapshot_staging="$directory/backups/.online-$archive"
  install -d -m 700 "$snapshot_staging" "$snapshot_staging/data" "$snapshot_staging/work" "$snapshot_staging/archive"
  docker image inspect "$recovery_image" >/dev/null 2>&1 || docker pull --quiet "$recovery_image" >/dev/null
  started=$(snapshot_now)
  local captured_at; captured_at=$(date -u +%FT%T.%3NZ)
  for group in "${groups[@]}"; do snapshot_group "$group"; done
  # Native agent profiles are not suite stores: the agents stop only while theirs are copied.
  agents=null
  if [[ $(jq '.agents|length' <<< "$input") != 0 ]]; then
    local agents_started; agents_started=$(snapshot_now)
    adapter_agents_service stop; adapter_snapshot_profiles; adapter_agents_service start
    agents=$(snapshot_seconds "$agents_started" "$(snapshot_now)")
  fi
  while IFS= read -r name; do [[ -d "$snapshot_staging/data/$name" ]] || die "No snapshot was taken of $name"; done < <(jq -r '.services|to_entries[]|select(any(.value.volumes[]?; .target=="/data"))|.key' "$directory/compose.json")
  [[ -z $(find "$snapshot_staging/data" ! -type f ! -type d -print -quit) ]] || die 'Snapshot contains unsupported links or special files'
  check_data "$snapshot_staging" "$directory/compose.json" || die 'Snapshot integrity verification failed'
  local members=(config releases compose.json receipt.json installation.json) part="$snapshot_staging/archive/state.tar.gz"
  [[ ! -d "$directory/agents" ]] || members+=(agents)
  [[ ! -d "$directory/agent-profiles" ]] || members+=(agent-profiles)
  [[ ! -f "$directory/data-formats.json" ]] || members+=(data-formats.json)
  local data_sha config_sha
  # One parallel pass hashes every staged file: the receipt digest and the file manifest.
  tree_lines "$snapshot_staging/data" > "$snapshot_staging/work/files.sha256"
  data_sha=$(sha256sum < "$snapshot_staging/work/files.sha256" | cut -d ' ' -f1); config_sha=$(tree_digest "$directory/config")
  jq -Rs 'split("\u0000")|map(select(length>0)|{key:.[68:],value:.[0:64]})|from_entries' "$snapshot_staging/work/files.sha256" > "$snapshot_staging/archive/snapshot.json"
  # Streamed straight into the compressed archive: the staged snapshot is the only full copy.
  tar --sparse --hard-dereference -czf "$part.partial" -C "$snapshot_staging" data -C "$directory" "${members[@]}"
  # The archive is read back while the suite serves: the whole compressed stream must check
  # out, and its data must hold exactly the staged files with their sizes. Rehearse and restore
  # check every byte against the receipt digest.
  [[ $(tar -tvzf "$part.partial" data | awk 'substr($0,1,1)=="-" {n++; s+=$3} END {print n+0, s+0}') == \
    $(find "$snapshot_staging/data" -type f -printf '%s\n' | awk '{n++; s+=$1} END {print n+0, s+0}') ]] || die 'Archive data differs from the snapshot'
  mv -T -- "$part.partial" "$part"
  local stores
  stores=$(for name in "$snapshot_staging"/work/*/; do
    name=${name%/}; jq -nc --arg service "$(basename -- "$name")" --slurpfile verify "$name/verify.json" --slurpfile store <(cat "$name/store.json" 2>/dev/null || printf 'null') \
      '{key:$service,value:({files:$verify[0].files,bytes:$verify[0].bytes,sqlite:$verify[0].sqlite} + (if $store[0] then {store:$store[0]} else {} end))}'
  done | jq -s from_entries)
  jq -n --arg uuid "$identity" --arg id "$installation" --arg host "$host" --arg sha "$(digest "$part")" --arg dataSHA "$data_sha" --arg configSHA "$config_sha" \
    --arg startedAt "$captured_at" --arg finishedAt "$(date -u +%FT%T.%3NZ)" --arg seconds "$(snapshot_seconds "$started" "$(snapshot_now)")" --argjson agents "$agents" \
    --slurpfile release "$directory/receipt.json" --slurpfile pauses <(jq -s 'map(select(.pause|length>0))' "$snapshot_staging/work/pauses.jsonl") --argjson stores "$stores" --arg manifestSHA "$(digest "$snapshot_staging/archive/snapshot.json")" \
    '{schema:1,uuid:$uuid,installation:$id,host:$host,sha256:$sha,dataSHA256:$dataSHA,configSHA256:$configSHA,verified:true,release:$release[0],
      mode:"online",snapshot:{startedAt:$startedAt,finishedAt:$finishedAt,seconds:($seconds|tonumber),
        longestPauseSeconds:([$pauses[0][].pausedSeconds]|max // 0),pauses:$pauses[0],agentStopSeconds:(if $agents==null then null else ($agents|tonumber) end),
        stores:$stores,fileManifestSHA256:$manifestSHA}}' > "$snapshot_staging/archive/receipt.json"
  chmod 600 "$snapshot_staging/archive/receipt.json" "$snapshot_staging/archive/snapshot.json"
  mv -T -- "$snapshot_staging/archive" "$backup"; snapshot_created=$backup
  sync -f "$backup/state.tar.gz"
  verify_archive
  record complete
  snapshot_succeeded=true
  jq -c --arg archive "$archive" --argjson bytes "$(stat -c %s "$backup/state.tar.gz")" '{archive:$archive,host,mode,seconds:.snapshot.seconds,longestPauseSeconds:.snapshot.longestPauseSeconds,bytes:$bytes}' "$backup/receipt.json"
}
