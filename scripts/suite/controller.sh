#!/usr/bin/env bash

hive_die() { printf 'Hive: %s\n' "$*" >&2; exit 1; }
hive_need() { command -v "$1" >/dev/null || hive_die "Required tool missing: $1"; }
hive_usage() {
  cat <<'EOF'
Usage: hive.sh [plan|install|status|doctor|upgrade|rollback|backup|adopt|restore]
  --config FILE          Installation JSON (required for unattended use)
  --release VERSION      Override the exact release version
  --manifest FILE        Signed release manifest (default releases/VERSION.json)
  --signature FILE       Detached manifest signature (default MANIFEST.sig)
  --trust-key FILE       Publisher public key (default trust/publisher.pub)
  --non-interactive      Never prompt; fail when required input is missing
  --yes                  Apply the displayed plan without an interactive prompt
  --archive FILE         Archive for restore; must match this installation/host
  --help                 Show this help

No arguments starts interactive configuration. Planning does not contact hosts.
Secrets belong in protected environment/configuration files, never CLI arguments.
EOF
}

hive_configure() {
  [[ -t 0 ]] || hive_die 'Interactive setup requires a terminal; use --config FILE --non-interactive'
  local id directory origin profile output
  read -r -p 'Installation name: ' id
  read -r -p 'Installation directory (absolute): ' directory
  read -r -p 'Console HTTPS origin: ' origin
  read -r -p 'Profile (core/full): ' profile
  read -r -p 'Write configuration to: ' output
  [[ ! -e "$output" && ! -L "$output" ]] || hive_die 'Configuration already exists'
  jq -n --arg id "$id" --arg directory "$directory" --arg origin "$origin" --arg profile "$profile" \
    '{schema:1,installation:$id,release:"",profile:$profile,origin:$origin,hosts:{control:{target:"local",directory:$directory}},components:{},agents:[],inference:[]}' > "$output"
  chmod 600 "$output"
  printf 'Configuration written. Select an exact release and configure component environment files before install.\n'
}

