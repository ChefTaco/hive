#!/usr/bin/env bash
# Operator diagnostics: status --json, doctor --json, logs and support-bundle. Like status and
# doctor, none changes a container, configuration or installation file.

# status --json: every host's report and the pending setup items, as one document.
hive_status_json() {
  local registry_report hosts
  registry_report=$(hive_registry_report)
  hosts=$(hive_status_hosts "$registry_report" | jq -s .)
  jq -n --arg installation "$HIVE_ID" --argjson hosts "$hosts" --argjson registry "$registry_report" \
    '{schema:1,installation:$installation,hosts:$hosts,setup:{pending:[($registry.setup.items // [])[]|select(.status=="pending")|{id,title}]}}'
}

# The last non-empty line of FILE, at most 300 characters, or empty.
hive_diagnostics_last_line() { grep -v '^[[:space:]]*$' "$1" 2>/dev/null | tail -n 1 | cut -c1-300 || true; }

# doctor --json: the checks of doctor, as one document. Unlike doctor, a failed check does not
# stop the others; "ok" is false and the exit status 1 when any check failed.
hive_doctor_json() {
  local host effective error result detail hosts='[]' registry='null' dependencies='null' report state ok=true warnings='[]'
  error=$(mktemp)
  # The configuration as written, as doctor's preflight uses it, for an installation whose
  # registry placement this run only derived.
  effective=$HIVE_CONFIG
  [[ -z "${HIVE_REGISTRY_ORIGINAL_CONFIG:-}" ]] || HIVE_CONFIG=$HIVE_REGISTRY_ORIGINAL_CONFIG
  while IFS= read -r host; do
    : > "$error"
    if (hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/public-runtime.sh" "$HIVE_ROOT/scripts/suite/preflight-host.sh")") > /dev/null 2> "$error"; then result=passed; else result=failed; ok=false; fi
    detail=$(hive_diagnostics_last_line "$error")
    hosts=$(jq -c --arg host "$host" --arg result "$result" --arg detail "$detail" \
      '.+[{host:$host,preflight:$result}+(if $result=="failed" then {error:$detail} else {} end)]' <<< "$hosts")
    # Warnings a passing preflight printed, such as an external Magnus that did not answer.
    warnings=$(jq -c --arg host "$host" --rawfile text "$error" '.+[$text|split("\n")[]|select(startswith("WARNING"))|{host:$host,warning:.}]' <<< "$warnings")
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  HIVE_CONFIG=$effective
  : > "$error"
  if report=$( (hive_registry_report) 2> "$error") && jq -e 'type=="object" and (.state|type=="string")' <<< "$report" >/dev/null 2>&1; then
    state=$(jq -r .state <<< "$report")
    registry=$(jq -c '{state,products,drift:(.drift // []),setup:(if .setup then {pending:.setup.pending} else null end)}' <<< "$report")
    case "$state" in
      in-sync) ;;
      not-active) [[ -z "${HIVE_REGISTRY_ORIGINAL_CONFIG:-}" ]] || ok=false;;
      *) ok=false;;
    esac
  else
    state=unavailable ok=false
    registry=$(jq -nc --arg detail "$(hive_diagnostics_last_line "$error")" '{state:"unavailable",error:$detail}')
  fi
  dependencies=$(HIVE_REGISTRY_STATE=$state hive_agent_dependencies_json)
  rm -f -- "$error"
  jq -n --arg installation "$HIVE_ID" --argjson ok "$ok" --argjson hosts "$hosts" --argjson registry "$registry" \
    --argjson dependencies "$dependencies" --argjson warnings "$warnings" \
    --argjson external "$(jq -c 'if .external.magnus then {magnus:{url:.external.magnus.url}} else {} end' "$HIVE_CONFIG")" \
    '{schema:1,installation:$installation,ok:$ok,hosts:$hosts,external:$external,registry:$registry,agentDependencies:$dependencies,warnings:$warnings}'
  [[ "$ok" == true ]]
}

# The agent dependencies section of doctor, as JSON: {checked:false,reason} when doctor would not
# ask, the Magnus report when it answered, or {checked:false,warning} when it did not. As in
# doctor, a Magnus that does not answer never fails the check.
hive_agent_dependencies_json() {
  local report error detail
  if [[ "${HIVE_REGISTRY_STATE:-}" != in-sync ]]; then jq -nc '{checked:false,reason:"the installation is not running in sync with its registry"}'; return; fi
  if jq -e '.components.magnus==null and .external.magnus==null' "$HIVE_CONFIG" >/dev/null; then jq -nc '{checked:false,reason:"no Magnus"}'; return; fi
  if jq -e '.components.magnus==null and .components.ardentstudio==null' "$HIVE_CONFIG" >/dev/null; then
    jq -nc '{checked:false,reason:"the external Magnus is read through Ardent Project Studio, which this installation does not run"}'; return
  fi
  error=$(mktemp)
  if report=$( (hive_magnus_ardent_dependencies) 2> "$error") && jq -e 'type=="object" and (.supported==false or (.dependencies|type=="array"))' <<< "$report" >/dev/null 2>&1; then
    jq -c '{checked:true,supported:(.supported!=false),dependencies:(.dependencies // [])}' <<< "$report"
  else
    detail=$(hive_diagnostics_last_line "$error")
    jq -nc --arg detail "${detail:-no reply}" '{checked:false,warning:("Magnus did not answer: "+$detail)}'
  fi
  rm -f -- "$error"
}

