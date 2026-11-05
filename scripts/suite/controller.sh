#!/usr/bin/env bash

hive_die() { printf 'Hive: %s\n' "$*" >&2; exit 1; }
hive_need() { command -v "$1" >/dev/null || hive_die "Required tool missing: $1"; }
hive_runtime_files() {
  printf '%s\n' LICENSE hive.sh deployment/Caddyfile \
    scripts/suite/controller.sh scripts/suite/lifecycle.sh scripts/suite/host-runtime.sh \
    scripts/suite/skills-integration.sh scripts/suite/skills-integration-host.sh scripts/suite/skills-preparation-host.sh \
    scripts/suite/adapters.sh scripts/suite/native-initialization-host.sh scripts/suite/adapters-host.sh scripts/suite/inference-registration.sh \
    scripts/suite/public-runtime.sh scripts/suite/preflight-host.sh scripts/suite/initialize.sh \
    scripts/suite/initialize-host.sh scripts/suite/initialize-full-host.sh scripts/suite/initialize-migrations-host.sh scripts/suite/integrity-host.sh scripts/suite/input-artifacts-host.sh scripts/suite/check-data.mjs
}
hive_controller_digest() {
  local file
  while IFS= read -r file; do [[ -f "$HIVE_ROOT/$file" && ! -L "$HIVE_ROOT/$file" ]] || hive_die 'Controller runtime must contain regular bundled source files'; done < <(hive_runtime_files)
  (cd "$HIVE_ROOT"; hive_runtime_files | while IFS= read -r file; do sha256sum --zero -- "$file"; done) | sha256sum | cut -d ' ' -f1
}
hive_usage() {
  cat <<'EOF'
Usage: hive.sh [init|plan|install|status|doctor|upgrade|rollback|backup|adopt|restore|rehearse|skills-prepare]
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

init prepares protected configuration for an explicitly fresh installation.
skills-prepare stages only an explicit immutable Skills client and writes protected owner proposals; it never activates mappings.
agents-accept verifies manually started agents without restarting suite services.
No arguments starts interactive configuration. Planning does not contact hosts.
Secrets belong in protected environment/configuration files, never CLI arguments.
EOF
}

hive_prompt() {
  local variable=$1 label=$2 fallback=${3:-} answer
  read -r -p "$label${fallback:+ [$fallback]}: " answer
  printf -v "$variable" '%s' "${answer:-$fallback}"
}

