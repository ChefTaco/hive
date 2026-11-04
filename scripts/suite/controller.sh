#!/usr/bin/env bash

hive_die() { printf 'Hive: %s\n' "$*" >&2; exit 1; }
hive_need() { command -v "$1" >/dev/null || hive_die "Required tool missing: $1"; }
hive_usage() {
  cat <<'EOF'
Usage: hive.sh [plan|install|status|doctor|upgrade|rollback|backup|adopt|restore|rehearse]
  --config FILE          Installation JSON (required for unattended use)
  --release VERSION      Override the exact release version
  --manifest FILE        Signed release manifest (default releases/VERSION.json)
  --signature FILE       Detached manifest signature (default MANIFEST.sig)
  --trust-key FILE       Publisher public key (default trust/publisher.pub)
  --non-interactive      Never prompt; fail when required input is missing
  --yes                  Apply the displayed plan without an interactive prompt
  --archive ID           Protected installation backup ID
  --allow-migrations     Execute exact signed, explicitly planned migrations
  --reconciliation FILE  Protected acknowledgement of writes before restore
  --help                 Show this help

No arguments starts interactive configuration. Planning does not contact hosts.
Secrets belong in protected environment/configuration files, never CLI arguments.
EOF
}

hive_configure() {
  [[ -t 0 ]] || hive_die 'Interactive setup requires a terminal; use --config FILE --non-interactive'
  local id directory origin profile output endpoint model credential engine inference='[]'
  read -r -p 'Installation name: ' id
  read -r -p 'Installation directory (absolute): ' directory
  read -r -p 'Console HTTPS origin: ' origin
  read -r -p 'Profile (core/full): ' profile
  printf 'Inference services are external. Hive only verifies HTTPS APIs and registers providers with Emberpath.\n'
  read -r -p 'Existing inference HTTPS endpoint (blank to skip): ' endpoint
  if [[ -n "$endpoint" ]]; then
    read -r -p 'External engine (openai/ollama/llamacpp; OpenAI-compatible API required): ' engine
    read -r -p 'Existing model identifier: ' model
    read -r -p 'Protected Authorization header file on control host (blank for no authentication): ' credential
    inference=$(jq -n --arg endpoint "$endpoint" --arg engine "$engine" --arg model "$model" --arg credential "$credential" '[{id:"external-provider",host:"control",engine:$engine,protocol:"openai",endpoint:$endpoint,model:{id:$model}} + (if $credential!="" then {authHeaderFile:$credential} else {} end)]')
  fi
  read -r -p 'Write configuration to: ' output
  [[ ! -e "$output" && ! -L "$output" ]] || hive_die 'Configuration already exists'
  jq -n --arg id "$id" --arg directory "$directory" --arg origin "$origin" --arg profile "$profile" --argjson inference "$inference" \
    '{schema:1,installation:$id,release:"",profile:$profile,origin:$origin,hosts:{control:{target:"local",directory:$directory}},components:{},agents:[],inference:$inference}' > "$output"
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
  if declare -F hive_adapter_validate >/dev/null; then hive_adapter_validate; fi
}