# --since: 30s, 15m, 2h, 7d (as hours) or an ISO 8601 date or time; printed as Docker takes it.
hive_logs_since() { # VALUE
  local value=$1
  if [[ "$value" =~ ^([1-9][0-9]{0,5})([smhd])$ ]]; then
    if [[ ${BASH_REMATCH[2]} == d ]]; then printf '%sh\n' "$((BASH_REMATCH[1] * 24))"; else printf '%s\n' "$value"; fi
  elif [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:[0-9]{2})?)?$ ]]; then
    printf '%s\n' "$value"
  else
    hive_die '--since takes a duration (30s, 15m, 2h, 7d) or an ISO 8601 date or time, such as 2026-01-31T12:00:00Z'
  fi
}
hive_logs_tail() { # VALUE DEFAULT
  local value=${1:-$2}
  [[ "$value" == all || "$value" =~ ^[1-9][0-9]{0,5}$ ]] || hive_die '--tail takes a positive number of lines or all'
  printf '%s\n' "$value"
}

hive_diagnostics_host() { # HOST REQUEST
  HIVE_DIAGNOSTICS_INPUT=$2 hive_host "$1" "$(cat "$HIVE_ROOT/scripts/suite/diagnostics-host.sh")"
}

# hive.sh logs COMPONENT [--since D] [--tail N|all]: the component's container log from its host,
# with timestamps. The default is the last 200 lines, or every line since --since.
hive_logs() { # COMPONENT
  local component=${1:-} host since='' tail
  (($# <= 1)) && [[ -n "$component" ]] || hive_die 'Use: logs COMPONENT [--since DURATION|TIME] [--tail N|all]'
  hive_valid_id "$component" || hive_die 'Component names use lowercase letters, digits and hyphens'
  host=$(jq -r --arg component "$component" '.components[$component].host // empty' "$HIVE_CONFIG")
  [[ -n "$host" ]] || hive_die "This installation has no component $component. Its components: $(jq -r '.components|keys|join(", ")' "$HIVE_CONFIG")"
  [[ -z "$HIVE_LOGS_SINCE" ]] || since=$(hive_logs_since "$HIVE_LOGS_SINCE")
  if [[ -n "$since" ]]; then tail=$(hive_logs_tail "$HIVE_LOGS_TAIL" all); else tail=$(hive_logs_tail "$HIVE_LOGS_TAIL" 200); fi
  hive_diagnostics_host "$host" "$(jq -nc --arg service "$component" --arg since "$since" --arg tail "$tail" '{action:"logs",service:$service,since:$since,tail:$tail}')" ||
    hive_die "The log of $component on $host could not be read"
}

# Removes credentials from diagnostic text: private key blocks, bearer and basic credentials,
# JSON Web Tokens, passwords in URLs, and the values of settings whose names say they are secret.
hive_redact() {
  sed -E \
    -e '/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,/-----END [A-Z0-9 ]*PRIVATE KEY-----/c\[REDACTED PRIVATE KEY]' \
    -e 's/(bearer|basic)([[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1\2[REDACTED]/Ig' \
    -e 's/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9_-]*)?/[REDACTED-JWT]/g' \
    -e 's#(://[^/:@[:space:]]+:)[^@/[:space:]]+@#\1[REDACTED]@#g' \
    -e 's/(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret)([A-Za-z0-9_-]*"?[[:space:]]*[:=][[:space:]]*"?)[^"[:space:],;&}]+/\1\2[REDACTED]/Ig'
}

# The same redaction for every string in a JSON document, and the whole value of a string field
# named like a secret: preflight errors, warnings, registry drift details and container fields
# are free-form text too.
hive_redact_json() {
  jq '
    def redact: gsub("-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"; "[REDACTED PRIVATE KEY]") |
      gsub("-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*$"; "[REDACTED PRIVATE KEY]") |
      gsub("(?<a>bearer|basic)(?<b>\\s+)[A-Za-z0-9._~+/=-]+"; "\(.a)\(.b)[REDACTED]"; "i") |
      gsub("eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}(\\.[A-Za-z0-9_-]*)?"; "[REDACTED-JWT]") |
      gsub("(?<a>://[^/:@\\s]+:)[^@/\\s]+@"; "\(.a)[REDACTED]@") |
      gsub("(?<a>password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret)(?<b>[A-Za-z0-9_-]*\"?\\s*[:=]\\s*\"?)[^\"\\s,;&}]+"; "\(.a)\(.b)[REDACTED]"; "i");
    walk(if type=="string" then redact
      elif type=="object" then with_entries(if (.key|test("password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key";"i")) and (.value|type=="string") then .value="[REDACTED]" else . end)
      else . end)'
}

# What the bundle keeps of the installation file: product placement and logical host names, never
# SSH targets, files or bootstrap answers.
hive_bundle_installation_summary() {
  jq '{installation,release,profile,origin,hosts:(.hosts|keys),components:(.components|map_values({host})),
    external:((.external // {})|keys),agents:[(.agents // [])[]|{id,host,runtime,version}],
    inference:[(.inference // [])[]|{id,engine,protocol}]}' "$HIVE_CONFIG"
}

# hive.sh support-bundle [--since D] [--tail N|all] [--output FILE]: an owner-only archive of the
# evidence an issue report needs. It reads only, and records every step that failed in errors.txt.
hive_support_bundle() {
  local output stamp work bundle host since='' tail request summary service
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  output=${HIVE_BUNDLE_OUTPUT:-$PWD/hive-support-$HIVE_ID-$stamp.tar.gz}
  [[ "$output" == *.tar.gz ]] || hive_die '--output must name a .tar.gz file'
  [[ ! -e "$output" && ! -L "$output" ]] || hive_die "$output already exists"
  [[ -d "$(dirname -- "$output")" && -w "$(dirname -- "$output")" ]] || hive_die "$(dirname -- "$output") is not a writable directory"
  [[ -z "$HIVE_LOGS_SINCE" ]] || since=$(hive_logs_since "$HIVE_LOGS_SINCE")
  tail=$(hive_logs_tail "$HIVE_LOGS_TAIL" 200)
  work=$(mktemp -d)
  bundle=$work/hive-support-$HIVE_ID-$stamp
  mkdir -m 700 "$bundle" "$bundle/hosts"
  : > "$bundle/errors.txt"
  # Each step runs on its own; a failed one is recorded and the bundle continues. FILTER is
  # hive_redact for text (logs) and hive_redact_json for JSON reports, whose strings carry
  # free-form errors and warnings from hosts and products.
  hive_bundle_step() { # NAME FILE FILTER COMMAND...
    local name=$1 file=$2 filter=$3 error
    shift 3
    error=$(mktemp)
    if ! ("$@") 2> "$error" | "$filter" > "$file"; then printf '%s: failed\n' "$name" >> "$bundle/errors.txt"; fi
    if [[ -s "$error" ]]; then { printf '%s:\n' "$name"; hive_redact < "$error" | sed 's/^/  /'; } >> "$bundle/errors.txt"; fi
    rm -f -- "$error"
  }
  jq -n --arg generated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg release "$(jq -r .release "$HIVE_CONFIG")" \
    --arg checkout "$( (hive_checkout_release) 2>/dev/null || true)" --arg controller "$( (hive_controller_digest) 2>/dev/null || true)" \
    --arg bash "$BASH_VERSION" --arg jq "$(jq --version 2>/dev/null || true)" \
    '{schema:1,generatedAt:$generated,installationRelease:$release,controllerRelease:$checkout,controllerSHA256:$controller,bash:$bash,jq:$jq}' > "$bundle/controller.json"
  hive_bundle_installation_summary | hive_redact_json > "$bundle/installation.json"
  hive_bundle_step status "$bundle/status.json" hive_redact_json hive_status_json
  hive_bundle_step doctor "$bundle/doctor.json" hive_redact_json hive_doctor_json
  while IFS= read -r host; do
    request=$(jq -nc '{action:"summary"}')
    hive_bundle_step "host $host" "$bundle/hosts/$host.json" hive_redact_json hive_diagnostics_host "$host" "$request"
    jq -e . "$bundle/hosts/$host.json" >/dev/null 2>&1 || continue
    mkdir -m 700 "$bundle/hosts/$host-logs"
    while IFS= read -r service; do
      request=$(jq -nc --arg service "$service" --arg since "$since" --arg tail "$tail" '{action:"logs",service:$service,since:$since,tail:$tail}')
      hive_bundle_step "log $service on $host" "$bundle/hosts/$host-logs/$service.log" hive_redact hive_diagnostics_host "$host" "$request"
    done < <(jq -r '.services[]?' "$bundle/hosts/$host.json")
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  cat > "$bundle/README.txt" <<'EOF'
Hive support bundle, written by hive.sh support-bundle. It holds the status and doctor reports,
each host's transaction and receipt phases, compose ps, and the tail of every container log.
Credentials, bearer tokens, JSON Web Tokens, passwords in URLs, private keys and the values of
settings named like passwords, secrets, tokens or keys were redacted from the logs and from every
string of the JSON reports. Redaction is pattern-based:
read every file before you share the bundle. Host names, paths, the console origin and log text
are kept. errors.txt lists every step that failed.
EOF
  summary=$(jq -r '"\(.ok)"' "$bundle/doctor.json" 2>/dev/null || printf 'unknown')
  (umask 077; tar -C "$work" -czf "$output" "$(basename -- "$bundle")")
  chmod 600 "$output"
  rm -rf -- "$work"
  printf 'Hive: support bundle written to %s (owner-only; doctor ok: %s). Review it before sharing: host names, paths and log text are kept.\n' "$output" "$summary" >&2
}
