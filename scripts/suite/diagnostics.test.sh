#!/usr/bin/env bash
# status --json, doctor --json, logs and support-bundle: shapes, refusals and redaction.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
directory="$temporary/owned"
mkdir -p "$directory/backups/one" "$temporary/bin" "$temporary/out"
jq --arg base "$directory" '.installation="diagnostics-proof" | .hosts.control.directory=$base | .agents=[] | .console.runtimeFile=($base+"/config/runtime.json") | .components["hive-registry"]+={envFile:($base+"/config/hive-registry.env"),configDirectory:($base+"/config/hive-registry")}' "$ROOT/examples/installation.json" > "$temporary/config.json"
printf '{"installation":"diagnostics-proof","host":"control","uuid":"synthetic-installation"}' > "$directory/installation.json"
printf '{"services":{"oathweave":{"environment":{"IAM_SECRET":"must-not-be-read"}},"hivexui":{}}}' > "$directory/compose.json"
printf '{"schema":1,"plan":"%064d","phase":"committed","version":"0.1.0","operation":"upgrade"}' 1 > "$directory/transaction.json"
printf '{"schema":1,"version":"0.1.0","digest":"%064d","plan":"%064d","privateExtra":"must-not-be-returned"}' 2 1 > "$directory/receipt.json"
# Docker records every call; logs print synthetic credentials that the bundle must redact.
cat > "$temporary/bin/docker" <<DOCKER
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$temporary/docker.calls"
case "\$*" in
  *" logs "*)
    printf '2026-01-01T00:00:00Z started; password=hunter2-synthetic\n'
    printf 'Authorization: Bearer synthetic-token-value\n'
    printf 'token %s.%s.%s\n' eyJhbGciOiJIUzI1NiJ9 eyJzdWIiOiJhbGljZSJ9 c2lnbmF0dXJl
    printf 'url https://admin:synthetic-pass@db.example.com/x\n'
    printf -- '-----BEGIN %s KEY-----\nMIIsyntheticprivatekeymaterial\n-----END %s KEY-----\n' PRIVATE PRIVATE
    printf '{"client_secret": "synthetic-client-secret", "count": 3}\n'
    printf 'ordinary line kept\n';;
  *" ps "*) printf '[{"Service":"oathweave","Name":"diagnostics-proof-oathweave-1","State":"running","Health":"healthy","Labels":"x"}]\n';;
  "version --format"*) printf '27.0.0\n';;
  "compose version --short") printf '2.30.0\n';;
  "info") exit 1;;
  *) printf '[]\n';;
esac
DOCKER
chmod 700 "$temporary/bin/docker"
hive() { PATH="$temporary/bin:$PATH" "$ROOT/hive.sh" "$@" --config "$temporary/config.json"; }

# status --json: one document with every host and the pending setup items.
hive status --json > "$temporary/status.json" 2> "$temporary/status.err"
jq -e '.schema==1 and .installation=="diagnostics-proof" and (.hosts|length)==1 and .hosts[0].host=="control" and .hosts[0].containers[0].Health=="healthy" and (.setup.pending|type=="array")' "$temporary/status.json" >/dev/null || { cat "$temporary/status.json" "$temporary/status.err" >&2; fail 'status --json is not one document'; }
if hive plan --json > "$temporary/result" 2>&1; then fail '--json was accepted by plan'; fi
grep -q -- '--json applies only to status and doctor' "$temporary/result" || fail '--json misuse was not explained'

# doctor --json reports a failed preflight instead of stopping, and exits 1.
if hive doctor --json > "$temporary/doctor.json" 2> "$temporary/doctor.err"; then fail 'doctor --json passed with a failed preflight'; fi
jq -e '.schema==1 and .ok==false and .hosts[0].host=="control" and .hosts[0].preflight=="failed" and (.hosts[0].error|test("Docker is not reachable")) and (.registry|type=="object") and (.agentDependencies.checked==false)' "$temporary/doctor.json" >/dev/null || { cat "$temporary/doctor.json" "$temporary/doctor.err" >&2; fail 'doctor --json did not report the failed preflight'; }

