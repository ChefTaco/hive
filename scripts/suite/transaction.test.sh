#!/usr/bin/env bash
# A lifecycle transaction that fails in its read-only checks (stage, compatibility, preflight)
# closes as aborted, and the next plan proceeds. From quiescence on, it stays open for recovery.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
directory="$temporary/install"
mkdir -p "$directory" "$temporary/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$temporary/bin/docker"; chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
printf '{"installation":"example-suite","host":"control","uuid":"fixture"}' > "$directory/installation.json"
script=''
for file in ownership-host.sh public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh inference-registration.sh initialize-migrations-host.sh host-runtime.sh; do
  script+=$(cat "$ROOT/scripts/suite/$file")$'\n'
done
host() { # ACTION PLAN [STEP] [OPERATION]
  jq -nc --arg directory "$directory" --arg action "$1" --arg plan "$2" --arg step "${3:-}" --arg operation "${4:-upgrade}" \
    '{directory:$directory,installation:"example-suite",host:"control",action:$action,plan:$plan,version:"0.1.0",archive:"",operation:$operation,abortStep:$step,agents:[],inference:[],placements:{}}' |
    bash -c "$script" > "$temporary/host.log" 2>&1
}
phase() { jq -r .phase "$directory/transaction.json"; }
id() { printf '%064d' "$1"; }

# An abort in each read-only check closes the transaction, keeps its record, and lets the next plan in.
plan=0
for step in stage compatibility adapters-preflight; do
  plan=$((plan + 1)); previous=$plan
  host prepare "$(id "$plan")" || { cat "$temporary/host.log" >&2; fail 'prepare failed'; }
  [[ $(phase) == prepared ]] || fail 'prepare did not open the transaction'
  host abort "$(id "$plan")" "$step" || { cat "$temporary/host.log" >&2; fail "A failed $step did not abort"; }
  jq -e --arg step "$step" '.phase=="aborted" and .abortedStep==$step and (.abortedAt|test("^[0-9-]+T"))' "$directory/transaction.json" >/dev/null || fail "The $step abort was not recorded"
  jq -e '.phase=="aborted"' "$directory/aborted-transaction.$(id "$plan").json" >/dev/null || fail 'The aborted transaction record was not kept'
  # The same plan may run again, and so may a new one.
  host prepare "$(id "$previous")" && [[ $(phase) == prepared ]] || fail 'The aborted plan could not run again'
  host abort "$(id "$previous")" "$step" || fail 'The repeated plan could not abort again'
done
plan=$((plan + 1))
host prepare "$(id "$plan")" && [[ $(phase) == prepared ]] || fail 'A new plan could not start after an abort'

# Only the read-only checks abort, and only the open plan.
for step in '' activate quiesce migrate; do
  if host abort "$(id "$plan")" "$step"; then fail "A step '$step' aborted the transaction"; fi
done
if host abort "$(id 99)" stage; then fail 'Another plan aborted this transaction'; fi
[[ $(phase) == prepared ]] || fail 'A refused abort changed the transaction'

# Anything that changed the host keeps the transaction open for recovery.
touch "$directory/bootstrap.$(id "$plan").json"
if host abort "$(id "$plan")" stage; then fail 'A plan that initialized data aborted'; fi
rm "$directory/bootstrap.$(id "$plan").json"
mkdir -p "$directory/agents/agent-1"; touch "$directory/agents/agent-1/run.$(id "$plan").new"
if host abort "$(id "$plan")" stage; then fail 'A plan that staged an agent aborted'; fi
rm -r "$directory/agents"
printf '{"version":"0.1.0","plan":"%s"}' "$(id "$plan")" > "$directory/receipt.json"
if host abort "$(id "$plan")" stage; then fail 'An active plan aborted'; fi
rm "$directory/receipt.json"

# From quiescence on, recovery is unchanged: no abort, and no other plan starts.
host quiesce "$(id "$plan")" || { cat "$temporary/host.log" >&2; fail 'quiesce failed'; }
[[ $(phase) == quiesced ]] || fail 'quiesce did not record its phase'
if host abort "$(id "$plan")" stage; then fail 'A quiesced transaction aborted'; fi
grep -q 'needs recovery' "$temporary/host.log" || fail 'The quiesced refusal does not say recovery is needed'
if host prepare "$(id 98)"; then fail 'A new plan started over a quiesced transaction'; fi
grep -q 'A different transaction requires recovery' "$temporary/host.log" || fail 'The refusal of a new plan changed'
[[ $(phase) == quiesced ]] || fail 'A refused plan changed the transaction'

# The controller aborts every host it prepared, and only those, then fails with the reason.
controller() { # FAILING_STEP
  (
    export HIVE_ROOT=$ROOT
    source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/lifecycle.sh"
    HIVE_CONFIG=$temporary/config.json HIVE_PLAN_DIGEST=fixture HIVE_MANIFEST=/dev/null HIVE_SIGNATURE=/dev/null HIVE_TRUST_KEY=/dev/null
    hive_render() { printf '{"services":{}}\n'; }
    hive_transfer() { :; }
    docker() { :; }
    hive_action() {
      printf '%s %s %s\n' "$1" "$2" "${HIVE_ABORT_STEP:-}" >> "$actions_log"
      [[ "$2" != "$failing" || "$1" != beta ]]
    }
    failing=$1 actions_log=$temporary/actions.log
    hive_stage
  ) > "$temporary/controller.log" 2>&1
}
jq -n '{hosts:{alpha:{target:"local"},beta:{target:"local"},gamma:{target:"local"}}}' > "$temporary/config.json"
for step in stage compatibility adapters-preflight; do
  : > "$temporary/actions.log"
  if controller "$step"; then fail "hive_stage passed a failed $step"; fi
  grep -q 'closed as aborted' "$temporary/controller.log" || { cat "$temporary/controller.log" >&2; fail "A failed $step did not report the abort"; }
  [[ $(grep -c " abort $step\$" "$temporary/actions.log") == 2 ]] && grep -q "^alpha abort $step\$" "$temporary/actions.log" && grep -q "^beta abort $step\$" "$temporary/actions.log" || { cat "$temporary/actions.log" >&2; fail "The $step abort did not reach exactly the prepared hosts"; }
  ! grep -q '^gamma' "$temporary/actions.log" || fail 'A host that was never prepared was touched'
done
: > "$temporary/actions.log"
if controller prepare; then fail 'hive_stage passed a failed prepare'; fi
! grep -q ' abort ' "$temporary/actions.log" || fail 'A failed prepare aborted a transaction'
# A native migration's staging keeps its own recovery: nothing is aborted.
: > "$temporary/actions.log"
jq '.nativeMigration={}' "$temporary/config.json" > "$temporary/native.json"; cp "$temporary/config.json" "$temporary/plain.json"; cp "$temporary/native.json" "$temporary/config.json"
if HIVE_OPERATION=install controller stage; then fail 'hive_stage passed a failed migration stage'; fi
cp "$temporary/plain.json" "$temporary/config.json"
! grep -q ' abort ' "$temporary/actions.log" || fail 'A native migration transaction was aborted'
printf 'Passed: read-only-check failures abort and keep their record, the next plan proceeds, and host changes or quiescence keep the transaction for recovery.\n'
