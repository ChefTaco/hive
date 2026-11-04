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
printf 'Passed: pinned mounted configuration, credential drift refusal, exact retry and propagation of any file-read failure.\n'
