#!/usr/bin/env bash
# The stable hive command runs the controller that last ran the installation, and nothing else.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
source "$ROOT/scripts/suite/controller.sh"
# A release checkout: exactly the controller runtime files.
checkout=$temporary/releases/1.2.3
while IFS= read -r file; do
  mkdir -p "$checkout/$(dirname -- "$file")"
  cp -p "$ROOT/$file" "$checkout/$file"
done < <(hive_runtime_files)
grep -qx 'scripts/suite/hive-entry.sh' <(hive_runtime_files) || fail 'The entry point is not a controller runtime file'
export XDG_STATE_HOME=$temporary/state
unset HIVE_INSTALLATION
jq '.installation="example-suite"' "$ROOT/examples/installation.json" > "$temporary/installation.json"
record() { # INSTALLATION
  ( HIVE_ROOT=$checkout HIVE_ID=$1 HIVE_VERSION=1.2.3 HIVE_CONFIG=$temporary/installation.json
    source "$checkout/scripts/suite/controller.sh"; source "$checkout/scripts/suite/entry-point.sh"; hive_entry_point_record upgrade )
}
record example-suite
state=$XDG_STATE_HOME/hive/example-suite/controller.json
[[ $(stat -c %a "$state") == 600 ]] || fail 'The record is not owner-only'
jq -e --arg controller "$checkout/hive.sh" --arg config "$temporary/installation.json" \
  '.schema==1 and .installation=="example-suite" and .release=="1.2.3" and .controller==$controller and .config==$config and .operation=="upgrade" and (.controllerSHA256|test("^[a-f0-9]{64}$"))' "$state" >/dev/null || fail 'The record is incomplete'
( HIVE_ROOT=$ROOT; source "$ROOT/scripts/suite/entry-point.sh"; hive_entry_point_command install "$temporary/bin" ) > "$temporary/out" || fail 'entry-point install failed'
cmp -s "$temporary/bin/hive" "$ROOT/scripts/suite/hive-entry.sh" && [[ -x "$temporary/bin/hive" ]] || fail 'The entry point was not installed as is'
grep -q 'Add .* to PATH' "$temporary/out" || fail 'A directory outside PATH was not pointed out'
# With one recorded installation, the command runs its controller with the arguments unchanged.
"$temporary/bin/hive" --help > "$temporary/help" 2>&1 || { cat "$temporary/help" >&2; fail 'The recorded controller did not run'; }
grep -q 'entry-point' "$temporary/help" || fail 'The output is not the recorded controller usage'
"$temporary/bin/hive" --config "$temporary/installation.json" --help >/dev/null 2>&1 || fail '--config did not select the recorded installation'
HIVE_INSTALLATION=example-suite "$temporary/bin/hive" --help >/dev/null 2>&1 || fail 'HIVE_INSTALLATION did not select the recorded installation'
refuse() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/out" 2>&1; then fail "Accepted: $message"; fi
  grep -q -- "$message" "$temporary/out" || { cat "$temporary/out" >&2; fail "Unclear refusal: $message"; }
}
refuse 'No controller is recorded for other' env HIVE_INSTALLATION=other "$temporary/bin/hive" status
record second-suite
refuse 'not exactly one recorded installation' "$temporary/bin/hive" status
rm -rf -- "$XDG_STATE_HOME/hive/second-suite"
chmod 0644 "$state"
refuse 'readable by its owner only' "$temporary/bin/hive" status
chmod 0600 "$state"
# A modified controller is refused before any of its code runs: the digest is computed from the
# literal runtime list without sourcing the checkout.
cp "$checkout/scripts/suite/controller.sh" "$temporary/controller.original"
printf 'touch %q\n' "$temporary/executed" >> "$checkout/scripts/suite/controller.sh"
refuse 'changed since it ran example-suite (release 1.2.3)' "$temporary/bin/hive" status
[[ ! -e "$temporary/executed" ]] || fail 'The entry point ran a modified controller before refusing it'
cp "$temporary/controller.original" "$checkout/scripts/suite/controller.sh"
"$temporary/bin/hive" --help >/dev/null 2>&1 || fail 'The restored controller was refused'
printf '\n' >> "$checkout/scripts/suite/lifecycle.sh"
refuse 'changed since it ran example-suite (release 1.2.3)' "$temporary/bin/hive" status
mv "$checkout" "$temporary/moved"
refuse 'is missing' "$temporary/bin/hive" status
( HIVE_ROOT=$ROOT; source "$ROOT/scripts/suite/entry-point.sh"; hive_entry_point_command status ) | grep -q '^example-suite: release 1.2.3, ' || fail 'entry-point status does not list the record'
"$ROOT/hive.sh" entry-point status | grep -q '^example-suite: release 1.2.3' || fail 'hive.sh entry-point does not dispatch without a configuration'
grep -q 'hive_entry_point_record "$operation"' "$ROOT/scripts/suite/lifecycle.sh" || fail 'Lifecycle operations do not record their controller'
printf 'Passed: the hive command runs the controller that last ran the installation, checks its digest and record, and refuses ambiguity.\n'
