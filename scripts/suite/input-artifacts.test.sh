#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/input-artifacts-host.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
directory=$temporary plan=synthetic-input-plan
mkdir -m 700 "$temporary/config"
printf 'SYNTHETIC_CREDENTIAL=obviously-fake-original\n' > "$temporary/first.env"
printf 'SYNTHETIC_CREDENTIAL=obviously-fake-last\n' > "$temporary/last.env"
printf 'protected fixture\n' > "$temporary/config/owned.json"
chmod 600 "$temporary/first.env" "$temporary/last.env" "$temporary/config/owned.json"
jq -n --arg base "$temporary" '{services:{first:{env_file:[($base+"/first.env")],volumes:[{source:($base+"/config"),read_only:true}]},last:{env_file:[($base+"/last.env")]}}}' > "$temporary/compose.json"
atomic_json() { jq . > "$1"; chmod 600 "$1"; }
die() { printf '%s\n' "$*" >&2; return 1; }
pin_deployment_inputs "$temporary/compose.json"
assert_deployment_inputs "$temporary/compose.json"
printf 'SYNTHETIC_CREDENTIAL=obviously-fake-changed\n' > "$temporary/first.env"
if assert_deployment_inputs "$temporary/compose.json" > "$temporary/result" 2>&1; then printf 'FAIL: changed input passed activation verification\n' >&2; exit 1; fi
if pin_deployment_inputs "$temporary/compose.json" > "$temporary/result" 2>&1; then printf 'FAIL: retry repinned changed credentials\n' >&2; exit 1; fi
printf 'SYNTHETIC_CREDENTIAL=obviously-fake-original\n' > "$temporary/first.env"
assert_deployment_inputs "$temporary/compose.json"
sha256sum() { if [[ "${*: -1}" == "$temporary/first.env" ]]; then return 23; fi; command sha256sum "$@"; }
if deployment_inputs_digest "$temporary/compose.json" > "$temporary/result" 2>&1; then printf 'FAIL: a later file masked an input read failure\n' >&2; exit 1; fi
if assert_deployment_inputs "$temporary/compose.json" > "$temporary/result" 2>&1; then printf 'FAIL: failed artifact reading was accepted\n' >&2; exit 1; fi
unset -f sha256sum

# A rehearsal pins the release's Caddyfile; the upgrade of the same plan installs it first
# (as refresh_ingress does) and finds the same pin. A later hand edit is still refused.
mkdir -m 700 "$temporary/config/ingress"
printf 'previous ingress routes\n' > "$temporary/config/ingress/Caddyfile"
printf 'native routes\n' > "$temporary/config/ingress/native-routes.caddy"
chmod 600 "$temporary/config/ingress/Caddyfile" "$temporary/config/ingress/native-routes.caddy"
jq -n --arg base "$temporary" '{services:{ingress:{env_file:[($base+"/last.env")],volumes:[{source:($base+"/config/ingress"),target:"/config",read_only:true}]}}}' > "$temporary/ingress.json"
release=$(printf 'release ingress routes\nreverse_proxy hive-registry:8095' | base64 -w0)
request() { jq -nc --arg operation "$1" --arg template "$release" --argjson placements "$2" '{operation:$operation,ingressTemplate:$template,placements:$placements}'; }
refresh() {
  local caddyfile=$temporary/config/ingress/Caddyfile
  cp -p -- "$caddyfile" "$caddyfile.previous"
  printf '%s\n' "$(base64 -d <<< "$release")" > "$caddyfile.new"
  chmod --reference="$caddyfile" "$caddyfile.new"; mv -T -- "$caddyfile.new" "$caddyfile"
}
plan=synthetic-rehearsed-plan input=$(request rehearse '{"hive-registry":{},"ingress":{}}')
pin_deployment_inputs "$temporary/ingress.json"
assert_deployment_inputs "$temporary/ingress.json"
cmp -s "$temporary/config/ingress/Caddyfile" <(printf 'previous ingress routes\n') || { printf 'FAIL: a rehearsal changed the live Caddyfile\n' >&2; exit 1; }
refresh
input=$(request upgrade '{"hive-registry":{},"ingress":{}}')
pin_deployment_inputs "$temporary/ingress.json" || { printf 'FAIL: the upgrade refused the Caddyfile its rehearsal pinned\n' >&2; exit 1; }
assert_deployment_inputs "$temporary/ingress.json"
printf 'retained again\n' > "$temporary/config/ingress/Caddyfile.pre-registry"; chmod 600 "$temporary/config/ingress/Caddyfile.pre-registry"
assert_deployment_inputs "$temporary/ingress.json" || { printf 'FAIL: a retained Caddyfile copy counted as an input\n' >&2; exit 1; }
printf 'hand edit\n' >> "$temporary/config/ingress/Caddyfile"
if assert_deployment_inputs "$temporary/ingress.json" > "$temporary/result" 2>&1; then printf 'FAIL: a Caddyfile edit after staging passed activation verification\n' >&2; exit 1; fi
printf 'native routes changed\n' > "$temporary/config/ingress/native-routes.caddy"
plan=synthetic-other-rehearsal input=$(request rehearse '{"hive-registry":{},"ingress":{}}')
pin_deployment_inputs "$temporary/ingress.json"
printf 'native routes\n' > "$temporary/config/ingress/native-routes.caddy"
if assert_deployment_inputs "$temporary/ingress.json" > "$temporary/result" 2>&1; then printf 'FAIL: a rehearsal stopped pinning the other ingress files\n' >&2; exit 1; fi
# Without the registry on this host nothing refreshes the Caddyfile, so the live file counts.
printf 'previous ingress routes\n' > "$temporary/config/ingress/Caddyfile"
plan=synthetic-unplaced-rehearsal input=$(request rehearse '{"ingress":{}}')
pin_deployment_inputs "$temporary/ingress.json"
refresh
input=$(request upgrade '{"ingress":{}}')
if assert_deployment_inputs "$temporary/ingress.json" > "$temporary/result" 2>&1; then printf 'FAIL: a host without the registry pinned the release Caddyfile\n' >&2; exit 1; fi
printf 'Passed: pinned mounted configuration, credential drift refusal, exact retry, propagation of any file-read failure, and a rehearsal pinning the Caddyfile its upgrade installs.\n'
