#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/integrity-host.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
mkdir -p "$temporary/data/first" "$temporary/data/last"
input=$(jq -nc --arg code "$(printf 'console.log("synthetic")' | base64 -w0)" '{integrityScript:$code}')
recovery_image='example.com/synthetic@sha256:0000000000000000000000000000000000000000000000000000000000000000'
jq -n --arg user "$(id -u):$(id -g)" '{services:{first:{user:$user,volumes:[{target:"/data"}]},last:{user:$user,volumes:[{target:"/data"}]}}}' > "$temporary/compose.json"
docker() { printf 'called\n' >> "$temporary/calls"; [[ $(wc -l < "$temporary/calls") != 1 ]]; }
if check_data "$temporary" "$temporary/compose.json" > "$temporary/result" 2>&1; then printf 'FAIL: a later service masked an integrity failure\n' >&2; exit 1; fi
[[ $(wc -l < "$temporary/calls") == 1 ]]
printf 'Passed: first integrity failure propagates before later services run.\n'
