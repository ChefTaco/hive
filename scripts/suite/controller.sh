#!/usr/bin/env bash

hive_die() { printf 'Hive: %s\n' "$*" >&2; exit 1; }
hive_need() { command -v "$1" >/dev/null || hive_die "Required tool missing: $1"; }
hive_runtime_files() {
  printf '%s\n' LICENSE hive.sh deployment/Caddyfile \
    scripts/suite/controller.sh scripts/suite/lifecycle.sh scripts/suite/host-runtime.sh \
    scripts/suite/skills-integration.sh scripts/suite/skills-integration-host.sh scripts/suite/skills-preparation-host.sh \
    scripts/suite/adapters.sh scripts/suite/native-initialization-host.sh scripts/suite/adapters-host.sh scripts/suite/inference-registration.sh \
    scripts/suite/public-runtime.sh scripts/suite/preflight-host.sh scripts/suite/initialize.sh \
    scripts/suite/initialize-host.sh scripts/suite/initialize-full-host.sh scripts/suite/initialize-migrations-host.sh scripts/suite/integrity-host.sh scripts/suite/input-artifacts-host.sh scripts/suite/check-data.mjs \
    scripts/suite/snapshot-host.sh scripts/suite/snapshot-data.mjs \
    scripts/suite/registry.sh scripts/suite/registry-host.sh \
    scripts/suite/memory-credential.sh scripts/suite/memory-credential-host.sh \
    scripts/suite/magnus-gateway.sh scripts/suite/magnus-gateway-host.sh \
    scripts/suite/migrate-native.sh scripts/suite/migrate-native-host.sh scripts/suite/migrate-native-data.mjs scripts/suite/set-admin-password.sh \
    scripts/suite/cindertrace.sh scripts/suite/cindertrace-host.sh
}
hive_controller_digest() {
  local file
  while IFS= read -r file; do [[ -f "$HIVE_ROOT/$file" && ! -L "$HIVE_ROOT/$file" ]] || hive_die 'Controller runtime must contain regular bundled source files'; done < <(hive_runtime_files)
  (cd "$HIVE_ROOT"; hive_runtime_files | while IFS= read -r file; do sha256sum --zero -- "$file"; done) | sha256sum | cut -d ' ' -f1
}
# The one signed release in releases/ that pins exactly this controller source, if any.
hive_checkout_release() {
  local digest file versions=()
  digest=$(hive_controller_digest)
  for file in "$HIVE_ROOT"/releases/*.json; do
    [[ -f "$file" ]] || continue
    if jq -e --arg digest "$digest" '.controllerSHA256==$digest' "$file" >/dev/null 2>&1; then versions+=("$(jq -r .version "$file")"); fi
  done
  if ((${#versions[@]} == 1)); then printf '%s\n' "${versions[0]}"; fi
}
# The release a command uses when --release is not given. The installation file records the
# release it was set up with, and an upgrade does not rewrite that file. When it names a release
# this controller cannot use, a checkout's own signed release is the default, so backup,
# upgrade and rollback work from the checkout of the release now installed. A given --manifest
# names its own version. The choice is reported; the file is never changed.
hive_default_release() {
  local configured own manifest
  configured=$(jq -r '.release' "$HIVE_CONFIG")
  if [[ -n "${HIVE_MANIFEST:-}" ]]; then
    manifest=$(jq -r '.version // empty' "$HIVE_MANIFEST" 2>/dev/null || true)
    if [[ -n "$manifest" && "$manifest" != "$configured" ]]; then
      printf 'Hive: using release %s from %s; the installation file names %s\n' "$manifest" "$HIVE_MANIFEST" "$configured" >&2
      printf '%s\n' "$manifest"; return
    fi
    printf '%s\n' "$configured"; return
  fi
  # Outside a complete checkout there is no own release, and the file's release stands.
  own=$( (hive_checkout_release) 2>/dev/null ) || own=''
  if [[ -n "$own" && "$own" != "$configured" ]] && ! jq -e --arg digest "$( (hive_controller_digest) 2>/dev/null || true)" '.controllerSHA256==$digest' "${HIVE_ROOT:-}/releases/$configured.json" >/dev/null 2>&1; then
    printf 'Hive: using release %s, which this checkout'"'"'s controller installs; the installation file names %s. Pass --release to choose another\n' "$own" "$configured" >&2
    printf '%s\n' "$own"; return
  fi
  printf '%s\n' "$configured"
}
# After interactive setup and before the plan of an install or init: reach every SSH host and
# check its installation directory. Planning alone never contacts a host.
hive_setup_hosts_ready() {
  local remote
  # hive_validate sets it for every other command; the transport payload names the installation.
  HIVE_ID=$(jq -r .installation "$HIVE_CONFIG")
  while IFS= read -r remote; do
    if ! hive_host "$remote" "$(declare -f hive_writable_directory)"'
      set -euo pipefail; read -r input; directory=$(jq -r .directory <<< "$input")
      hive_writable_directory "$directory" || { printf "%s on %s cannot be created or written by %s. Create it there first: sudo install -d -m 0750 -o %s -g %s %s\n" "$directory" "$(hostname)" "$(id -un)" "$(id -un)" "$(id -gn)" "$directory" >&2; exit 1; }'; then
      hive_die "Host $remote is not ready: see above. If SSH failed, make this work without a prompt first: ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $(jq -r --arg host "$remote" '.hosts[$host].target' "$HIVE_CONFIG") true. Then continue with: ./hive.sh install --config $HIVE_CONFIG --release $HIVE_VERSION"
    fi
  done < <(jq -r '.hosts|to_entries[]|select(.value.target!="local")|.key' "$HIVE_CONFIG")
}

hive_usage() {
  cat <<'EOF'
Usage: hive.sh [init|plan|install|status|doctor|upgrade|rollback|backup|adopt|restore|rehearse|skills-prepare|registry|magnus-trust|migrate-native|tls-refresh|cindertrace-collector]
  --config FILE          Installation JSON (required for unattended use)
  --release VERSION      Override the exact release version
  --manifest FILE        Signed release manifest (default releases/VERSION.json)
  --signature FILE       Detached manifest signature (default MANIFEST.sig)
  --trust-key FILE       Publisher public key (default trust/publisher.pub)
  --non-interactive      Never prompt; fail when required input is missing
  --yes                  Apply the displayed plan without an interactive prompt
  --archive ID           Protected installation backup ID
  --stopped              backup only: stop every service while the archive is written, instead
                         of the default online backup that keeps the suite serving
  --allow-migrations     Execute exact signed, explicitly planned migrations
  --relax-auth-limits    Testing only (plan, install, upgrade): greatly relax sign-in and
                         password attempt limits in Oathweave, Cindertrace and ChatterMost.
                         Part of the plan digest; omitting it on a later upgrade restores
                         normal limits. plan and status report the state as authLimits.
  --reconciliation FILE  Protected acknowledgement of writes before restore
  --file FILE            Entry for registry add/update; entries never contain credentials
  --help                 Show this help

init prepares protected configuration for an explicitly fresh installation.
cindertrace-collector provisions the credential a Cindertrace collector signs events with:
cindertrace-collector add ID --sources SOURCE[,SOURCE]|list|remove ID. The credential is generated
on the Cindertrace host into an owner-only file and never printed; Cindertrace ingests while a
collector exists. See deployment/FULL.md.
tls-refresh installs a renewed console certificate into a fresh installation: it checks the files at
bootstrap.certificateFile and privateKeyFile, copies them into the ingress, records them and
restarts only the ingress. Without --release it uses this checkout's own release. A migrated
installation uses migrate-native tls-refresh.
skills-prepare stages only an explicit immutable Skills client and writes protected owner proposals; it never activates mappings.
agents-accept verifies manually started agents without restarting suite services.
registry looks up and edits this installation's Hive Registry (the install catalog; HiveSkills
is the separate skills registry): registry list|installed|summary|history|get ID|connection ID|
add ID --file F|update ID --file F|remove ID. The installer records release products itself.
magnus-trust approves SSH host keys for the optional Magnus fleet gateway, with a fingerprint read
on the node itself: magnus-trust list|scan|add|rotate|extra|remove. See deployment/FULL.md.
migrate-native moves one existing native (systemd) installation onto the suite on the same
ports: migrate-native plan|prepare|cutover|verify|rollback|status|issue-admin-token|
set-admin-password|tls-refresh. plan reads only, prepare stops nothing, and cutover and rollback
act only when named. --hold-on-failure keeps a failed cutover running for inspection.
See deployment/MIGRATE_NATIVE.md.
No arguments starts interactive configuration. Planning does not contact hosts.
Secrets belong in protected environment/configuration files, never CLI arguments.
EOF
}

# The directory is canonical and either exists and is writable, or can be created in its nearest
# existing ancestor.
hive_writable_directory() {
  local path=$1 parent
  [[ "$path" == /* && "$path" != / && "$path" == "$(realpath -m -- "$path")" ]] || return 1
  parent=$path
  while [[ ! -e "$parent" && "$parent" != / ]]; do parent=$(dirname -- "$parent"); done
  [[ -d "$parent" && -w "$parent" ]]
}

hive_prompt() {
  local variable=$1 label=$2 fallback=${3:-} answer
  read -r -p "$label${fallback:+ [$fallback]}: " answer
  printf -v "$variable" '%s' "${answer:-$fallback}"
}

hive_configure() {
  [[ -t 0 ]] || hive_die 'Interactive setup requires a terminal; use --config FILE --non-interactive'
  hive_need openssl; hive_need sha256sum
  local resume control_ssh='' existing id directory origin profile output endpoint model credential engine protocol target bind port architecture selected mode certificate private_key username email
  local inference='[]' agents='[]' temporary config selected_json runtime version agent_id agent_profile agent_environment agent_service authorized
  local external_ca enrollment_endpoint enrollment_prefix enrollment_credential enrollment_ca provider_slug provider_aliases
  local product product_host product_origin product_bind product_certificate product_key product_inference trust_bundle ssh_config magnus_console
  local gateway_deploy='' gateway_username='' gateway_key='' gateway_grant=no agent_port=''
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
  jq -e '.components["hive-registry"]!=null' "$HIVE_MANIFEST" >/dev/null || hive_die 'This release has no Hive Registry. The registry is mandatory: use a release whose signed manifest includes hive-registry.'
  jq -e --arg version "$HIVE_VERSION" '.schema==1 and .version==$version and (.components|keys|all(.[];test("^[a-z][a-z0-9-]{0,47}$")))' "$HIVE_MANIFEST" >/dev/null || hive_die 'Release metadata does not match the requested version'
  hive_prompt id 'Installation name'
  [[ "$id" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || hive_die 'An installation name starts with a lowercase letter and has only lowercase letters, digits and hyphens'
  # A setup that stopped after writing its configuration continues from that file.
  existing="${XDG_CONFIG_HOME:-${HOME:-$PWD}/.config}/hive/$id/installation.json"
  if [[ -e "$existing" || -L "$existing" ]]; then
    printf 'Installation %s already has a configuration: %s\n' "$id" "$existing"
    hive_prompt resume 'Continue with it instead of answering the setup questions again (yes/no)' yes
    [[ "$resume" == yes ]] || hive_die "Choose another installation name, or move $existing away first"
    printf 'Continuing with it. The same step unattended: ./hive.sh install --config %s --release %s\n' "$existing" "$HIVE_VERSION"
    HIVE_CONFIG=$existing
    return 0
  fi
  hive_prompt directory 'Installation directory on the selected host (absolute)' "/opt/$id"
  hive_prompt target 'Host SSH target (local or deploy@host)' local
  if [[ "$target" == local ]]; then
    # Checked now, not after the plan: fresh setup creates this directory as the current account.
    while ! hive_writable_directory "$directory"; do
      printf '%s must be a canonical absolute path that %s can create or write. To use it, create it in another terminal with:\n  sudo install -d -m 0750 -o %s -g %s %s\n' "$directory" "$(id -un)" "$(id -un)" "$(id -gn)" "$directory"
      hive_prompt directory 'Installation directory on the selected host (absolute)' "$directory"
    done
  else
    hive_prompt control_ssh 'Protected SSH configuration for the selected host (blank for your default SSH settings)'
  fi
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
  # Mandatory in every selection, including a prepared custom one.
  selected_json=$(jq -nc --argjson selected "$selected_json" '$selected+["hive-registry"]|unique')
  jq -e --argjson selected "$selected_json" '.components as $components|all($selected[];$components[.]!=null)' "$HIVE_MANIFEST" >/dev/null || hive_die 'Unknown selected component'
  printf 'The console listens on this address. The default, 127.0.0.1, accepts connections from this host only (for an SSH tunnel or a local reverse proxy); 0.0.0.0, or one of this host'"'"'s addresses, serves the network.\n'
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
    # The web terminal is new authority over every fleet node, so no profile selects it.
    if jq -e '.components["magnus-gateway"]!=null' "$HIVE_MANIFEST" >/dev/null && jq -ne --argjson selected "$selected_json" '$selected|index("magnus")!=null' >/dev/null; then
      if jq -ne --argjson selected "$selected_json" '$selected|index("magnus-gateway")!=null' >/dev/null; then gateway_deploy=yes
      else hive_prompt gateway_deploy 'Deploy the Magnus web terminal gateway (yes/no)' no; fi
      if [[ "$gateway_deploy" == yes ]]; then
        selected_json=$(jq -nc --argjson selected "$selected_json" '$selected+["magnus-gateway"]|unique')
        hive_prompt gateway_username 'Restricted SSH account on fleet nodes for the gateway'
        hive_prompt gateway_key 'Protected SSH private key file on the Magnus host (absolute)'
        hive_prompt gateway_grant 'Grant magnus:terminal to the initial operator (yes/no)' no
      elif [[ "$gateway_deploy" != no ]]; then hive_die 'Answer yes or no'; fi
      [[ "$gateway_grant" == yes || "$gateway_grant" == no ]] || hive_die 'Answer yes or no'
    fi
    # Host agents reach Magnus on its own published port; a distributed Magnus has its endpoint.
    if [[ "$mode" == fresh ]] && jq -ne --argjson selected "$selected_json" '$selected|index("magnus")!=null' >/dev/null; then
      printf 'Magnus host agents need to reach its agent API. Hive can publish it on its own port at %s, where only the agent routes and credentials pass.\n' "$bind"
      hive_prompt agent_port 'Port for Magnus host agents, for example 4000 (blank for none)'
      [[ -z "$agent_port" || ( "$agent_port" =~ ^[0-9]{4,5}$ && "$agent_port" -ge 1024 && "$agent_port" -le 65535 && "$agent_port" != "$port" ) ]] || hive_die 'Choose a port from 1024 to 65535 other than the console port, or leave it blank'
    fi
  fi
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
  jq -n --arg id "$id" --arg directory "$directory" --arg target "$target" --arg ssh "$control_ssh" --arg architecture "$architecture" --arg origin "$origin" --arg profile "$profile" --arg version "$HIVE_VERSION" --arg bind "$bind" --arg port "$port" --arg mode "$mode" --arg username "${username:-}" --arg email "${email:-}" --arg certificate "${certificate:-}" --arg key "${private_key:-}" --arg gatewayUsername "$gateway_username" --arg gatewayKey "$gateway_key" --arg gatewayGrant "$gateway_grant" --arg agentPort "$agent_port" --argjson selected "$selected_json" --argjson agents "$agents" --argjson inference "$inference" --slurpfile release "$HIVE_MANIFEST" '
    {schema:1,installation:$id,release:$version,profile:$profile,origin:$origin,hosts:{control:({target:$target,directory:$directory,architecture:$architecture}+(if $ssh!="" then {sshConfig:$ssh} else {} end))},components:($selected|map(. as $name|{key:$name,value:({host:"control"}+(if $release[0].components[$name].kind=="static-ui" then {} elif $release[0].components[$name].kind=="datastore" then {configDirectory:($directory+"/config/"+$name)} else {envFile:($directory+"/config/"+$name+".env"),configDirectory:($directory+"/config/"+$name)} end))})|from_entries),agents:$agents,inference:$inference} +
    (if ($selected|index("hivexui"))!=null or ($selected|index("ingress"))!=null then {console:({host:"control",bindAddress:$bind,httpsPort:($port|tonumber),runtimeFile:($directory+"/config/runtime.json")}+(if $agentPort!="" then {nativeListeners:[{port:($agentPort|tonumber),component:"magnus"}]} else {} end))} else {} end) +
    (if $mode=="fresh" or $mode=="distributed" then {bootstrap:({adminUsername:$username,adminEmail:$email,certificateFile:$certificate,privateKeyFile:$key} + (if ($selected|index("magnus-gateway"))!=null then {magnusGateway:{sshUsername:$gatewayUsername,sshPrivateKeyFile:$gatewayKey,grantTerminalToInitialOperator:($gatewayGrant=="yes")}} else {} end))} else {} end)' > "$config"
  if [[ "$mode" == distributed ]]; then
    printf 'Place products within this installation. Each product keeps its private datastore on its selected host. Every host must trust the explicit HTTPS certificate bundle.\n'
    hive_prompt trust_bundle 'Product trust bundle file available on every host (absolute)'
    jq --arg trust "$trust_bundle" '.bootstrap.trustBundleFile=$trust | .bootstrap.productEndpoints={}' "$config" > "$temporary/next.json"; mv "$temporary/next.json" "$config"
    for product in oathweave emberpath hivemem hiveskills magnus magnus-gateway cindertrace chattermost; do
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
    (keys-["schema","installation","release","configurationRevision","profile","origin","hosts","components","console","bootstrap","agents","inference","skillsDeployment","nativeMigration"]|length==0) and
    ((.configurationRevision // "1")|type=="string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")) and
    .schema==1 and (.installation|id) and (.profile|IN("core","full","custom")) and
    (.origin|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?$")) and
    (.hosts|type=="object" and length>0 and all(to_entries[];
      (.key|id) and (.value.directory|path) and (.value.directory|length>4) and
      (.value|keys-["target","directory","architecture","minimumFreeMiB","sshConfig","sudoPasswordFile"]|length==0) and
      ((.value.sudoPasswordFile // "/dev/null")|path) and
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
  if [[ -z "${HIVE_VERSION:-}" ]]; then HIVE_VERSION=$(hive_default_release); fi
  if jq -e 'has("bootstrap")' "$HIVE_CONFIG" >/dev/null; then
    if jq -e '.bootstrap|type=="object" and has("magnusConsoleOrigin")' "$HIVE_CONFIG" >/dev/null; then
      hive_die 'bootstrap.magnusConsoleOrigin is no longer supported: HiveXUI now provides the Magnus console through /api/magnus. Remove this field from the installation configuration and run the command again; review the new plan before applying it.'
    fi
    jq -e '
      def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
      .bootstrap|type=="object" and (keys-["adminUsername","adminEmail","certificateFile","privateKeyFile","productEndpoints","trustBundleFile","magnusGateway"]|length==0) and
      (.adminUsername|type=="string" and test("^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$")) and
      (.adminEmail|type=="string" and length<=254 and test("^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$")) and
      (.certificateFile|path) and (.privateKeyFile|path)
    ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid fresh-install bootstrap configuration; provide initial operator labels and protected console certificate/key references'
    if declare -F hive_bootstrap_validate >/dev/null; then hive_bootstrap_validate; fi
  fi
  if jq -e 'has("console")' "$HIVE_CONFIG" >/dev/null; then
    jq -e '
      def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
      . as $c | .console as $ui |
      ($ui|type=="object" and (keys-["host","bindAddress","httpsPort","runtimeFile","nativeListeners","networkSubnet","edgeSubnet"]|length==0)) and
      ($c.hosts[$ui.host]!=null) and $c.components.hivexui.host==$ui.host and $c.components.ingress.host==$ui.host and
      ($c.components.hivexui|has("envFile") or has("configDirectory")|not) and
      ($c.components.ingress.envFile|path) and ($c.components.ingress.configDirectory|path) and
      ($ui.runtimeFile|path) and ($ui.runtimeFile|startswith($c.hosts[$ui.host].directory+"/config/")) and
      ($ui.httpsPort|type=="number" and floor==. and .>=1 and .<=65535) and
      ($ui.bindAddress|type=="string" and
        (.=="::" or .=="::1" or (split(".")|length==4 and all(.[];test("^[0-9]{1,3}$") and (tonumber<=255)))))
    ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid console placement: co-locate ingress and HiveXUI, supply an explicit listener and a public runtime file inside the protected installation config tree; HiveXUI cannot receive an environment file or backend configuration'
  fi
  # A fresh installation may publish one more port on the console bind address: the Magnus
  # control API for host agents. Migrated installations keep their own native listeners.
  if jq -e '.nativeMigration==null and (.console.nativeListeners // [] | length>0)' "$HIVE_CONFIG" >/dev/null; then
    jq -e '
      . as $c | .console.nativeListeners as $listeners |
      $c.bootstrap!=null and ($listeners|type=="array" and length==1) and
      ($listeners[0]|type=="object" and (keys|sort)==["component","port"] and .component=="magnus" and
        (.port|type=="number" and floor==. and .>=1024 and .<=65535) and .port!=$c.console.httpsPort) and
      $c.components.magnus.host==$c.console.host
    ' "$HIVE_CONFIG" >/dev/null || hive_die 'console.nativeListeners on a fresh installation is one {"port":N,"component":"magnus"}: a port from 1024 to 65535, not the console port, with Magnus on the console host. It publishes the Magnus agent API; see deployment/FULL.md#magnus-host-agents'
  fi
  if declare -F hive_registry_validate >/dev/null; then hive_registry_validate; fi
  if declare -F hive_skills_validate >/dev/null; then hive_skills_validate; fi
  if declare -F hive_adapter_validate >/dev/null; then hive_adapter_validate; fi
  if declare -F hive_native_validate >/dev/null; then hive_native_validate; fi
}

hive_manifest() {
  [[ "$HIVE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || hive_die 'An exact release version is required'
  HIVE_MANIFEST=${HIVE_MANIFEST:-$HIVE_ROOT/releases/$HIVE_VERSION.json}
  HIVE_SIGNATURE=${HIVE_SIGNATURE:-$HIVE_MANIFEST.sig}
  HIVE_TRUST_KEY=${HIVE_TRUST_KEY:-$HIVE_ROOT/trust/publisher.pub}
  [[ -f "$HIVE_MANIFEST" && -f "$HIVE_SIGNATURE" && -f "$HIVE_TRUST_KEY" ]] || hive_die 'Signed release manifest, signature and publisher key are required'
  openssl pkeyutl -verify -pubin -inkey "$HIVE_TRUST_KEY" -rawin -in "$HIVE_MANIFEST" -sigfile "$HIVE_SIGNATURE" >/dev/null 2>&1 || hive_die 'Release signature verification failed'
  if declare -F hive_registry_release >/dev/null; then hive_registry_release; fi
  if declare -F hive_magnus_gateway_release >/dev/null; then hive_magnus_gateway_release; fi
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
  # Rendering depends on the relaxed limits choice, so it must select a distinct plan. Plans without it keep their digest.
  HIVE_PLAN_DIGEST=$( { sha256sum "$HIVE_CONFIG" | cut -d ' ' -f1; printf '%s\n' "$HIVE_MANIFEST_DIGEST" "$HIVE_CONTROLLER_DIGEST"; if [[ "${HIVE_RELAX_AUTH_LIMITS:-false}" == true ]]; then printf 'relax-auth-limits\n'; fi; } | sha256sum | cut -d ' ' -f1)
}

hive_plan() {
  local released=${HIVE_RELEASE_SUMMARY:-'{}'}
  jq --arg version "$HIVE_VERSION" --arg digest "${HIVE_MANIFEST_DIGEST:-}" --arg controller "${HIVE_CONTROLLER_DIGEST:-}" --arg plan "${HIVE_PLAN_DIGEST:-}" --argjson released "$released" --argjson relax "${HIVE_RELAX_AUTH_LIMITS:-false}" '{schema,installation,release:$version,configurationRevision:(.configurationRevision // "1"),planDigest:$plan,manifestDigest:$digest,controllerSourceSHA256:$controller,profile,origin,
    authLimits:{relaxed:$relax,products:(if $relax then [.components|keys[]|select(IN("oathweave","cindertrace","chattermost"))] else [] end)},
    magnusTerminal:{gatewaySelected:(.components["magnus-gateway"]!=null),grantedToInitialOperator:(.bootstrap.magnusGateway.grantTerminalToInitialOperator==true)},
    hosts:(.hosts|map_values({target,directory})),
    console:(if .console then {host:.console.host,bindAddress:.console.bindAddress,httpsPort:.console.httpsPort,publicRuntimeConfigured:true} + (if .nativeMigration==null and .console.nativeListeners then {magnusAgentPort:.console.nativeListeners[0].port} else {} end) else null end),
    components:(.components|with_entries(.key as $name|.value=({host:.value.host,environmentConfigured:(.value|has("envFile")),configurationMounted:(.value|has("configDirectory"))}+($released[$name] // {})))),
    productEndpoints:((.bootstrap.productEndpoints // {})|map_values({origin,inferenceOrigin,bindAddress,certificateConfigured:true}|with_entries(select(.value!=null)))),
    agents:(.agents|map({host,runtime})),inference:(.inference|map({host,engine,protocol:(.protocol // "openai"),endpoint,model,credentialConfigured:has("authHeaderFile"),registrationConfigured:has("registration")}))}' "$HIVE_CONFIG"
}

# Arguments are transported as JSON over stdin. No configuration is sourced as shell.
hive_host() {
  local host=$1 script=$2 target payload bootstrap_users sudo_file
  local -a ssh_options
  hive_ssh_options "$host"
  bootstrap_users=${HIVE_BOOTSTRAP_USERS:-'{}'}
  local bootstrap_images=${HIVE_BOOTSTRAP_IMAGES:-'{}'}
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  payload=$(jq -c --arg host "$host" --arg installation "$HIVE_ID" --arg version "$HIVE_VERSION" --arg digest "${HIVE_MANIFEST_DIGEST:-}" --arg plan "${HIVE_PLAN_DIGEST:-}" \
    --arg action "${HIVE_HOST_ACTION:-}" --arg operation "${HIVE_OPERATION:-}" --arg archive "${HIVE_ARCHIVE:-}" --argjson allowMigrations "${HIVE_ALLOW_MIGRATIONS:-false}" \
    --argjson serviceUsers "$bootstrap_users" --argjson images "$bootstrap_images" --argjson identityIds "${HIVE_BOOTSTRAP_IDENTITIES:-null}" --arg ingressTemplate "${HIVE_BOOTSTRAP_INGRESS:-}" --arg integrityScript "$(base64 -w0 "$HIVE_ROOT/scripts/suite/check-data.mjs")" --arg snapshotTool "${HIVE_SNAPSHOT_TOOL:-}" \
    --arg skillsManifest "${HIVE_SKILLS_MANIFEST:-}" --arg skillsSignature "${HIVE_SKILLS_SIGNATURE:-}" --arg skillsTrust "${HIVE_SKILLS_TRUST:-}" --arg skillsTokenSHA "${HIVE_SKILLS_TOKEN_SHA:-}" \
    --arg controller "${HIVE_CONTROLLER_DIGEST:-}" --arg controllerArchive "${HIVE_CONTROLLER_ARCHIVE_DIGEST:-}" --argjson registry "${HIVE_REGISTRY_INPUT:-null}" --argjson memoryCredential "${HIVE_MEMORY_CREDENTIAL_INPUT:-null}" --argjson magnusTrust "${HIVE_MAGNUS_TRUST_INPUT:-null}" --argjson cindertrace "${HIVE_CINDERTRACE_INPUT:-null}" \
    --arg dataTool "${HIVE_NATIVE_DATA_TOOL:-}" --arg adminScript "${HIVE_NATIVE_ADMIN_SCRIPT:-}" --argjson reviewedLinks "${HIVE_NATIVE_LINKS:-null}" --arg tokenDigest "${HIVE_NATIVE_TOKEN_DIGEST:-}" --argjson tokenTtlSeconds "${HIVE_NATIVE_TOKEN_TTL:-null}" \
    '{directory:.hosts[$host].directory,minimumFreeMiB:(.hosts[$host].minimumFreeMiB // 2048),origin,host:$host,installation:$installation,version:$version,digest:$digest,plan:$plan,controllerSourceSHA256:$controller,controllerArchiveSHA256:$controllerArchive,registry:$registry,memoryCredential:$memoryCredential,magnusTrust:$magnusTrust,cindertrace:$cindertrace,action:$action,operation:$operation,archive:$archive,allowMigrations:$allowMigrations,placements:(.components|with_entries(select(.value.host==$host))),console:(if .console.host==$host then .console else null end),bootstrap:(.bootstrap // null),bootstrapImages:$images,bootstrapIdentityIds:$identityIds,bootstrapServiceUsers:$serviceUsers,ingressTemplate:$ingressTemplate,integrityScript:$integrityScript,snapshotTool:$snapshotTool,skillsDeployment:(.skillsDeployment // null),skillsRelease:{manifest:$skillsManifest,signature:$skillsSignature,trust:$skillsTrust},skillsTokenSHA256:$skillsTokenSHA,nativeMigration:(.nativeMigration // null),dataTool:$dataTool,adminScript:$adminScript,reviewedLinks:$reviewedLinks,tokenDigest:$tokenDigest,tokenTtlSeconds:$tokenTtlSeconds,agents:[.agents[]|select(.host==$host)],inference:[.inference[]|select(.host==$host)]}' "$HIVE_CONFIG")
  sudo_file=$(hive_sudo_file "$host")
  if [[ "$target" == local ]]; then
    printf '%s\n' "$payload" | bash -c "$script"
  else
    # The remote command is fixed. Dynamic data is base64 stdin, never shell code.
    local encoded
    encoded=$(printf '%s' "$script" | base64 -w0)
    if [[ -n "$sudo_file" ]]; then
      # sudo reads exactly its password line from standard input; the payload follows it.
      { cat -- "$sudo_file"; printf '%s\n' "$payload"; } | ssh "${ssh_options[@]}" -- "$target" "sudo -k -S -p '' bash -c \"\$(printf '%s' '$encoded' | base64 -d)\""
    else
      printf '%s\n' "$payload" | ssh "${ssh_options[@]}" -- "$target" "bash -c \"\$(printf '%s' '$encoded' | base64 -d)\""
    fi
  fi
}

# A protected file on the controller, never a command-line value. Hosts without it use
# the SSH account directly.
hive_sudo_file() {
  local file
  file=$(jq -r --arg host "$1" '.hosts[$host].sudoPasswordFile // empty' "$HIVE_CONFIG")
  [[ -n "$file" ]] || return 0
  [[ -f "$file" && ! -L "$file" && -r "$file" && $(stat -c %u "$file") == "$(id -u)" ]] || hive_die 'The sudo password file must be an operator-owned regular file'
  (( (8#$(stat -c %a "$file") & 077)==0 )) || hive_die 'The sudo password file must be owner-only'
  printf '%s\n' "$file"
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
  jq -n --slurpfile config "$HIVE_CONFIG" --slurpfile release "$HIVE_MANIFEST" --arg host "$host" --argjson relax "${HIVE_RELAX_AUTH_LIMITS:-false}" '
    $config[0] as $c | $release[0] as $r |
    # ChatterMost already has login limit settings. Every product carries the marker status reads.
    {oathweave:{RELAX_AUTH_LIMITS:"true"},cindertrace:{RELAX_AUTH_LIMITS:"true"},chattermost:{RELAX_AUTH_LIMITS:"true",RATE_LIMIT_LOGIN_SOURCE_MAX:"10000",RATE_LIMIT_LOGIN_ACCOUNT_MAX:"10000"}} as $relaxedEnvironment |
    {name:($c.installation+"-"+$host),services:($c.components|to_entries|map(select(.value.host==$host)|
      .key as $name | .value as $placement |
      ($r.components[$name].kind // "application") as $kind |
      {key:$name,value:($r.components[$name].service + {
        image:$r.components[$name].image, restart:"unless-stopped",
        security_opt:["no-new-privileges:true"],cap_drop:["ALL"],read_only:true,init:true,stop_grace_period:"45s",tmpfs:(["/tmp:mode=1777"] + (($r.components[$name].service.tmpfs // []) | map(. as $path | ($r.components[$name].service.user|split(":")) as $owner | $path+":uid="+$owner[0]+",gid="+$owner[1]+",mode=700")) + (if $kind=="static-ui" then ($r.components[$name].service.user|split(":")) as $user | ["/var/cache/nginx:uid="+$user[0]+",gid="+$user[1]+",mode=700","/var/run:uid="+$user[0]+",gid="+$user[1]+",mode=700"] else [] end)),
        volumes:((if $kind=="static-ui" then [{type:"bind",source:$c.console.runtimeFile,target:"/usr/share/nginx/html/runtime.json",read_only:true}] else [{type:"bind",source:($c.hosts[$host].directory+"/data/"+$name),target:"/data"}] end) +
          (if $placement.configDirectory then [{type:"bind",source:$placement.configDirectory,target:"/config",read_only:true}] else [] end))
      } + (if $placement.envFile then {env_file:[$placement.envFile]} else {} end) +
        (if $c.nativeMigration.dataAliases[$name] then {volumes:((if $kind=="static-ui" then [] else [{type:"bind",source:($c.hosts[$host].directory+"/data/"+$name),target:"/data"}] end)+[{type:"bind",source:($c.hosts[$host].directory+"/data/"+$name),target:$c.nativeMigration.dataAliases[$name]}]+(if $placement.configDirectory then [{type:"bind",source:$placement.configDirectory,target:"/config",read_only:true}] else [] end))} else {} end) +
        (if $kind=="application" then {environment:(($r.components[$name].service.environment // {})+{HIVE_AUTO_MIGRATE:"false",HIVE_AUTO_UPGRADE:"false",HIVE_UPDATE_CHECK:"false",HIVE_UI_UPGRADE:"false"} + (if $name=="magnus" then {MAGNUS_AUTO_MIGRATE:"false"} else {} end) + (if $relax then ($relaxedEnvironment[$name] // {}) else {} end))} else {} end) +
        (if $kind=="ingress" then {ports:([{target:8443,published:($c.console.httpsPort|tostring),host_ip:$c.console.bindAddress,protocol:"tcp"}]+(($c.console.nativeListeners // [])|map({target:.port,published:(.port|tostring),host_ip:$c.console.bindAddress,protocol:"tcp"})))} + (if $c.nativeMigration.rehearsal==true then {networks:["default","edge"]} else {} end)
         elif $c.bootstrap.productEndpoints[$name] then $c.bootstrap.productEndpoints[$name] as $endpoint |
          {ports:([{target:({oathweave:4200,emberpath:9443,hivemem:18790,hiveskills:4030,magnus:4000,"magnus-gateway":4310,cindertrace:4101,chattermost:8065}[$name]),published:($endpoint.origin|capture("^https://[^:]+(?::(?<port>[0-9]+))?$")|.port // "443"),host_ip:$endpoint.bindAddress,protocol:"tcp"}] +
            (if $name=="emberpath" then [{target:4020,published:($endpoint.inferenceOrigin|capture("^https://[^:]+(?::(?<port>[0-9]+))?$")|.port // "443"),host_ip:$endpoint.bindAddress,protocol:"tcp"}] else [] end))}
         else {} end) +
        # The registry starts first on its host, before the products it records.
        (if $name!="hive-registry" and $kind!="datastore" and $c.components["hive-registry"].host==$host then {depends_on:((($r.components[$name].service.depends_on // {})|if type=="array" then map({key:.,value:{condition:"service_started"}})|from_entries else . end)+{"hive-registry":{condition:"service_healthy"}})} else {} end))})|from_entries),networks:({default:({driver:"bridge"}+(if $c.console.networkSubnet then {ipam:{config:[{subnet:$c.console.networkSubnet}]}} else {} end)+(if $c.nativeMigration.rehearsal==true then {internal:true} else {} end))}+($r.networks // {})+(if $c.nativeMigration.rehearsal==true then {edge:{driver:"bridge",ipam:{config:[{subnet:$c.console.edgeSubnet}]}}} else {} end))} |
    # An explicit address plan for hosts whose Docker address pools are limited.
    reduce (($c.nativeMigration.networkSubnets // {})|to_entries[]) as $net (.; if .networks[$net.key] then .networks[$net.key].ipam={config:[{subnet:$net.value}]} else . end)'
}

hive_transfer() {
  local host=$1 file=$2 relative=$3 target directory
  local -a ssh_options
  hive_ssh_options "$host"
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  directory=$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG")
  local sudo_file
  sudo_file=$(hive_sudo_file "$host")
  if [[ "$target" == local ]]; then
    install -m 600 -- "$file" "$directory/$relative"
  elif [[ -n "$sudo_file" ]]; then
    { cat -- "$sudo_file"; cat -- "$file"; } | ssh "${ssh_options[@]}" -- "$target" "sudo -k -S -p '' sh -c 'umask 077; cat > \"$directory/$relative\"'"
  else
    scp -q -p "${ssh_options[@]}" -- "$file" "$target:$directory/$relative"
  fi
}


hive_main() {
  local command=install confirmed=false interactive=true hold_on_failure=false
  HIVE_ARCHIVE='' HIVE_RECONCILIATION='' HIVE_ALLOW_MIGRATIONS=false HIVE_RELAX_AUTH_LIMITS=false HIVE_BACKUP_STOPPED=false
  HIVE_CONFIG='' HIVE_VERSION='' HIVE_MANIFEST='' HIVE_SIGNATURE='' HIVE_TRUST_KEY='' HIVE_CINDERTRACE_SOURCES=''
  HIVE_CONTROLLER_DIGEST='' HIVE_CONTROLLER_ARCHIVE_DIGEST=''
  HIVE_RELEASE_SUMMARY='' HIVE_REGISTRY_FILE='' HIVE_REGISTRY_ORIGINAL_CONFIG='' HIVE_REGISTRY_TEMPORARY='' HIVE_OPERATION=''
  local -a registry_arguments=() trust_arguments=()
  if (($#)) && [[ "$1" != --* ]]; then command=$1; shift; fi
  while (($#)); do
    case $1 in
      --help|-h) hive_usage; return;;
      --yes) confirmed=true; shift;;
      --allow-migrations) HIVE_ALLOW_MIGRATIONS=true; shift;;
      --relax-auth-limits) HIVE_RELAX_AUTH_LIMITS=true; shift;;
      --non-interactive) interactive=false; shift;;
      --hold-on-failure) hold_on_failure=true; shift;;
      --stopped) [[ "$command" == backup ]] || hive_die '--stopped applies only to backup'; HIVE_BACKUP_STOPPED=true; shift;;
      --sources)
        [[ "$command" == cindertrace-collector ]] || hive_die '--sources applies only to cindertrace-collector'
        (($#>=2)) && [[ -n $2 && $2 != --* ]] || hive_die "Missing value: $1"
        HIVE_CINDERTRACE_SOURCES=$2; shift 2;;
      --file)
        [[ "$command" == registry ]] || hive_die '--file applies only to registry'
        (($#>=2)) && [[ -n $2 && $2 != --* ]] || hive_die "Missing value: $1"
        HIVE_REGISTRY_FILE=$2; shift 2;;
      --node-id|--host|--port|--fingerprint|--previous|--approved-by|--approval-ref)
        [[ "$command" == magnus-trust ]] || hive_die 'Unknown option'
        (($#>=2)) && [[ -n $2 && $2 != --* ]] || hive_die "Missing value: $1"
        trust_arguments+=("$1" "$2"); shift 2;;
      --config|--release|--manifest|--signature|--trust-key|--archive|--reconciliation)
        (($#>=2)) && [[ -n $2 && $2 != --* ]] || hive_die "Missing value: $1"
        case $1 in
          --config) HIVE_CONFIG=$2;; --release) HIVE_VERSION=$2;; --manifest) HIVE_MANIFEST=$2;;
          --signature) HIVE_SIGNATURE=$2;; --trust-key) HIVE_TRUST_KEY=$2;; --archive) HIVE_ARCHIVE=$2;; --reconciliation) HIVE_RECONCILIATION=$2;;
        esac; shift 2;;
      *)
        [[ "$1" != --* ]] || hive_die 'Unknown option'
        case "$command" in
          registry|migrate-native|cindertrace-collector) registry_arguments+=("$1");;
          magnus-trust) trust_arguments=("$1" "${trust_arguments[@]}");;
          *) hive_die 'Unknown option';;
        esac
        shift;;
    esac
  done
  case "$command" in init|plan|install|status|doctor|upgrade|rollback|backup|adopt|restore|rehearse|agents-accept|skills-prepare|registry|magnus-trust|migrate-native|tls-refresh|cindertrace-collector) ;; *) hive_die 'Unknown command';; esac
  if [[ "$HIVE_RELAX_AUTH_LIMITS" == true ]]; then
    case "$command" in plan|install|upgrade) ;; *) hive_die '--relax-auth-limits applies only to plan, install and upgrade';; esac
  fi
  hive_need jq
  if [[ -z "$HIVE_CONFIG" ]]; then
    [[ "$interactive" == true ]] || hive_die '--config is required'
    hive_configure
    case "$command" in install|init) hive_setup_hosts_ready;; esac
  fi
  # A renewal timer outlives the release in the configuration file; it runs this checkout's release.
  if [[ "$command" == tls-refresh && -z "$HIVE_VERSION" && -z "$HIVE_MANIFEST" ]]; then HIVE_VERSION=$(hive_checkout_release); fi
  HIVE_OPERATION=$command
  trap 'if [[ -n "${HIVE_REGISTRY_TEMPORARY:-}" ]]; then rm -f -- "$HIVE_REGISTRY_TEMPORARY"; fi' EXIT
  hive_registry_configuration "$command"
  hive_validate
  if [[ "$HIVE_RELAX_AUTH_LIMITS" == true ]]; then
    jq -e '.components|has("oathweave") or has("cindertrace") or has("chattermost")' "$HIVE_CONFIG" >/dev/null || hive_die '--relax-auth-limits needs Oathweave, Cindertrace or ChatterMost in this installation'
    printf 'WARNING: this plan relaxes sign-in and password attempt limits. For testing only.\n' >&2
  fi
  case "$command" in
    plan)
      if [[ -n "$HIVE_MANIFEST" || -n "$HIVE_SIGNATURE" || -n "$HIVE_TRUST_KEY" ]]; then hive_need openssl; hive_need sha256sum; hive_manifest; fi
      hive_plan; return;;
    status)
      local host registry_report registry_host
      registry_report=$(hive_registry_report)
      registry_host=$(hive_registry_host)
      while IFS= read -r host; do
        { hive_host "$host" 'set -euo pipefail; read -r input; directory=$(jq -r .directory <<< "$input");
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
          authLimits="{\"relaxed\":false,\"products\":[]}";
          if [[ -f "$directory/compose.json" ]]; then authLimits=$(jq -c "[.services|to_entries[]|select(.value.environment.RELAX_AUTH_LIMITS==\"true\")|.key]|sort|{relaxed:(length>0),products:.}" "$directory/compose.json"); fi;
          jq -n --arg host "$(jq -r .host <<< "$input")" --argjson containers "$containers" --argjson agents "$agents" --argjson authLimits "$authLimits" "{schema:1,host:\$host,authLimits:\$authLimits,containers:\$containers,nativeAgents:\$agents}"'; } |
          if [[ "$host" == "$registry_host" ]]; then jq --argjson registry "$registry_report" '.registry=$registry'; else cat; fi
      done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG"); return;;
    doctor)
      hive_registry_preflight; hive_registry_doctor; return;;
    registry) hive_registry_command "${registry_arguments[@]}"; return;;
    magnus-trust) hive_magnus_trust "${trust_arguments[@]}"; return;;
    migrate-native) hive_native_migrate "${registry_arguments[0]:-}" "$confirmed" "$hold_on_failure"; return;;
    tls-refresh) hive_need openssl; hive_need sha256sum; hive_manifest; hive_tls_refresh; return;;
    cindertrace-collector) hive_need openssl; hive_need sha256sum; hive_manifest; hive_cindertrace_collector "${registry_arguments[@]}"; return;;
  esac
  hive_need openssl; hive_need sha256sum; hive_manifest
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
