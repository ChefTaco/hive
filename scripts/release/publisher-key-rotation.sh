#!/usr/bin/env bash
# Publisher key rotation statements (docs/RELEASING.md#rotating-the-key).
#   publisher-key-rotation.sh check
#     Verifies trust/rotations: numbered NNNN.json statements from 0001, each signed by the
#     key it retires, forming one chain whose newest key is trust/publisher.pub.
#   publisher-key-rotation.sh create --retired-key OLD.key --next-key NEW.pub --first-release X.Y.Z
#     Run offline by the maintainer: writes the next statement, signs it with the retired
#     private key and installs NEW.pub as trust/publisher.pub. Commit all three in the release
#     that first uses the new key.
set -Eeuo pipefail
root=${HIVE_ROTATION_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
hive_die() { printf '%s\n' "$*" >&2; exit 1; }
# shellcheck source=../suite/release-launcher.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../suite/release-launcher.sh"
directory=$root/trust/rotations

check() {
  local current expected=1 statement name retired next first
  current=$(hive_release_key_fingerprint "$root/trust/publisher.pub") || hive_die 'trust/publisher.pub is not a public key'
  [[ -e "$directory" ]] || { printf 'publisher key: %s (no rotations)\n' "$current"; return 0; }
  for statement in "$directory"/*; do
    name=${statement##*/}
    [[ $name =~ ^[0-9]{4}\.json(\.sig)?$ ]] || hive_die "Unexpected file trust/rotations/$name"
  done
  hive_release_rotations "$root" >/dev/null || exit 1
  local previous=''
  for statement in "$directory"/*.json; do
    name=${statement##*/}
    [[ $((10#${name%.json})) == "$expected" ]] || hive_die "Rotation statements must be numbered 0001, 0002, ... without gaps (found $name)"
    retired=$(jq -r .retiredKeySHA256 "$statement"); next=$(jq -r .nextKeySHA256 "$statement"); first=$(jq -r .firstRelease "$statement")
    [[ -z "$previous" || $retired == "$previous" ]] || hive_die "$name does not retire the key introduced by the previous statement"
    [[ -z "${last_first:-}" ]] || hive_release_version_before "$last_first" "$first" || hive_die "$name firstRelease must be later than the previous statement's"
    previous=$next last_first=$first expected=$((expected + 1))
  done
  [[ $previous == "$current" ]] || hive_die 'The newest rotation statement does not introduce trust/publisher.pub'
  printf 'publisher key: %s (%d rotation(s) verified)\n' "$current" "$((expected - 1))"
}

create() {
  local retired_key='' next_key='' first='' count number statement work
  while (($#)); do
    case "$1" in
      --retired-key) retired_key=${2:?}; shift 2;;
      --next-key) next_key=${2:?}; shift 2;;
      --first-release) first=${2:?}; shift 2;;
      *) hive_die "Unknown option $1";;
    esac
  done
  [[ -f "$retired_key" && -f "$next_key" ]] || hive_die 'Pass --retired-key PRIVATE_KEY and --next-key PUBLIC_KEY'
  [[ $first =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || hive_die 'Pass --first-release X.Y.Z, the first release signed by the new key'
  check >/dev/null
  work=$(mktemp -d); trap 'rm -rf -- "$work"' RETURN
  openssl pkey -in "$retired_key" -pubout -out "$work/retired.pub" 2>/dev/null || hive_die 'Cannot read the retired private key'
  cmp -s <(openssl pkey -pubin -in "$work/retired.pub" -outform DER) <(openssl pkey -pubin -in "$root/trust/publisher.pub" -outform DER) || hive_die 'The retired key is not the current trust/publisher.pub'
  openssl pkey -pubin -in "$next_key" -out "$work/next.pub" 2>/dev/null || hive_die 'Cannot read the next public key'
  mkdir -p "$directory"
  count=$(find "$directory" -maxdepth 1 -name '*.json' | wc -l)
  printf -v number '%04d' "$((count + 1))"
  statement=$directory/$number.json
  jq -n --rawfile retired "$work/retired.pub" --rawfile next "$work/next.pub" --arg first "$first" \
    --arg retiredSHA "$(hive_release_key_fingerprint "$work/retired.pub")" --arg nextSHA "$(hive_release_key_fingerprint "$work/next.pub")" \
    '{schema:1,kind:"hive-publisher-key-rotation",retiredKeySHA256:$retiredSHA,retiredKey:$retired,nextKeySHA256:$nextSHA,nextKey:$next,firstRelease:$first}' > "$statement"
  openssl pkeyutl -sign -inkey "$retired_key" -rawin -in "$statement" -out "$statement.sig"
  cp -- "$work/next.pub" "$root/trust/publisher.pub"
  check
}

case "${1:-}" in
  check) check;;
  create) shift; create "$@";;
  *) hive_die 'Usage: publisher-key-rotation.sh check | create --retired-key OLD.key --next-key NEW.pub --first-release X.Y.Z';;
esac