hive_validate() {
  [[ -f "$HIVE_CONFIG" && ! -L "$HIVE_CONFIG" ]] || hive_die 'Configuration must be a regular file'
  jq -e '
    def id: type=="string" and test("^[a-z][a-z0-9-]{0,47}$");
    def path: type=="string" and startswith("/") and test("^/[A-Za-z0-9_./-]+$") and (split("/") | all(. != ".."));
    .schema==1 and (.installation|id) and (.profile|IN("core","full","custom")) and
    (.origin|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?$")) and
    (.hosts|type=="object" and length>0 and all(to_entries[];
      (.key|id) and (.value.directory|path) and (.value.directory|length>4) and
      (.value.target|.=="local" or test("^[a-zA-Z_][a-zA-Z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$")))) and
    (. as $c | .components|type=="object" and all(to_entries[];
      (.key|id) and ($c.hosts[.value.host] != null) and
      ((.value.envFile // "/dev/null")|path) and
      ((.value.configDirectory // "/dev/null")|path))) and
    (.agents|type=="array") and (.inference|type=="array")
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid installation configuration'
  HIVE_ID=$(jq -r '.installation' "$HIVE_CONFIG")
  HIVE_VERSION=${HIVE_VERSION:-$(jq -r '.release' "$HIVE_CONFIG")}
}

hive_manifest() {
  [[ "$HIVE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || hive_die 'An exact release version is required'
  HIVE_MANIFEST=${HIVE_MANIFEST:-$HIVE_ROOT/releases/$HIVE_VERSION.json}
  HIVE_SIGNATURE=${HIVE_SIGNATURE:-$HIVE_MANIFEST.sig}
  HIVE_TRUST_KEY=${HIVE_TRUST_KEY:-$HIVE_ROOT/trust/publisher.pub}
  [[ -f "$HIVE_MANIFEST" && -f "$HIVE_SIGNATURE" && -f "$HIVE_TRUST_KEY" ]] || hive_die 'Signed release manifest, signature and publisher key are required'
  openssl pkeyutl -verify -pubin -inkey "$HIVE_TRUST_KEY" -rawin -in "$HIVE_MANIFEST" -sigfile "$HIVE_SIGNATURE" >/dev/null 2>&1 || hive_die 'Release signature verification failed'
  jq -e --arg version "$HIVE_VERSION" '
    .schema==1 and .version==$version and
    (.components|type=="object" and length>0 and all(to_entries[];
      (.key|test("^[a-z][a-z0-9-]{0,47}$")) and
      (.value.image|test("^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$")) and
      (.value.service|type=="object") and
      (.value.service.user|type=="string" and test("^[1-9][0-9]*:[1-9][0-9]*$")) and
      (.value.service.healthcheck.test|type=="array" and length>0) and
      (.value.service|has("cap_add") or has("pid") or has("ipc") or has("uts") or has("cgroup") or has("volumes_from") or has("external_links")|not) and
      (.value.service|has("image")|not) and
      (.value.service|has("build") or has("privileged") or has("network_mode") or has("devices") or has("volumes") or has("ports") or has("env_file")|not))) and
    (.profiles.core|type=="array") and (.profiles.full|type=="array")
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'Invalid release manifest or unpinned image'
  # Reject hidden privileged mounts and unsupported release/config mismatches.
  jq -e --slurpfile config "$HIVE_CONFIG" '
    . as $r | $config[0] as $c |
    ($c.components|keys) as $selected |
    all($selected[]; $r.components[.] != null) and
    (if $c.profile=="custom" then true else all($r.profiles[$c.profile][]; . as $name | $selected|index($name)!=null) end)
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'Selected components do not match the release/profile'
  HIVE_MANIFEST_DIGEST=$(sha256sum "$HIVE_MANIFEST" | cut -d ' ' -f1)
  HIVE_PLAN_DIGEST=$( { sha256sum "$HIVE_CONFIG" | cut -d ' ' -f1; printf '%s\n' "$HIVE_MANIFEST_DIGEST"; } | sha256sum | cut -d ' ' -f1)
}

hive_plan() {
  jq --arg version "$HIVE_VERSION" --arg digest "${HIVE_MANIFEST_DIGEST:-}" '{schema,installation,release:$version,manifestDigest:$digest,profile,origin,
    hosts:(.hosts|map_values({target,directory})),
    components:(.components|map_values({host,environmentConfigured:has("envFile"),configurationMounted:has("configDirectory")})),
    agents:(.agents|map({host,runtime})),inference:(.inference|map({host,engine,backend,model,downloadBytes,license}))}' "$HIVE_CONFIG"
}

# Arguments are transported as JSON over stdin. No configuration is sourced as shell.
hive_host() {
  local host=$1 script=$2 target payload
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  payload=$(jq -c --arg host "$host" --arg installation "$HIVE_ID" --arg version "$HIVE_VERSION" --arg digest "${HIVE_MANIFEST_DIGEST:-}" --arg plan "${HIVE_PLAN_DIGEST:-}" \
    '{directory:.hosts[$host].directory,installation:$installation,version:$version,digest:$digest,plan:$plan}' "$HIVE_CONFIG")
  if [[ "$target" == local ]]; then
    printf '%s\n' "$payload" | bash -c "$script"
  else
    # The remote command is fixed. Dynamic data is base64 stdin, never shell code.
    local encoded
    encoded=$(printf '%s' "$script" | base64 -w0)
    printf '%s\n' "$payload" | ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -- "$target" "bash -c \"\$(printf '%s' '$encoded' | base64 -d)\""
  fi
}

hive_doctor() {
  local host
  while IFS= read -r host; do
    hive_host "$host" 'set -euo pipefail; read -r input; directory=$(jq -r .directory <<< "$input");
      command -v docker >/dev/null; command -v jq >/dev/null; command -v flock >/dev/null;
      docker info >/dev/null; docker compose version >/dev/null;
      case $(uname -m) in x86_64|aarch64) ;; *) exit 1;; esac;
      test -d "$directory" || test -w "$(dirname "$directory")";
      if test -e "$directory/installation.json"; then
        test "$(jq -r .installation "$directory/installation.json")" = "$(jq -r .installation <<< "$input")";
      fi' || hive_die "Host preflight failed: $host"
    printf 'Host %s: preflight passed\n' "$host"
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
}

hive_render() {
  local host=$1
  jq -n --slurpfile config "$HIVE_CONFIG" --slurpfile release "$HIVE_MANIFEST" --arg host "$host" '
    $config[0] as $c | $release[0] as $r |
    {name:($c.installation+"-"+$host),services:($c.components|to_entries|map(select(.value.host==$host)|
      .key as $name | .value as $placement |
      {key:$name,value:($r.components[$name].service + {
        image:$r.components[$name].image, restart:"unless-stopped",
        security_opt:["no-new-privileges:true"],cap_drop:["ALL"],read_only:true,init:true,stop_grace_period:"45s",tmpfs:["/tmp:mode=1777"],
        volumes:([{type:"bind",source:($c.hosts[$host].directory+"/data/"+$name),target:"/data"}] +
          (if $placement.configDirectory then [{type:"bind",source:$placement.configDirectory,target:"/config",read_only:true}] else [] end))
      } + (if $placement.envFile then {env_file:[$placement.envFile]} else {} end))})|from_entries),networks:{default:{}}}'
}

hive_transfer() {
  local host=$1 file=$2 relative=$3 target directory
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  directory=$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG")
  if [[ "$target" == local ]]; then
    install -m 600 -- "$file" "$directory/$relative"
  else
    scp -q -p -o BatchMode=yes -o StrictHostKeyChecking=yes -- "$file" "$target:$directory/$relative"
  fi
}

hive_apply() {
  local host temporary planned=${HIVE_PLAN_DIGEST:-}
  [[ $(jq '.agents|length' "$HIVE_CONFIG") == 0 && $(jq '.inference|length' "$HIVE_CONFIG") == 0 ]] || hive_die 'Agent and inference execution require certified adapters; refusing a partial installation'
  hive_manifest
  [[ -z "$planned" || "$planned" == "$HIVE_PLAN_DIGEST" ]] || hive_die 'Configuration or release changed after plan confirmation'
  hive_doctor
  temporary=$(mktemp -d)
  trap 'rm -rf -- "$temporary"' EXIT
  # Render and validate every host before activating any host.
  while IFS= read -r host; do
    hive_render "$host" > "$temporary/$host.json"
    # Remote environment files are resolved on their host, not the controller.
    jq '(.services[]|select(has("env_file"))) |= del(.env_file)' "$temporary/$host.json" > "$temporary/$host.syntax.json"
    docker compose -f "$temporary/$host.syntax.json" config --quiet || hive_die "Compose validation failed: $host"
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  while IFS= read -r host; do
    hive_host "$host" 'set -euo pipefail; read -r input; directory=$(jq -r .directory <<< "$input");
      test ! -L "$directory";
      install -d -m 700 "$directory" "$directory/releases" "$directory/data";
      if test -e "$directory/installation.json"; then
        test "$(jq -r .installation "$directory/installation.json")" = "$(jq -r .installation <<< "$input")";
      elif test -e "$directory/compose.json"; then exit 1;
      else printf "%s\n" "$input" > "$directory/installation.json"; fi' || hive_die "Could not prepare host: $host"
    hive_transfer "$host" "$temporary/$host.json" "candidate.$HIVE_PLAN_DIGEST.json"
    hive_host "$host" 'set -euo pipefail; read -r input; directory=$(jq -r .directory <<< "$input"); plan=$(jq -r .plan <<< "$input");
      docker compose -f "$directory/candidate.$plan.json" config --quiet' || hive_die "Host configuration validation failed: $host"
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  while IFS= read -r host; do
    hive_host "$host" 'set -euo pipefail; umask 077; read -r input; directory=$(jq -r .directory <<< "$input");
      plan=$(jq -r .plan <<< "$input"); candidate="$directory/candidate.$plan.json";
      exec 9>"$directory/controller.lock"; flock -n 9;
      if test -f "$directory/receipt.json"; then
        if test "$(jq -r .version "$directory/receipt.json")" = "$(jq -r .version <<< "$input")"; then
          test "$(jq -r .digest "$directory/receipt.json")" = "$(jq -r .digest <<< "$input")" || exit 1;
        else
          printf "Existing release requires a verified backup and upgrade adapter.\n" >&2; exit 1;
        fi;
      fi;
      while read -r service uid gid; do
        path="$directory/data/$service";
        test ! -L "$path";
        if test -d "$path"; then
          test "$(stat -c %u "$path")" = "$uid" && test "$(stat -c %g "$path")" = "$gid";
        else install -d -m 700 -o "$uid" -g "$gid" "$path"; fi;
      done < <(jq -r ".services|to_entries[]|[.key,(.value.user|split(\":\")[])]|@tsv" "$candidate");
      docker compose -f "$candidate" config --quiet;
      docker compose -f "$candidate" pull --quiet;
      docker compose -f "$candidate" up -d --wait --wait-timeout 180;
      mv "$candidate" "$directory/compose.json";
      printf "%s\n" "$input" > "$directory/receipt.json.tmp";
      mv "$directory/receipt.json.tmp" "$directory/receipt.json"' || hive_die "Activation failed on $host; candidate and previous receipt retained for reconciliation"
    printf 'Host %s: containers ready\n' "$host"
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  rm -rf -- "$temporary"
  trap - EXIT
}

hive_main() {
  local command=install confirmed=false interactive=true archive=''
  HIVE_CONFIG='' HIVE_VERSION='' HIVE_MANIFEST='' HIVE_SIGNATURE='' HIVE_TRUST_KEY=''
  if (($#)) && [[ "$1" != --* ]]; then command=$1; shift; fi
  while (($#)); do
    case $1 in
      --help|-h) hive_usage; return;;
      --yes) confirmed=true; shift;;
      --non-interactive) interactive=false; shift;;
      --config|--release|--manifest|--signature|--trust-key|--archive)
        (($#>=2)) && [[ -n $2 && $2 != --* ]] || hive_die "Missing value: $1"
        case $1 in
          --config) HIVE_CONFIG=$2;; --release) HIVE_VERSION=$2;; --manifest) HIVE_MANIFEST=$2;;
          --signature) HIVE_SIGNATURE=$2;; --trust-key) HIVE_TRUST_KEY=$2;; --archive) archive=$2;;
        esac; shift 2;;
      *) hive_die 'Unknown option';;
    esac
  done
  case "$command" in plan|install|status|doctor|upgrade|rollback|backup|adopt|restore) ;; *) hive_die 'Unknown command';; esac
  hive_need jq
  if [[ -z "$HIVE_CONFIG" ]]; then
    [[ "$interactive" == true ]] || hive_die '--config is required'
    hive_configure; return
  fi
  hive_validate
  case "$command" in
    plan) hive_plan; return;;
    status)
      local host
      while IFS= read -r host; do
        hive_host "$host" 'set -euo pipefail; read -r input; directory=$(jq -r .directory <<< "$input");
          test -f "$directory/installation.json";
          test "$(jq -r .installation "$directory/installation.json")" = "$(jq -r .installation <<< "$input")";
          docker compose -f "$directory/compose.json" ps --format json'
      done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG"); return;;
    doctor) hive_doctor; return;;
  esac
  if [[ "$command" == install ]]; then hive_need openssl; hive_need sha256sum; hive_manifest; fi
  hive_plan
  if [[ "$confirmed" != true ]]; then
    [[ "$interactive" == true && -t 0 ]] || hive_die 'Applying changes requires --yes or interactive confirmation'
    local answer
    read -r -p 'Apply this exact installation plan? [y/N] ' answer
    [[ "$answer" == y ]] || hive_die 'Cancelled'
  fi
  case "$command" in
    install) hive_need openssl; hive_need sha256sum; hive_apply;;
    upgrade|rollback|backup|adopt|restore) hive_die "$command requires the installation-specific recovery adapter; existing deployment tools remain authoritative";;
  esac
}