hive_manifest() {
  [[ "$HIVE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || hive_die 'An exact release version is required'
  HIVE_MANIFEST=${HIVE_MANIFEST:-$HIVE_ROOT/releases/$HIVE_VERSION.json}
  HIVE_SIGNATURE=${HIVE_SIGNATURE:-$HIVE_MANIFEST.sig}
  HIVE_TRUST_KEY=${HIVE_TRUST_KEY:-$HIVE_ROOT/trust/publisher.pub}
  [[ -f "$HIVE_MANIFEST" && -f "$HIVE_SIGNATURE" && -f "$HIVE_TRUST_KEY" ]] || hive_die 'Signed release manifest, signature and publisher key are required'
  openssl pkeyutl -verify -pubin -inkey "$HIVE_TRUST_KEY" -rawin -in "$HIVE_MANIFEST" -sigfile "$HIVE_SIGNATURE" >/dev/null 2>&1 || hive_die 'Release signature verification failed'
  if declare -F hive_adapter_manifest >/dev/null; then hive_adapter_manifest; fi
  jq -e --arg version "$HIVE_VERSION" '
    .schema==1 and .version==$version and
    (.components|type=="object" and length>0 and all(to_entries[];
      (.key|test("^[a-z][a-z0-9-]{0,47}$")) and
      (.value.image|test("^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$")) and
      (.value.service|type=="object" and (keys-["user","command","entrypoint","healthcheck","environment","depends_on","networks","expose","working_dir","labels","mem_limit","cpus","ulimits"]|length==0)) and
      (.value.service.user|type=="string" and test("^[1-9][0-9]*:[1-9][0-9]*$")) and
      (.value.service.healthcheck.test|type=="array" and length>0) and
      (.value.service.healthcheck.disable != true) and
      (.value.service|has("cap_add") or has("pid") or has("ipc") or has("uts") or has("cgroup") or has("volumes_from") or has("external_links")|not) and
      (.value.service|has("image")|not) and
      (.value.service|has("build") or has("privileged") or has("network_mode") or has("devices") or has("volumes") or has("ports") or has("env_file")|not))) and
    (.profiles.core|type=="array") and (.profiles.full|type=="array") and
    ((.networks // {})|type=="object" and all(.[]; .driver=="bridge" and (has("external")|not) and (keys-["driver","internal"]|length==0)))
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'Invalid release manifest or unpinned image'
  # Reject hidden privileged mounts and unsupported release/config mismatches.
  jq -e --slurpfile config "$HIVE_CONFIG" '
    . as $r | $config[0] as $c |
    ($c.components|keys) as $selected |
    all($selected[]; $r.components[.] != null) and
    all($selected[]; . as $name | all(($r.components[$name].requiresLocal // [])[]; . as $dependency | $c.components[$dependency].host==$c.components[$name].host)) and
    (if $c.profile=="custom" then true else all($r.profiles[$c.profile][]; . as $name | $selected|index($name)!=null) end)
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'Selected components do not match the release/profile'
  HIVE_MANIFEST_DIGEST=$(sha256sum "$HIVE_MANIFEST" | cut -d ' ' -f1)
  HIVE_PLAN_DIGEST=$( { sha256sum "$HIVE_CONFIG" | cut -d ' ' -f1; printf '%s\n' "$HIVE_MANIFEST_DIGEST"; } | sha256sum | cut -d ' ' -f1)
}

hive_plan() {
  jq --arg version "$HIVE_VERSION" --arg digest "${HIVE_MANIFEST_DIGEST:-}" '{schema,installation,release:$version,manifestDigest:$digest,profile,origin,
    hosts:(.hosts|map_values({target,directory})),
    components:(.components|map_values({host,environmentConfigured:has("envFile"),configurationMounted:has("configDirectory")})),
    agents:(.agents|map({host,runtime})),inference:(.inference|map({host,engine,protocol:(.protocol // "openai"),endpoint,model,credentialConfigured:has("authHeaderFile"),registrationConfigured:has("registration")}))}' "$HIVE_CONFIG"
}

# Arguments are transported as JSON over stdin. No configuration is sourced as shell.
hive_host() {
  local host=$1 script=$2 target payload
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  payload=$(jq -c --arg host "$host" --arg installation "$HIVE_ID" --arg version "$HIVE_VERSION" --arg digest "${HIVE_MANIFEST_DIGEST:-}" --arg plan "${HIVE_PLAN_DIGEST:-}" \
    --arg action "${HIVE_HOST_ACTION:-}" --arg operation "${HIVE_OPERATION:-}" --arg archive "${HIVE_ARCHIVE:-}" --argjson allowMigrations "${HIVE_ALLOW_MIGRATIONS:-false}" \
    '{directory:.hosts[$host].directory,host:$host,installation:$installation,version:$version,digest:$digest,plan:$plan,action:$action,operation:$operation,archive:$archive,allowMigrations:$allowMigrations,placements:(.components|with_entries(select(.value.host==$host))),agents:[.agents[]|select(.host==$host)],inference:[.inference[]|select(.host==$host)]}' "$HIVE_CONFIG")
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
      for tool in docker jq flock openssl tar gzip sha256sum stat find sort curl; do command -v "$tool" >/dev/null; done;
    docker info >/dev/null; docker compose version >/dev/null;
      case $(uname -m) in x86_64|aarch64) ;; *) exit 1;; esac;
      test -d "$directory" || test -w "$(dirname "$directory")";
      while IFS= read -r path; do
        test "$path" = /dev/null && continue;
        test -f "$path" && test ! -L "$path" && test -r "$path";
        permissions=$(stat -c %a "$path"); test "$((8#$permissions & 077))" = 0;
      done < <(jq -r ".placements[].envFile // \"/dev/null\"" <<< "$input");
      while IFS= read -r path; do
        test -f "$path" && test ! -L "$path" && test -r "$path";
        test "$(stat -c %u "$path")" = "$(id -u)";
        permissions=$(stat -c %a "$path"); test "$((8#$permissions & 077))" = 0;
      done < <(jq -r ".agents[].environmentFile, (.inference[]|.authHeaderFile,.caFile,.registration.credentialFile,.registration.caFile|select(.!=null))" <<< "$input");
      while IFS= read -r path; do
        test -d "$path" && test ! -L "$path";
        test -z "$(find "$path" -type l -print -quit)";
      done < <(jq -r ".placements[].configDirectory // empty" <<< "$input");
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
      } + (if $placement.envFile then {env_file:[$placement.envFile]} else {} end))})|from_entries),networks:({default:{driver:"bridge"}}+($r.networks // {}))}'
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


hive_main() {
  local command=install confirmed=false interactive=true
  HIVE_ARCHIVE='' HIVE_RECONCILIATION='' HIVE_ALLOW_MIGRATIONS=false
  HIVE_CONFIG='' HIVE_VERSION='' HIVE_MANIFEST='' HIVE_SIGNATURE='' HIVE_TRUST_KEY=''
  if (($#)) && [[ "$1" != --* ]]; then command=$1; shift; fi
  while (($#)); do
    case $1 in
      --help|-h) hive_usage; return;;
      --yes) confirmed=true; shift;;
      --allow-migrations) HIVE_ALLOW_MIGRATIONS=true; shift;;
      --non-interactive) interactive=false; shift;;
      --config|--release|--manifest|--signature|--trust-key|--archive|--reconciliation)
        (($#>=2)) && [[ -n $2 && $2 != --* ]] || hive_die "Missing value: $1"
        case $1 in
          --config) HIVE_CONFIG=$2;; --release) HIVE_VERSION=$2;; --manifest) HIVE_MANIFEST=$2;;
          --signature) HIVE_SIGNATURE=$2;; --trust-key) HIVE_TRUST_KEY=$2;; --archive) HIVE_ARCHIVE=$2;; --reconciliation) HIVE_RECONCILIATION=$2;;
        esac; shift 2;;
      *) hive_die 'Unknown option';;
    esac
  done
  case "$command" in plan|install|status|doctor|upgrade|rollback|backup|adopt|restore|rehearse) ;; *) hive_die 'Unknown command';; esac
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
  hive_need openssl; hive_need sha256sum; hive_manifest
  HIVE_OPERATION=$command
  hive_plan
  if [[ "$confirmed" != true ]]; then
    [[ "$interactive" == true && -t 0 ]] || hive_die 'Applying changes requires --yes or interactive confirmation'
    local answer
    read -r -p 'Apply this exact installation plan? [y/N] ' answer
    [[ "$answer" == y ]] || hive_die 'Cancelled'
  fi
  case "$command" in
    install|upgrade|rollback|backup|adopt|restore|rehearse) hive_lifecycle "$command";;
  esac
}
