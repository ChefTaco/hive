#!/usr/bin/env bash
# Real-image upgrade round trip between two signed releases, each run by its own tagged
# controller: install FROM with the core profile, check it, upgrade to TO with
# --allow-migrations, run post-upgrade and doctor, then roll back to FROM (unless --no-rollback or
# the releases cross a storage format that refuses code-only rollback, which
# scripts/release/rollback-crossing.sh decides) and check again. It pulls
# the published images of both releases and needs Docker, jq, openssl, git and an unprivileged
# account that can use Docker; it binds the console to 127.0.0.1 on a free port and removes its
# containers at the end. The workflow release-upgrade.yml runs it.
#   bash scripts/suite/release-upgrade-roundtrip.sh --from X.Y.Z --to X.Y.Z --output NEW_DIRECTORY [--profile core|full] [--no-rollback] [--keep]
# The full profile adds what the release lists for it: Magnus, Cindertrace and ChatterMost with
# their PostgreSQL and Redis stores, and Emberfold, whose signed schema initializations and
# migrations the install and the upgrade then run.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
from='' to='' output='' rollback=true keep=false profile=core
while (($#)); do
  case $1 in
    --from) from=$2; shift 2;;
    --to) to=$2; shift 2;;
    --output) output=$2; shift 2;;
    --no-rollback) rollback=false; shift;;
    --keep) keep=true; shift;;
    --profile) profile=$2; shift 2;;
    *) printf 'Unknown option %s\n' "$1" >&2; exit 2;;
  esac
done
die() { printf 'release-upgrade-roundtrip: %s\n' "$*" >&2; exit 1; }
[[ "$from" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$to" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Use --from X.Y.Z --to X.Y.Z --output NEW_DIRECTORY'
[[ "$profile" == core || "$profile" == full ]] || die '--profile is core or full'
[[ -n "$output" && ! -e "$output" ]] || die 'Choose a new --output directory; existing evidence is never overwritten'
[[ $(id -u) != 0 ]] || die 'Run as an unprivileged account with Docker access'
for tool in docker jq openssl git; do command -v "$tool" >/dev/null || die "$tool is required"; done
mkdir -p -- "$output"; output=$(realpath -e -- "$output")
id="rt-$(openssl rand -hex 3)"
log="$output/steps.log"
step() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$log"; }

# Each release's own tagged controller, as a clean checkout.
checkout() { # VERSION
  local directory="$output/v$1"
  git -C "$ROOT" rev-parse --verify --quiet "refs/tags/v$1^{commit}" >/dev/null || die "Tag v$1 is not in this clone; fetch tags first"
  git clone --quiet --shared --no-checkout -- "$ROOT" "$directory"
  git -C "$directory" checkout --quiet --detach "v$1"
  [[ -f "$directory/releases/$1.json" ]] || die "v$1 has no signed manifest releases/$1.json"
  printf '%s\n' "$directory"
}
old=$(checkout "$from"); new=$(checkout "$to")

# A core (or full) installation on this machine, as unattended setup takes it.
installation="$output/installation"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || shuf -i 20000-60000 -n 1)
name="$id.localhost"
mkdir -m 700 "$output/tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 -subj "/CN=$name" -addext "subjectAltName=DNS:$name" \
  -keyout "$output/tls/console.key" -out "$output/tls/console.crt" >/dev/null 2>&1
chmod 600 "$output/tls/console.key" "$output/tls/console.crt"
config="$output/config/$id/installation.json"
mkdir -p -m 700 "$(dirname -- "$config")"
jq --arg id "$id" --arg release "$from" --arg profile "$profile" --slurpfile release_manifest "$old/releases/$from.json" --arg base "$installation" --arg origin "https://$name:$port" --argjson port "$port" \
  --arg certificate "$output/tls/console.crt" --arg key "$output/tls/console.key" '
  .installation=$id | .release=$release | .profile=$profile | .origin=$origin | .hosts.control.directory=$base |
  # The full profile: every component the release lists for it, placed as guided setup places them.
  (if $profile=="full" then .components += ($release_manifest[0].profiles.full - (.components|keys)
    | map({key:., value:({host:"control",configDirectory:("/opt/hive/config/"+.)} + (if test("-(postgres|redis|qdrant)$") then {} else {envFile:("/opt/hive/config/"+.+".env")} end))}) | from_entries) else . end) |
  .components|=with_entries(.value|=(if .envFile then .envFile=($base+"/config/"+(.envFile|split("/")[-1])) else . end |
    if .configDirectory then .configDirectory=($base+"/config/"+(.configDirectory|split("/")[-1])) else . end)) |
  .console.bindAddress="127.0.0.1" | .console.httpsPort=$port | .console.runtimeFile=($base+"/config/runtime.json") |
  .bootstrap={adminUsername:"admin",adminEmail:"admin@example.com",certificateFile:$certificate,privateKeyFile:$key}' \
  "$old/examples/installation.json" > "$config"
chmod 600 "$config"

cleanup() {
  local status=$?
  if [[ "$keep" != true ]]; then
    local compose
    for compose in "$installation/compose.json" "$installation"/candidate.*.json "$installation"/rehearsals/*/isolated.json; do
      [[ -f "$compose" ]] && docker compose -f "$compose" down --volumes --remove-orphans >/dev/null 2>&1 || true
    done
    # Containers of this run that a definition above no longer names.
    docker ps -aq --filter "name=$id" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  if ((status == 0)); then step "PASSED $from -> $to"; else step "FAILED $from -> $to (exit $status); evidence in $output"; fi
}
trap cleanup EXIT

run() { # CONTROLLER COMMAND [ARGUMENTS...]
  local controller=$1; shift
  step "$(basename -- "$controller") $*"
  HIVE_SETUP_LOCAL=no "$controller/hive.sh" "$@" --config "$config" --non-interactive < /dev/null 2>&1 | tee -a "$output/$1.log"
}
run "$old" init --release "$from" --yes
run "$old" install --release "$from" --yes
run "$old" doctor --release "$from"
run "$old" status --release "$from" > /dev/null
run "$new" upgrade --release "$to" --yes --allow-migrations
run "$new" post-upgrade --release "$to" --yes
run "$new" doctor --release "$to"
# A code-only rollback is refused across a storage format the older release cannot read; the way
# back from such an upgrade is its pre-upgrade backup, so the round trip ends after the upgrade.
crossing=$(bash "$ROOT/scripts/release/rollback-crossing.sh" "$old/releases/$from.json" "$new/releases/$to.json" | tr '\n' ' ')
if [[ "$rollback" == true && -n "$crossing" ]]; then
  step "rollback skipped: $from cannot read the storage format of ${crossing% } after $to"
  rollback=false
fi
# post-upgrade can add settings (from 3.15.1, the browser sign-in settings), which changes the
# deployment inputs FROM's plan pinned. A rollback to that plan then stops with "Deployment input
# artifacts changed for this plan" until the configuration has a new revision, as UPGRADING.md
# tells operators; the round trip does the same.
if [[ "$rollback" == true ]] && grep -q '^Added in ' "$output/post-upgrade.log"; then
  revision=$(jq -r '.configurationRevision // "1"' "$config")
  jq --arg revision "$revision-rollback" '.configurationRevision=$revision' "$config" > "$config.next" && mv -- "$config.next" "$config"
  step "post-upgrade changed the configuration: configurationRevision $revision -> $revision-rollback before the rollback"
fi
if [[ "$rollback" == true ]]; then
  run "$old" rollback --release "$from" --yes
  run "$old" doctor --release "$from"
fi