hive_configure() {
  [[ -t 0 ]] || hive_die 'Interactive setup requires a terminal; use --config FILE --non-interactive'
  hive_need openssl; hive_need sha256sum
  local id directory origin profile output endpoint model credential engine protocol target bind port architecture selected mode certificate private_key username email
  local inference='[]' agents='[]' temporary config selected_json runtime version agent_id agent_profile agent_environment agent_service authorized
  local external_ca enrollment_endpoint enrollment_prefix enrollment_credential enrollment_ca provider_slug provider_aliases
  local product product_host product_origin product_bind product_certificate product_key product_inference trust_bundle ssh_config magnus_console
  if [[ -z "$HIVE_VERSION" ]]; then hive_prompt HIVE_VERSION 'Exact suite release version'; fi
  if [[ -z "$HIVE_MANIFEST" ]]; then
    HIVE_MANIFEST="$HIVE_ROOT/releases/$HIVE_VERSION.json"
    [[ -f "$HIVE_MANIFEST" ]] || hive_prompt HIVE_MANIFEST 'Signed release manifest file'
  fi
  HIVE_SIGNATURE=${HIVE_SIGNATURE:-$HIVE_MANIFEST.sig}
  if [[ -z "$HIVE_TRUST_KEY" ]]; then
    HIVE_TRUST_KEY="$HIVE_ROOT/trust/publisher.pub"
    [[ -f "$HIVE_TRUST_KEY" ]] || hive_prompt HIVE_TRUST_KEY 'Publisher public trust key file'
  fi
  [[ -f "$HIVE_MANIFEST" && -f "$HIVE_SIGNATURE" && -f "$HIVE_TRUST_KEY" ]] || hive_die 'A signed release and publisher key are required before setup'
  openssl pkeyutl -verify -pubin -inkey "$HIVE_TRUST_KEY" -rawin -in "$HIVE_MANIFEST" -sigfile "$HIVE_SIGNATURE" >/dev/null 2>&1 || hive_die 'Release signature verification failed'
  jq -e --arg version "$HIVE_VERSION" '.schema==1 and .version==$version and (.components|keys|all(.[];test("^[a-z][a-z0-9-]{0,47}$")))' "$HIVE_MANIFEST" >/dev/null || hive_die 'Release metadata does not match the requested version'
  hive_prompt id 'Installation name'
  hive_prompt directory 'Installation directory on the selected host (absolute)'
  hive_prompt target 'Host SSH target (local or deploy@host)' local
  architecture=$(uname -m); case "$architecture" in x86_64) architecture=amd64;; aarch64) architecture=arm64;; esac
  hive_prompt architecture 'Host architecture (amd64/arm64)' "$architecture"
  hive_prompt origin 'Console HTTPS origin'
  hive_prompt profile 'Product profile (core/full/custom)' core
  if [[ "$profile" == custom ]]; then
    printf 'Available components: %s\n' "$(jq -r '.components|keys|join(",")' "$HIVE_MANIFEST")"
    hive_prompt selected 'Selected component names (comma-separated)'
    selected_json=$(jq -nc --arg selected "$selected" '$selected|split(",")|map(gsub("^ +| +$";""))|unique')
  else selected_json=$(jq -ce --arg profile "$profile" '.profiles[$profile]|select(type=="array" and length>0)' "$HIVE_MANIFEST") || hive_die 'Selected profile is unavailable'; fi
  selected_json=$(jq -nc --argjson selected "$selected_json" --slurpfile release "$HIVE_MANIFEST" '
    def dependencies: . as $before | ((. + [ .[] as $name|$release[0].components[$name].requiresLocal[]? ])|unique) as $after | if $after==$before then . else $after|dependencies end;
    $selected|dependencies')
  jq -e --argjson selected "$selected_json" '.components as $components|all($selected[];$components[.]!=null)' "$HIVE_MANIFEST" >/dev/null || hive_die 'Unknown selected component'
  hive_prompt bind 'HTTPS bind address' 127.0.0.1
  hive_prompt port 'HTTPS listener port' 443
  hive_prompt mode 'Configuration mode (fresh/distributed/prepared)' fresh
  if [[ "$mode" == fresh || "$mode" == distributed ]]; then
    hive_prompt username 'Initial operator username' admin
    hive_prompt email 'Initial operator email for identity recovery'
    hive_prompt certificate 'Existing console certificate file on the selected host (absolute)'
    hive_prompt private_key 'Protected console private key file on the selected host (absolute)'
  elif [[ "$mode" != prepared ]]; then hive_die 'Choose fresh, distributed or prepared configuration'; fi
  if [[ "$mode" == fresh || "$mode" == distributed ]]; then
    selected_json=$(jq -nc --argjson selected "$selected_json" '$selected+["oathweave","oathweave-redis","hivexui","ingress"]|unique')
  fi
  magnus_console=''
  if [[ "$mode" == fresh || "$mode" == distributed ]] && jq -e 'index("magnus")!=null' <<< "$selected_json" >/dev/null; then hive_prompt magnus_console 'Existing Magnus console HTTPS URL (blank to leave unconfigured)'; fi
  printf 'Inference services remain external. Hive verifies their APIs and registers providers only with an explicit Emberpath credential reference.\n'
  hive_prompt endpoint 'Existing external inference HTTPS endpoint (blank to skip)'
  if [[ -n "$endpoint" ]]; then
    hive_prompt engine 'External provider engine (openai/ollama/llamacpp)' openai
    hive_prompt protocol 'External API protocol (openai/ollama)' openai
    hive_prompt model 'Existing model identifier'
    hive_prompt credential 'Protected Authorization header file on the selected host (blank for no authentication)'
    inference=$(jq -nc --arg endpoint "$endpoint" --arg engine "$engine" --arg protocol "$protocol" --arg model "$model" --arg credential "$credential" '[{id:"external-provider",host:"control",engine:$engine,protocol:$protocol,endpoint:$endpoint,model:{id:$model}} + (if $credential!="" then {authHeaderFile:$credential} else {} end)]')
    hive_prompt external_ca 'Protected external endpoint CA file (blank for system trust)'
    if [[ -n "$external_ca" ]]; then inference=$(jq --arg ca "$external_ca" '.[0].caFile=$ca' <<< "$inference"); fi
    hive_prompt enrollment_endpoint 'Emberpath enrollment HTTPS origin (blank for verification only)'
    if [[ -n "$enrollment_endpoint" ]]; then
      hive_prompt enrollment_prefix 'Emberpath API prefix (/api or suite ingress prefix)' /api/emberpath
      hive_prompt enrollment_credential 'Protected Emberpath enrollment Authorization header file'
      hive_prompt enrollment_ca 'Protected Emberpath CA file (blank for system trust)'
      hive_prompt provider_slug 'Provider slug in Emberpath' external-provider
      hive_prompt provider_aliases 'Provider aliases (comma separated; blank for none)'
      inference=$(jq --arg endpoint "$enrollment_endpoint" --arg prefix "$enrollment_prefix" --arg credential "$enrollment_credential" --arg ca "$enrollment_ca" --arg slug "$provider_slug" --arg aliases "$provider_aliases" '.[0].registration={endpoint:$endpoint,apiPrefix:$prefix,credentialFile:$credential,providerSlug:$slug,aliases:($aliases|split(",")|map(gsub("^ +| +$";"")|select(length>0)))} | if $ca!="" then .[0].registration.caFile=$ca else . end' <<< "$inference")
    else printf 'Endpoint verification only; Emberpath registration is not selected.\n'; fi
  fi
  hive_prompt runtime 'Opt-in native agent runtime (magnus/ardent/hermes/codex; blank to skip)'
  while [[ -n "$runtime" ]]; do
    printf 'Released versions: %s\n' "$(jq -r --arg runtime "$runtime" '(.agentArtifacts[$runtime] // {})|keys|join(",")' "$HIVE_MANIFEST")"
    hive_prompt agent_id 'Unique agent installation ID' "$runtime"
    hive_prompt version 'Exact agent version'
    hive_prompt agent_profile 'Existing agent profile directory on the selected host (absolute)'
    hive_prompt agent_environment 'Protected agent environment file on the selected host (absolute)'
    hive_prompt agent_service 'Service mode (user/none)' user
    hive_prompt authorized 'Provider authorization already completed (yes/no)' no
    [[ "$authorized" == yes || "$authorized" == no ]] || hive_die 'Provider authorization state must be yes or no'
    agents=$(jq -nc --argjson agents "$agents" --arg id "$agent_id" --arg runtime "$runtime" --arg version "$version" --arg profile "$agent_profile" --arg environment "$agent_environment" --arg service "$agent_service" --arg authorized "$authorized" '$agents+[{id:$id,host:"control",runtime:$runtime,version:$version,profileDirectory:$profile,environmentFile:$environment,service:$service,authorized:($authorized=="yes")}]')
    hive_prompt runtime 'Another opt-in agent runtime (blank to finish)'
  done
  temporary=$(mktemp -d)
  config="$temporary/installation.json"
  jq -n --arg id "$id" --arg directory "$directory" --arg target "$target" --arg architecture "$architecture" --arg origin "$origin" --arg profile "$profile" --arg version "$HIVE_VERSION" --arg bind "$bind" --arg port "$port" --arg mode "$mode" --arg username "${username:-}" --arg email "${email:-}" --arg certificate "${certificate:-}" --arg key "${private_key:-}" --arg magnusConsole "${magnus_console:-}" --argjson selected "$selected_json" --argjson agents "$agents" --argjson inference "$inference" --slurpfile release "$HIVE_MANIFEST" '
    {schema:1,installation:$id,release:$version,profile:$profile,origin:$origin,hosts:{control:{target:$target,directory:$directory,architecture:$architecture}},components:($selected|map(. as $name|{key:$name,value:({host:"control"}+(if $release[0].components[$name].kind=="static-ui" then {} elif $release[0].components[$name].kind=="datastore" then {configDirectory:($directory+"/config/"+$name)} else {envFile:($directory+"/config/"+$name+".env"),configDirectory:($directory+"/config/"+$name)} end))})|from_entries),agents:$agents,inference:$inference} +
    (if ($selected|index("hivexui"))!=null or ($selected|index("ingress"))!=null then {console:{host:"control",bindAddress:$bind,httpsPort:($port|tonumber),runtimeFile:($directory+"/config/runtime.json")}} else {} end) +
    (if $mode=="fresh" or $mode=="distributed" then {bootstrap:({adminUsername:$username,adminEmail:$email,certificateFile:$certificate,privateKeyFile:$key}+(if $magnusConsole!="" then {magnusConsoleOrigin:$magnusConsole} else {} end))} else {} end)' > "$config"
  if [[ "$mode" == distributed ]]; then
    printf 'Place products within this installation. Each product keeps its private datastore on its selected host. Every host must trust the explicit HTTPS certificate bundle.\n'
    hive_prompt trust_bundle 'Product trust bundle file available on every host (absolute)'
    jq --arg trust "$trust_bundle" '.bootstrap.trustBundleFile=$trust | .bootstrap.productEndpoints={}' "$config" > "$temporary/next.json"; mv "$temporary/next.json" "$config"
    for product in oathweave emberpath hivemem hiveskills magnus cindertrace chattermost; do
      jq -e --arg name "$product" '.components[$name]!=null' "$config" >/dev/null || continue
      hive_prompt product_host "Inventory host for $product (existing or new host ID)" control
      [[ "$product_host" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || { rm -rf -- "$temporary"; hive_die 'Invalid inventory host ID'; }
      if ! jq -e --arg host "$product_host" '.hosts[$host]!=null' "$config" >/dev/null; then
        hive_prompt target "SSH target for $product_host (local or deploy@host)"
        hive_prompt directory "Installation directory on $product_host (absolute)"
        hive_prompt architecture "Architecture for $product_host (amd64/arm64)" amd64
        hive_prompt ssh_config "Protected SSH configuration for $product_host (blank for default trust)"
        jq --arg host "$product_host" --arg target "$target" --arg directory "$directory" --arg architecture "$architecture" --arg ssh "$ssh_config" '.hosts[$host]={target:$target,directory:$directory,architecture:$architecture} + (if $ssh!="" then {sshConfig:$ssh} else {} end)' "$config" > "$temporary/next.json"; mv "$temporary/next.json" "$config"
      fi
      jq --arg host "$product_host" --arg product "$product" '
        .hosts[$host].directory as $directory |
        ([$product] + (if $product=="oathweave" then ["oathweave-redis"] elif $product=="hivemem" then ["hivemem-qdrant"] elif ($product|IN("magnus","cindertrace")) then [$product+"-postgres",$product+"-redis"] elif $product=="chattermost" then ["chattermost-postgres"] else [] end)) as $names |
        reduce $names[] as $name (.; .components[$name].host=$host | .components[$name].configDirectory=($directory+"/config/"+$name) | if .components[$name].envFile then .components[$name].envFile=($directory+"/config/"+$name+".env") else . end)' "$config" > "$temporary/next.json"; mv "$temporary/next.json" "$config"
      hive_prompt product_origin "Verified HTTPS origin for $product"
      hive_prompt product_bind "HTTPS bind address for $product" 127.0.0.1
      hive_prompt product_certificate "Certificate file on the $product host (absolute)"
      hive_prompt product_key "Protected private key file on the $product host (absolute)"
      product_inference=''
      if [[ "$product" == emberpath ]]; then hive_prompt product_inference 'Distinct native model API HTTPS origin for Emberpath'; fi
      jq --arg product "$product" --arg origin "$product_origin" --arg bind "$product_bind" --arg certificate "$product_certificate" --arg key "$product_key" --arg inference "$product_inference" '.bootstrap.productEndpoints[$product]={origin:$origin,bindAddress:$bind,certificateFile:$certificate,privateKeyFile:$key} + (if $product=="emberpath" then {inferenceOrigin:$inference} else {} end)' "$config" > "$temporary/next.json"; mv "$temporary/next.json" "$config"
    done
  fi
  HIVE_CONFIG=$config
  if ! (hive_validate; hive_manifest); then rm -rf -- "$temporary"; hive_die 'Setup values do not match the release; no configuration or host changes were applied'; fi
  hive_prompt output 'Write protected installation configuration to' "${XDG_CONFIG_HOME:-${HOME:-$PWD}/.config}/hive/$id/installation.json"
  [[ ! -e "$output" && ! -L "$output" ]] || { rm -rf -- "$temporary"; hive_die 'Configuration already exists; it will not be overwritten'; }
  if [[ ! -d $(dirname "$output") ]]; then install -d -m 700 "$(dirname "$output")"; fi
  (set -o noclobber; cat "$config" > "$output") || { rm -rf -- "$temporary"; hive_die 'Could not create configuration'; }
  chmod 600 "$output"
  rm -rf -- "$temporary"
  HIVE_CONFIG=$output
  printf 'Configuration written. The same file supports unattended installation; provider login remains an explicit operator step.\n'
}

hive_validate() {
  [[ -f "$HIVE_CONFIG" && ! -L "$HIVE_CONFIG" ]] || hive_die 'Configuration must be a regular file'
  if declare -F hive_external_inference_config >/dev/null; then hive_external_inference_config; fi
  jq -e '
    def id: type=="string" and test("^[a-z][a-z0-9-]{0,47}$");
    def path: type=="string" and startswith("/") and test("^/[A-Za-z0-9_./-]+$") and (split("/") | all(. != ".."));
    (keys-["schema","installation","release","configurationRevision","profile","origin","hosts","components","console","bootstrap","agents","inference","skillsDeployment"]|length==0) and
    ((.configurationRevision // "1")|type=="string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")) and
    .schema==1 and (.installation|id) and (.profile|IN("core","full","custom")) and
    (.origin|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?$")) and
    (.hosts|type=="object" and length>0 and all(to_entries[];
      (.key|id) and (.value.directory|path) and (.value.directory|length>4) and
      (.value|keys-["target","directory","architecture","minimumFreeMiB","sshConfig"]|length==0) and
      ((.value.sshConfig // "/dev/null")|path) and
      ((.value.architecture // "amd64")|IN("amd64","arm64")) and
      ((.value.minimumFreeMiB // 2048)|type=="number" and floor==. and .>=0) and
      (.value.target|.=="local" or test("^[a-zA-Z_][a-zA-Z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$")))) and
    (. as $c | .components|type=="object" and all(to_entries[];
      (.key|id) and ($c.hosts[.value.host] != null) and
      (.value|keys-["host","envFile","configDirectory"]|length==0) and
      ((.value.envFile // "/dev/null")|path) and
      ((.value.configDirectory // "/dev/null")|path))) and
    (.agents|type=="array") and (.inference|type=="array")
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid installation configuration'
  HIVE_ID=$(jq -r '.installation' "$HIVE_CONFIG")
  HIVE_VERSION=${HIVE_VERSION:-$(jq -r '.release' "$HIVE_CONFIG")}
  if jq -e 'has("bootstrap")' "$HIVE_CONFIG" >/dev/null; then
    jq -e '
      def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
      .bootstrap|type=="object" and (keys-["adminUsername","adminEmail","certificateFile","privateKeyFile","productEndpoints","trustBundleFile","magnusConsoleOrigin"]|length==0) and
      (.adminUsername|type=="string" and test("^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$")) and
      (.adminEmail|type=="string" and length<=254 and test("^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$")) and
      (.certificateFile|path) and (.privateKeyFile|path) and
      (if has("magnusConsoleOrigin") then .magnusConsoleOrigin|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[-A-Za-z0-9._~]+)*$") else true end)
    ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid fresh-install bootstrap configuration; provide initial operator labels and protected console certificate/key references'
    if declare -F hive_bootstrap_validate >/dev/null; then hive_bootstrap_validate; fi
  fi
  if jq -e 'has("console")' "$HIVE_CONFIG" >/dev/null; then
    jq -e '
      def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
      . as $c | .console as $ui |
      ($ui|type=="object" and (keys-["host","bindAddress","httpsPort","runtimeFile"]|length==0)) and
      ($c.hosts[$ui.host]!=null) and $c.components.hivexui.host==$ui.host and $c.components.ingress.host==$ui.host and
      ($c.components.hivexui|has("envFile") or has("configDirectory")|not) and
      ($c.components.ingress.envFile|path) and ($c.components.ingress.configDirectory|path) and
      ($ui.runtimeFile|path) and ($ui.runtimeFile|startswith($c.hosts[$ui.host].directory+"/config/")) and
      ($ui.httpsPort|type=="number" and floor==. and .>=1 and .<=65535) and
      ($ui.bindAddress|type=="string" and
        (.=="::" or .=="::1" or (split(".")|length==4 and all(.[];test("^[0-9]{1,3}$") and (tonumber<=255)))))
    ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid console placement: co-locate ingress and HiveXUI, supply an explicit listener and a public runtime file inside the protected installation config tree; HiveXUI cannot receive an environment file or backend configuration'
  fi
  if declare -F hive_skills_validate >/dev/null; then hive_skills_validate; fi
  if declare -F hive_adapter_validate >/dev/null; then hive_adapter_validate; fi
}

hive_manifest() {
  [[ "$HIVE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || hive_die 'An exact release version is required'
  HIVE_MANIFEST=${HIVE_MANIFEST:-$HIVE_ROOT/releases/$HIVE_VERSION.json}
  HIVE_SIGNATURE=${HIVE_SIGNATURE:-$HIVE_MANIFEST.sig}
  HIVE_TRUST_KEY=${HIVE_TRUST_KEY:-$HIVE_ROOT/trust/publisher.pub}
  [[ -f "$HIVE_MANIFEST" && -f "$HIVE_SIGNATURE" && -f "$HIVE_TRUST_KEY" ]] || hive_die 'Signed release manifest, signature and publisher key are required'
  openssl pkeyutl -verify -pubin -inkey "$HIVE_TRUST_KEY" -rawin -in "$HIVE_MANIFEST" -sigfile "$HIVE_SIGNATURE" >/dev/null 2>&1 || hive_die 'Release signature verification failed'
  if declare -F hive_skills_manifest >/dev/null; then hive_skills_manifest; fi
  if declare -F hive_adapter_manifest >/dev/null; then hive_adapter_manifest; fi
  jq -e --arg version "$HIVE_VERSION" '
    .schema==1 and .version==$version and
    (.components|type=="object" and length>0 and all(to_entries[];
      (.key|test("^[a-z][a-z0-9-]{0,47}$")) and
      ((.value.kind // "application")|IN("application","datastore","static-ui","ingress")) and
      (if .value.kind=="static-ui" then .key=="hivexui" and ((.value.service.environment // {})|length==0) else true end) and
      (if .value.kind=="ingress" then .key=="ingress" else true end) and
      (.value.image|test("^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$")) and
      (.value.service|type=="object" and (keys-["user","command","entrypoint","healthcheck","environment","depends_on","networks","expose","working_dir","labels","mem_limit","cpus","ulimits","tmpfs"]|length==0)) and
      ((.value.service.environment // {})|type=="object" and all(to_entries[];(.key|test("^[A-Z][A-Z0-9_]*$")) and (.value|type=="string"))) and
      (.value.service.user|type=="string" and test("^[1-9][0-9]*:[1-9][0-9]*$")) and
      (.value.service.healthcheck.test|type=="array" and length>0) and
      (.value.service.healthcheck.disable != true) and
      ((.value.service.tmpfs // [])|type=="array" and length<=8 and (unique|length)==length and all(.[];type=="string" and length<=256 and test("^/(var/)?run/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$"))) and
      (if .value.initialization!=null then .value.initialization|
        type=="object" and (keys-["image","command","entrypoint","verificationCommand","workingDirectory"]|length==0) and
        (.image|test("^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$")) and
        all([.command,.verificationCommand][];type=="array" and length>0 and all(.[];type=="string" and length>0 and (contains("\u0000")|not))) and
        (if has("entrypoint") then .entrypoint|type=="array" and length>0 and all(.[];type=="string" and length>0) else true end) and
        (if has("workingDirectory") then .workingDirectory|type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!="..")) else true end)
       else true end) and
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
    (if $c.console then $r.components.hivexui.kind=="static-ui" and $r.components.ingress.kind=="ingress" else all($selected[]; ($r.components[.].kind // "application")|IN("application","datastore")) end) and
    all($selected[]; $r.components[.] != null) and
    all($selected[]; . as $name | all(($r.components[$name].requiresLocal // [])[]; . as $dependency | $c.components[$dependency].host==$c.components[$name].host)) and
    (if $c.profile=="custom" then true else all($r.profiles[$c.profile][]; . as $name | $selected|index($name)!=null) end)
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'Selected components do not match the release/profile'
  HIVE_MANIFEST_DIGEST=$(sha256sum "$HIVE_MANIFEST" | cut -d ' ' -f1)
  HIVE_CONTROLLER_DIGEST=$(hive_controller_digest)
  HIVE_RELEASE_SUMMARY=$(jq -c --slurpfile config "$HIVE_CONFIG" '.components|with_entries(select(.key as $name|$config[0].components[$name]!=null))|map_values({image,productVersion:.version,storageFormat}|with_entries(select(.value!=null)))' "$HIVE_MANIFEST")
  if jq -e 'has("controllerSHA256")' "$HIVE_MANIFEST" >/dev/null; then
    [[ $(jq -er .controllerSHA256 "$HIVE_MANIFEST") == "$HIVE_CONTROLLER_DIGEST" ]] || hive_die 'Signed release requires different controller source; use its original verified installer bundle'
  fi
  HIVE_PLAN_DIGEST=$( { sha256sum "$HIVE_CONFIG" | cut -d ' ' -f1; printf '%s\n' "$HIVE_MANIFEST_DIGEST" "$HIVE_CONTROLLER_DIGEST"; } | sha256sum | cut -d ' ' -f1)
}

hive_plan() {
  local released=${HIVE_RELEASE_SUMMARY:-'{}'}
  jq --arg version "$HIVE_VERSION" --arg digest "${HIVE_MANIFEST_DIGEST:-}" --arg controller "${HIVE_CONTROLLER_DIGEST:-}" --argjson released "$released" '{schema,installation,release:$version,configurationRevision:(.configurationRevision // "1"),manifestDigest:$digest,controllerSourceSHA256:$controller,profile,origin,
    hosts:(.hosts|map_values({target,directory})),
    console:(if .console then {host:.console.host,bindAddress:.console.bindAddress,httpsPort:.console.httpsPort,publicRuntimeConfigured:true} else null end),
    components:(.components|with_entries(.key as $name|.value=({host:.value.host,environmentConfigured:(.value|has("envFile")),configurationMounted:(.value|has("configDirectory"))}+($released[$name] // {})))),
    productEndpoints:((.bootstrap.productEndpoints // {})|map_values({origin,inferenceOrigin,bindAddress,certificateConfigured:true}|with_entries(select(.value!=null)))),
    agents:(.agents|map({host,runtime})),inference:(.inference|map({host,engine,protocol:(.protocol // "openai"),endpoint,model,credentialConfigured:has("authHeaderFile"),registrationConfigured:has("registration")}))}' "$HIVE_CONFIG"
}

# Arguments are transported as JSON over stdin. No configuration is sourced as shell.
hive_host() {
  local host=$1 script=$2 target payload bootstrap_users
  local -a ssh_options
  hive_ssh_options "$host"
  bootstrap_users=${HIVE_BOOTSTRAP_USERS:-'{}'}
  local bootstrap_images=${HIVE_BOOTSTRAP_IMAGES:-'{}'}
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  payload=$(jq -c --arg host "$host" --arg installation "$HIVE_ID" --arg version "$HIVE_VERSION" --arg digest "${HIVE_MANIFEST_DIGEST:-}" --arg plan "${HIVE_PLAN_DIGEST:-}" \
    --arg action "${HIVE_HOST_ACTION:-}" --arg operation "${HIVE_OPERATION:-}" --arg archive "${HIVE_ARCHIVE:-}" --argjson allowMigrations "${HIVE_ALLOW_MIGRATIONS:-false}" \
    --argjson serviceUsers "$bootstrap_users" --argjson images "$bootstrap_images" --argjson identityIds "${HIVE_BOOTSTRAP_IDENTITIES:-null}" --arg ingressTemplate "${HIVE_BOOTSTRAP_INGRESS:-}" --arg integrityScript "$(base64 -w0 "$HIVE_ROOT/scripts/suite/check-data.mjs")" \
    --arg skillsManifest "${HIVE_SKILLS_MANIFEST:-}" --arg skillsSignature "${HIVE_SKILLS_SIGNATURE:-}" --arg skillsTrust "${HIVE_SKILLS_TRUST:-}" --arg skillsTokenSHA "${HIVE_SKILLS_TOKEN_SHA:-}" \
    --arg controller "${HIVE_CONTROLLER_DIGEST:-}" --arg controllerArchive "${HIVE_CONTROLLER_ARCHIVE_DIGEST:-}" \
    '{directory:.hosts[$host].directory,minimumFreeMiB:(.hosts[$host].minimumFreeMiB // 2048),origin,host:$host,installation:$installation,version:$version,digest:$digest,plan:$plan,controllerSourceSHA256:$controller,controllerArchiveSHA256:$controllerArchive,action:$action,operation:$operation,archive:$archive,allowMigrations:$allowMigrations,placements:(.components|with_entries(select(.value.host==$host))),console:(if .console.host==$host then .console else null end),bootstrap:(.bootstrap // null),bootstrapImages:$images,bootstrapIdentityIds:$identityIds,bootstrapServiceUsers:$serviceUsers,ingressTemplate:$ingressTemplate,integrityScript:$integrityScript,skillsDeployment:(.skillsDeployment // null),skillsRelease:{manifest:$skillsManifest,signature:$skillsSignature,trust:$skillsTrust},skillsTokenSHA256:$skillsTokenSHA,agents:[.agents[]|select(.host==$host)],inference:[.inference[]|select(.host==$host)]}' "$HIVE_CONFIG")
  if [[ "$target" == local ]]; then
    printf '%s\n' "$payload" | bash -c "$script"
  else
    # The remote command is fixed. Dynamic data is base64 stdin, never shell code.
    local encoded
    encoded=$(printf '%s' "$script" | base64 -w0)
    printf '%s\n' "$payload" | ssh "${ssh_options[@]}" -- "$target" "bash -c \"\$(printf '%s' '$encoded' | base64 -d)\""
  fi
}

hive_ssh_options() {
  local host=$1 configuration permissions
  ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
  configuration=$(jq -r --arg host "$host" '.hosts[$host].sshConfig // empty' "$HIVE_CONFIG")
  if [[ -n "$configuration" ]]; then
    [[ -f "$configuration" && ! -L "$configuration" && -r "$configuration" && $(stat -c %u "$configuration") == "$(id -u)" ]] || hive_die 'SSH configuration must be an operator-owned regular file'
    permissions=$(stat -c %a "$configuration"); (( (8#$permissions & 077)==0 )) || hive_die 'SSH configuration must be owner-only'
    ssh_options=(-F "$configuration" "${ssh_options[@]}")
  fi
}

hive_doctor() {
  local host
  while IFS= read -r host; do
    hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/public-runtime.sh" "$HIVE_ROOT/scripts/suite/preflight-host.sh")" || hive_die "Host preflight failed: $host"
    printf 'Host %s: preflight passed\n' "$host"
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
}

hive_render() {
  local host=$1
  jq -n --slurpfile config "$HIVE_CONFIG" --slurpfile release "$HIVE_MANIFEST" --arg host "$host" '
    $config[0] as $c | $release[0] as $r |
    {name:($c.installation+"-"+$host),services:($c.components|to_entries|map(select(.value.host==$host)|
      .key as $name | .value as $placement |
      ($r.components[$name].kind // "application") as $kind |
      {key:$name,value:($r.components[$name].service + {
        image:$r.components[$name].image, restart:"unless-stopped",
        security_opt:["no-new-privileges:true"],cap_drop:["ALL"],read_only:true,init:true,stop_grace_period:"45s",tmpfs:(["/tmp:mode=1777"] + (($r.components[$name].service.tmpfs // []) | map(. as $path | ($r.components[$name].service.user|split(":")) as $owner | $path+":uid="+$owner[0]+",gid="+$owner[1]+",mode=700")) + (if $kind=="static-ui" then ($r.components[$name].service.user|split(":")) as $user | ["/var/cache/nginx:uid="+$user[0]+",gid="+$user[1]+",mode=700","/var/run:uid="+$user[0]+",gid="+$user[1]+",mode=700"] else [] end)),
        volumes:((if $kind=="static-ui" then [{type:"bind",source:$c.console.runtimeFile,target:"/usr/share/nginx/html/runtime.json",read_only:true}] else [{type:"bind",source:($c.hosts[$host].directory+"/data/"+$name),target:"/data"}] end) +
          (if $placement.configDirectory then [{type:"bind",source:$placement.configDirectory,target:"/config",read_only:true}] else [] end))
      } + (if $placement.envFile then {env_file:[$placement.envFile]} else {} end) +
        (if $kind=="application" then {environment:(($r.components[$name].service.environment // {})+{HIVE_AUTO_MIGRATE:"false",HIVE_AUTO_UPGRADE:"false",HIVE_UPDATE_CHECK:"false",HIVE_UI_UPGRADE:"false"} + (if $name=="magnus" then {MAGNUS_AUTO_MIGRATE:"false"} else {} end))} else {} end) +
        (if $kind=="ingress" then {ports:[{target:8443,published:($c.console.httpsPort|tostring),host_ip:$c.console.bindAddress,protocol:"tcp"}]}
         elif $c.bootstrap.productEndpoints[$name] then $c.bootstrap.productEndpoints[$name] as $endpoint |
          {ports:([{target:({oathweave:4200,emberpath:9443,hivemem:18790,hiveskills:4030,magnus:4000,cindertrace:4101,chattermost:8065}[$name]),published:($endpoint.origin|capture("^https://[^:]+(?::(?<port>[0-9]+))?$")|.port // "443"),host_ip:$endpoint.bindAddress,protocol:"tcp"}] +
            (if $name=="emberpath" then [{target:4020,published:($endpoint.inferenceOrigin|capture("^https://[^:]+(?::(?<port>[0-9]+))?$")|.port // "443"),host_ip:$endpoint.bindAddress,protocol:"tcp"}] else [] end))}
         else {} end))})|from_entries),networks:({default:{driver:"bridge"}}+($r.networks // {}))}'
}

hive_transfer() {
  local host=$1 file=$2 relative=$3 target directory
  local -a ssh_options
  hive_ssh_options "$host"
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  directory=$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG")
  if [[ "$target" == local ]]; then
    install -m 600 -- "$file" "$directory/$relative"
  else
    scp -q -p "${ssh_options[@]}" -- "$file" "$target:$directory/$relative"
  fi
}


hive_main() {
  local command=install confirmed=false interactive=true
  HIVE_ARCHIVE='' HIVE_RECONCILIATION='' HIVE_ALLOW_MIGRATIONS=false
  HIVE_CONFIG='' HIVE_VERSION='' HIVE_MANIFEST='' HIVE_SIGNATURE='' HIVE_TRUST_KEY=''
  HIVE_CONTROLLER_DIGEST='' HIVE_CONTROLLER_ARCHIVE_DIGEST=''
  HIVE_RELEASE_SUMMARY=''
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
  case "$command" in init|plan|install|status|doctor|upgrade|rollback|backup|adopt|restore|rehearse|agents-accept|skills-prepare) ;; *) hive_die 'Unknown command';; esac
  hive_need jq
  if [[ -z "$HIVE_CONFIG" ]]; then
    [[ "$interactive" == true ]] || hive_die '--config is required'
    hive_configure
  fi
  hive_validate
  case "$command" in
    plan)
      if [[ -n "$HIVE_MANIFEST" || -n "$HIVE_SIGNATURE" || -n "$HIVE_TRUST_KEY" ]]; then hive_need openssl; hive_need sha256sum; hive_manifest; fi
      hive_plan; return;;
    status)
      local host
      while IFS= read -r host; do
        hive_host "$host" 'set -euo pipefail; read -r input; directory=$(jq -r .directory <<< "$input");
          test -f "$directory/installation.json";
          test "$(jq -r .installation "$directory/installation.json")" = "$(jq -r .installation <<< "$input")";
          test "$(jq -r .host "$directory/installation.json")" = "$(jq -r .host <<< "$input")";
          containers=$(docker compose -f "$directory/compose.json" ps --format json | jq -s flatten);
          agents=$(while IFS= read -r id; do
            receipt="$directory/agents/$id/receipt.json";
            service=$(jq -r --arg id "$id" ".agents[]|select(.id==\$id)|.service" <<< "$input");
            service_state=manual;
            if [[ "$service" == user ]]; then
              service_state=unavailable;
              unit="hive-$(jq -r .installation <<< "$input")-$id.service";
              if command -v systemctl >/dev/null 2>&1; then
                posture=$(systemctl --user show "$unit" --property=LoadState --property=ActiveState 2>/dev/null) || posture="";
                if [[ "$posture" == *"LoadState=loaded"* ]]; then
                  case "$posture" in *"ActiveState=active"*) service_state=active;; *"ActiveState=inactive"*|*"ActiveState=deactivating"*) service_state=inactive;; *"ActiveState=failed"*) service_state=failed;; esac;
                fi;
              fi;
            fi;
            if [[ -f "$receipt" && ! -L "$receipt" ]]; then jq --arg id "$id" --arg serviceState "$service_state" "{id:\$id,runtime,version,installed:(.installed // false),preflightPassed:(.preflightPassed // false),accepted:(.accepted // false),operatorAuthorized:(.operatorAuthorized // false),acceptedAt,serviceState:\$serviceState}" "$receipt";
            else jq -n --arg id "$id" --arg serviceState "$service_state" "{id:\$id,installed:false,accepted:false,serviceState:\$serviceState}"; fi;
          done < <(jq -r ".agents[].id" <<< "$input") | jq -s .);
          jq -n --arg host "$(jq -r .host <<< "$input")" --argjson containers "$containers" --argjson agents "$agents" "{schema:1,host:\$host,containers:\$containers,nativeAgents:\$agents}"'
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
    skills-prepare) hive_skills_prepare;;
    init) hive_initialize;;
    install|upgrade|rollback|backup|adopt|restore|rehearse|agents-accept) hive_lifecycle "$command";;
  esac
}