# doctor --json with every check passing, in process.
(
  set -Eeuo pipefail
  # shellcheck source=/dev/null
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/registry.sh"; source "$ROOT/scripts/suite/magnus-agent.sh"; source "$ROOT/scripts/suite/diagnostics.sh"
  jq '.components.magnus={host:"control"}' "$temporary/config.json" > "$temporary/magnus.json"
  HIVE_ROOT=$ROOT HIVE_CONFIG=$temporary/magnus.json HIVE_ID=diagnostics-proof HIVE_REGISTRY_ORIGINAL_CONFIG=''
  hive_host() { printf 'WARNING: synthetic preflight note\n' >&2; }
  hive_registry_report() { printf '{"state":"in-sync","products":7,"drift":[],"setup":{"items":[],"pending":["synthetic-step"]}}\n'; }
  hive_magnus_ardent_dependencies() { printf '{"supported":true,"dependencies":[{"name":"hivemem","status":"ready","source":"suite"}]}\n'; }
  hive_doctor_json > "$temporary/doctor-ok.json"
  jq -e '.ok==true and .hosts==[{host:"control",preflight:"passed"}] and .registry.state=="in-sync" and .registry.setup.pending==["synthetic-step"] and .agentDependencies.checked==true and .agentDependencies.dependencies[0].name=="hivemem" and .warnings==[{host:"control",warning:"WARNING: synthetic preflight note"}]' "$temporary/doctor-ok.json" >/dev/null || { cat "$temporary/doctor-ok.json" >&2; exit 1; }
  # Drift fails doctor --json; a Magnus that does not answer is only a warning.
  hive_registry_report() { printf '{"state":"drift","products":7,"drift":[{"code":"not-running","detail":"x"}]}\n'; }
  if hive_doctor_json > "$temporary/doctor-drift.json"; then exit 2; fi
  jq -e '.ok==false and .registry.drift[0].code=="not-running" and .agentDependencies.checked==false' "$temporary/doctor-drift.json" >/dev/null || exit 3
  hive_registry_report() { printf '{"state":"in-sync","products":7,"drift":[]}\n'; }
  hive_magnus_ardent_dependencies() { printf 'Magnus refused: HTTP 503\n' >&2; return 1; }
  hive_doctor_json > "$temporary/doctor-warning.json" || exit 4
  jq -e '.ok==true and .agentDependencies.checked==false and (.agentDependencies.warning|test("HTTP 503"))' "$temporary/doctor-warning.json" >/dev/null || exit 5
  # Duration and line options.
  [[ $(hive_logs_since 7d) == 168h && $(hive_logs_since 15m) == 15m && $(hive_logs_since 2026-01-31T12:00:00Z) == 2026-01-31T12:00:00Z ]] || exit 6
  if (hive_logs_since '1h; rm -rf /') 2>/dev/null; then exit 7; fi
  if (hive_logs_tail 0 200) 2>/dev/null; then exit 8; fi
) || fail "doctor --json in process failed (status $?)"

# logs COMPONENT: the component's log from its host, with Docker's own options.
: > "$temporary/docker.calls"
hive logs oathweave > "$temporary/logs.txt"
grep -qx -- "compose -f $directory/compose.json logs --no-color --timestamps --tail 200 oathweave" "$temporary/docker.calls" || { cat "$temporary/docker.calls" >&2; fail 'logs did not read the last 200 lines'; }
grep -q 'ordinary line kept' "$temporary/logs.txt" || fail 'logs printed nothing'
: > "$temporary/docker.calls"
hive logs oathweave --since 2d > /dev/null
grep -qx -- "compose -f $directory/compose.json logs --no-color --timestamps --since 48h --tail all oathweave" "$temporary/docker.calls" || { cat "$temporary/docker.calls" >&2; fail 'logs --since did not read every line since'; }
: > "$temporary/docker.calls"
if hive logs not-configured > "$temporary/result" 2>&1; then fail 'logs read a component the installation lacks'; fi
grep -q 'has no component not-configured' "$temporary/result" || fail 'An unknown component was not explained'
if hive logs oathweave --since 'yesterday' > "$temporary/result" 2>&1; then fail 'An invalid --since was accepted'; fi
if hive logs emberpath > "$temporary/result" 2>&1; then fail 'logs read a service this host does not deploy'; fi
grep -q 'emberpath is not deployed on this host' "$temporary/result" || { cat "$temporary/result" >&2; fail 'An undeployed service was not explained'; }
! grep -q ' logs ' "$temporary/docker.calls" || fail 'A refused logs request reached Docker logs'
if hive logs oathweave --output x > "$temporary/result" 2>&1; then fail '--output was accepted by logs'; fi

# support-bundle: an owner-only archive with every report and redacted logs.
(cd "$temporary/out" && hive support-bundle --tail 50) 2> "$temporary/bundle.err"
bundle=$(find "$temporary/out" -name 'hive-support-diagnostics-proof-*.tar.gz')
[[ -n "$bundle" && $(stat -c %a "$bundle") == 600 ]] || fail 'The support bundle is missing or not owner-only'
mkdir "$temporary/extract" && tar -C "$temporary/extract" -xzf "$bundle"
root=$(find "$temporary/extract" -mindepth 1 -maxdepth 1 -type d)
for file in README.txt controller.json installation.json status.json doctor.json errors.txt hosts/control.json hosts/control-logs/oathweave.log hosts/control-logs/hivexui.log; do
  [[ -f "$root/$file" ]] || fail "The support bundle lacks $file"
done
jq -e '.ok==false' "$root/doctor.json" >/dev/null || fail 'The bundle doctor report is not JSON'
jq -e '.hosts[0].host=="control"' "$root/status.json" >/dev/null || fail 'The bundle status report is not JSON'
jq -e '.transaction.phase=="committed" and .transaction.operation=="upgrade" and .receipt.version=="0.1.0" and (.receipt|has("privateExtra")|not) and .services==["hivexui","oathweave"] and .backupDirectories==1 and .docker=="27.0.0" and .containers[0].Service=="oathweave" and (.containers[0]|has("Labels")|not)' "$root/hosts/control.json" >/dev/null || { cat "$root/hosts/control.json" >&2; fail 'The host summary is incomplete or carries private fields'; }
jq -e '(.hosts==["control"]) and (tostring|test("target|sudoPasswordFile|certificateFile")|not)' "$root/installation.json" >/dev/null || fail 'The installation summary carries SSH targets or file paths'
grep -q -- '--tail 50 oathweave' "$temporary/docker.calls" || fail 'support-bundle ignored --tail'
log=$root/hosts/control-logs/oathweave.log
for secret in hunter2-synthetic synthetic-token-value eyJhbGciOiJIUzI1NiJ9 synthetic-pass MIIsyntheticprivatekeymaterial synthetic-client-secret must-not-be-read; do
  ! grep -rq -- "$secret" "$root" || fail "The support bundle kept $secret"
done
grep -q 'ordinary line kept' "$log" && grep -q '\[REDACTED PRIVATE KEY\]' "$log" && grep -q '"count": 3' "$log" || fail 'Redaction removed ordinary log text'
grep -q 'doctor: failed' "$root/errors.txt" || fail 'errors.txt does not record the failed doctor checks'
grep -q 'support bundle written to' "$temporary/bundle.err" || fail 'support-bundle did not name its archive'
if (cd "$temporary/out" && hive support-bundle --output "$bundle") > "$temporary/result" 2>&1; then fail 'support-bundle overwrote an existing file'; fi
printf 'Passed: status and doctor JSON, logs options and refusals, and an owner-only, redacted support bundle.\n'
