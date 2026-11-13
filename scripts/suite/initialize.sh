#!/usr/bin/env bash

hive_bootstrap_validate() {
  jq -e '
    def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
    def origin: type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?$") and
      ((capture("^https://[^:]+(?::(?<port>[0-9]+))?$").port // "443")|tonumber|.>=1 and .<=65535);
    def bind: type=="string" and (.=="::" or .=="::1" or (split(".")|length==4 and all(.[];test("^[0-9]{1,3}$") and (tonumber<=255))));
    . as $c | .bootstrap as $b |
    if $b.productEndpoints then
      ($b.trustBundleFile|path) and all($b.productEndpoints|keys[];$c.components[.]!=null) and
      all($c.components|keys[]|select(IN("oathweave","emberpath","hivemem","hiveskills","magnus","magnus-gateway","cindertrace","chattermost"));. as $name|$b.productEndpoints[$name]!=null) and
      ($b.productEndpoints|type=="object" and (keys-["emberpath","hivemem","hiveskills","oathweave","magnus","magnus-gateway","cindertrace","chattermost"]|length==0) and has("oathweave") and all(to_entries[];
        (.value|type=="object" and (keys-["origin","inferenceOrigin","bindAddress","certificateFile","privateKeyFile"]|length==0)) and
        (.value.origin|origin) and (.value.bindAddress|bind) and (.value.certificateFile|path) and (.value.privateKeyFile|path) and
        (if .key=="emberpath" then (.value.inferenceOrigin|origin) and
          (.value.origin|split(":")[1])==(.value.inferenceOrigin|split(":")[1]) and .value.origin!=.value.inferenceOrigin
         else (.value|has("inferenceOrigin")|not) end))) and
      ([ $b.productEndpoints|to_entries[]|.key as $name|.value as $endpoint|(.value.origin,.value.inferenceOrigin // empty)|capture("^https://[^:]+(?::(?<port>[0-9]+))?$")|[$c.components[$name].host,$endpoint.bindAddress,((.port // "443")|tonumber|tostring)] ] +
        [[$c.console.host,$c.console.bindAddress,($c.console.httpsPort|tostring)]]|unique|length)==(($b.productEndpoints|length)+1+(if $b.productEndpoints.emberpath then 1 else 0 end))
    else ($b|has("trustBundleFile")|not) end
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Distributed bootstrap requires an explicit HTTPS endpoint for each selected product, a distinct Emberpath inference origin, protected product certificate/key references and a trust bundle present on each host. Datastores remain private and local to their product.'
  # Off unless asked for: the web terminal is new authority over every fleet node. Selecting
  # the gateway deploys it. Only the separate grant flag gives the initial operator the terminal.
  jq -e '
    def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
    if .components["magnus-gateway"] then
      .bootstrap.magnusGateway|type=="object" and (keys-["sshUsername","sshPrivateKeyFile","grantTerminalToInitialOperator"]|length==0) and
      (.sshUsername|type=="string" and test("^[a-z_][a-z0-9_-]{0,31}$")) and (.sshPrivateKeyFile|path) and
      ((.grantTerminalToInitialOperator // false)|type=="boolean")
    else .bootstrap|has("magnusGateway")|not end
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'bootstrap.magnusGateway belongs with a selected magnus-gateway component and holds sshUsername, sshPrivateKeyFile and the optional boolean grantTerminalToInitialOperator'
}

hive_initialize() {
  # Fresh independent product state only. Existing installations continue
  # through explicit adoption and reviewed account enrollment.
  jq -e --slurpfile release "$HIVE_MANIFEST" '
    .bootstrap!=null and .console!=null and
    (.components|keys) as $names |
    (["hive-registry","hivexui","ingress","oathweave","oathweave-redis"]-$names|length==0) and
    ($names-["hive-registry","emberpath","hivemem","hivemem-qdrant","hiveskills","hivexui","ingress","oathweave","oathweave-redis","magnus","magnus-gateway","magnus-postgres","magnus-redis","cindertrace","cindertrace-postgres","cindertrace-redis","chattermost","chattermost-postgres","emberfold","ardentstudio","embermend","embermend-worker","embermend-postgres"]|length==0) and
    (. as $c|all(["magnus","cindertrace","chattermost"][];. as $name| if $c.components[$name] then
      $release[0].components[$name].initialization!=null and
      $c.components[$name+"-postgres"].host==$c.components[$name].host and
      (if $name!="chattermost" then $c.components[$name+"-redis"].host==$c.components[$name].host else true end) and
      (if $c.bootstrap.productEndpoints then $c.bootstrap.productEndpoints[$name]!=null else true end)
     else $c.components[$name+"-postgres"]==null and $c.components[$name+"-redis"]==null end)) and
    (if .components.emberfold then .components.emberfold.host==.console.host else true end) and
    (if .components.embermend then .components.embermend.host==.console.host and .components.embermend.host==.components.oathweave.host and (.external.magnus!=null or .components.embermend.host==.components.magnus.host) and .components.embermend.host==.components["embermend-postgres"].host and .components.embermend.host==.components["embermend-worker"].host and $release[0].components.embermend.initialization!=null else .components["embermend-worker"]==null and .components["embermend-postgres"]==null end) and
    (if .components.ardentstudio then .components.ardentstudio.host==.console.host and .components.ardentstudio.host==.components.oathweave.host and
      (.components.magnus!=null or .external.magnus!=null) and .components.hivemem!=null else true end) and
    (if .components["magnus-gateway"] then .components.magnus!=null and .components["magnus-gateway"].host==.components.magnus.host else true end) and
    .components.oathweave.host==.components["oathweave-redis"].host and
    (if .components.hivemem then .components["hivemem-qdrant"]!=null and .components.hivemem.host==.components["hivemem-qdrant"].host else .components["hivemem-qdrant"]==null end) and
    (if (.hosts|length)>1 then .bootstrap.productEndpoints!=null else true end) and
    (. as $c|all(.hosts|keys[];. as $host|any($c.components[];.host==$host))) and
    (. as $c|all(.components|to_entries[]; if .key=="hivexui" then true else
      .value.configDirectory==($c.hosts[.value.host].directory+"/config/"+.key) and
      (if (.key|test("-(qdrant|redis|postgres)$")) then true else .value.envFile==($c.hosts[.value.host].directory+"/config/"+.key+".env") end)
    end))
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Fresh suite initialization requires the Hive Registry, Oathweave, its private Redis, HiveXUI and ingress, locally placed selected-product datastores, explicit HTTPS endpoints across hosts and standard protected config paths. Ardent Project Studio needs Magnus and HiveMem (Magnus as the magnus component or an external Magnus), and runs on the console host with Oathweave. Existing or separately configured products must use their owning setup workflow; this command never adopts or overwrites their state.'
  HIVE_BOOTSTRAP_USERS=$(hive_release_selected .service.user)
  HIVE_BOOTSTRAP_IMAGES=$(hive_release_selected .image)
  HIVE_BOOTSTRAP_INGRESS=$(base64 -w0 "$HIVE_ROOT/deployment/Caddyfile")
  local host identity_host
  identity_host=$(jq -r .components.oathweave.host "$HIVE_CONFIG")
  HIVE_BOOTSTRAP_IDENTITIES=null
  while IFS= read -r host; do
    HIVE_HOST_ACTION=initialize-check hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/initialize-full-host.sh" "$HIVE_ROOT/scripts/suite/initialize-host.sh")" || hive_die 'Fresh initialization preflight failed; existing resources are unchanged'
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  HIVE_HOST_ACTION=initialize hive_host "$identity_host" "$(cat "$HIVE_ROOT/scripts/suite/initialize-full-host.sh" "$HIVE_ROOT/scripts/suite/initialize-host.sh")" || hive_die 'Fresh identity configuration initialization held; preserve its protected receipt and rerun with identical inputs'
  HIVE_BOOTSTRAP_IDENTITIES=$(HIVE_HOST_ACTION=initialize-identities hive_host "$identity_host" 'set -Eeuo pipefail; read -r input;
    directory=$(jq -er .directory <<< "$input"); receipt="$directory/config/.initializer/receipt.json";
    jq -e --arg installation "$(jq -er .installation <<< "$input")" --arg host "$(jq -er .host <<< "$input")" ".phase==\"complete\" and .installation==\$installation and .host==\$host" "$receipt" >/dev/null;
    jq -n --arg identity "$(cat "$directory/config/.initializer/secrets/identity-id")" --arg model "$(cat "$directory/config/.initializer/secrets/model-id" 2>/dev/null || true)" --arg memory "$(cat "$directory/config/.initializer/secrets/memory-id" 2>/dev/null || true)" --arg security "$(cat "$directory/config/.initializer/secrets/security-id" 2>/dev/null || true)" --arg chat "$(cat "$directory/config/.initializer/secrets/chat-id" 2>/dev/null || true)" --arg magnus "$(cat "$directory/config/.initializer/secrets/magnus-id" 2>/dev/null || true)" "{security:\$security,chat:\$chat,magnus:\$magnus,identity:\$identity,model:\$model,memory:\$memory}"') || hive_die 'Fresh identity coordination receipt could not be verified'
  while IFS= read -r host; do
    [[ "$host" != "$identity_host" ]] || continue
    HIVE_HOST_ACTION=initialize hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/initialize-full-host.sh" "$HIVE_ROOT/scripts/suite/initialize-host.sh")" || hive_die 'Fresh configuration initialization held; preserve its protected receipt and rerun with identical inputs'
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  hive_registry_provision
  hive_memory_credential_provision
  if jq -e '.components.magnus!=null and .components.hivemem!=null and .components.magnus.host!=.components.oathweave.host' "$HIVE_CONFIG" >/dev/null; then
    printf 'Note: Magnus and Oathweave run on different hosts, so Magnus has no HiveMem service identity and Ardent New Agent answers HIVEMEM_ENROLLMENT_UNAVAILABLE. Configure it by hand as described in deployment/FULL.md.\n' >&2
  fi
  # Hive cannot configure a Magnus it does not run: the entries it needs wait in a protected file
  # on the identity host. The file holds links and URLs, and nothing is printed from it.
  if jq -e '.external.magnus!=null' "$HIVE_CONFIG" >/dev/null; then
    local target
    target=$(jq -r --arg host "$identity_host" '.hosts[$host].target' "$HIVE_CONFIG")
    printf 'External Magnus: add the entries in %s/config/.initializer/external-magnus.env%s to the environment of the Magnus at %s, then restart it. Until then the console cannot sign in to Magnus and Studio cannot reach it. See deployment/FULL.md#external-magnus\n' \
      "$(jq -r --arg host "$identity_host" '.hosts[$host].directory' "$HIVE_CONFIG")" "$([[ "$target" == local ]] || printf ' on %s' "$target")" "$(jq -r .external.magnus.url "$HIVE_CONFIG")"
  fi
  if [[ "${HIVE_OPERATION:-}" == install ]]; then printf 'Protected selected-product configuration prepared; installing the release.\n'
  else printf 'Protected selected-product configuration prepared. Review the plan, then run install with this same configuration. Initial sign-in instructions are stored on the identity host in config/initial-credentials.env.\n'; fi
}

# A renewed console certificate for a completed fresh installation; see tls-refresh in --help.
hive_tls_refresh() {
  jq -e '.bootstrap!=null and .console!=null and .components.ingress!=null' "$HIVE_CONFIG" >/dev/null ||
    hive_die 'tls-refresh installs a renewed console certificate into a fresh installation. An installation moved with migrate-native uses: hive.sh migrate-native tls-refresh'
  HIVE_BOOTSTRAP_USERS=$(hive_release_selected .service.user)
  HIVE_HOST_ACTION=console-certificate hive_host "$(jq -r .components.ingress.host "$HIVE_CONFIG")" "$(cat "$HIVE_ROOT/scripts/suite/input-artifacts-host.sh" "$HIVE_ROOT/scripts/suite/initialize-full-host.sh" "$HIVE_ROOT/scripts/suite/initialize-host.sh")" ||
    hive_die 'Console certificate refresh failed; see the reason above'
}

# The end of a successful install: where the console is, how to sign in and what to do next.
hive_install_summary() {
  local config=${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG} identity directory target
  printf '\nInstalled Hive %s as installation %s.\n' "$HIVE_VERSION" "$HIVE_ID"
  if jq -e '.console!=null' "$HIVE_CONFIG" >/dev/null; then printf '  Console:  %s/\n' "$(jq -r .origin "$HIVE_CONFIG")"; fi
  if jq -e '.bootstrap!=null and .components.oathweave!=null' "$HIVE_CONFIG" >/dev/null; then
    identity=$(jq -r .components.oathweave.host "$HIVE_CONFIG")
    directory=$(jq -r --arg host "$identity" '.hosts[$host].directory' "$HIVE_CONFIG")
    target=$(jq -r --arg host "$identity" '.hosts[$host].target' "$HIVE_CONFIG")
    printf '  Sign in:  as SEED_ADMIN_USERNAME with SEED_ADMIN_PASSWORD from %s/config/initial-credentials.env%s\n' "$directory" "$([[ "$target" == local ]] || printf ' on %s' "$target")"
  fi
  printf '  Check:    ./hive.sh status --config %s\n            ./hive.sh doctor --config %s\n' "$config" "$config"
  printf '  Back up:  ./hive.sh backup --config %s --archive NAME --yes\n' "$config"
  if jq -e '.bootstrap!=null and .console!=null' "$HIVE_CONFIG" >/dev/null; then
    printf '  Renewed console certificate: ./hive.sh tls-refresh --config %s\n' "$config"
  fi
  if jq -e '.components.magnus!=null and ([.console.nativeListeners // [] | .[] | select(.component=="magnus")]|length>0)' "$HIVE_CONFIG" >/dev/null; then
    printf '  Magnus agent on this host: ./hive.sh magnus-agent install --config %s\n' "$config"
  fi
  if jq -e '.external.magnus!=null and .bootstrap!=null and .components.oathweave!=null' "$HIVE_CONFIG" >/dev/null; then
    printf '  External Magnus: add %s/config/.initializer/external-magnus.env%s to the Magnus at %s\n' "$directory" "$([[ "$target" == local ]] || printf ' on %s' "$target")" "$(jq -r .external.magnus.url "$HIVE_CONFIG")"
  fi
  if jq -e '.components.cindertrace!=null' "$HIVE_CONFIG" >/dev/null; then
    printf '  Security events: ./hive.sh cindertrace-collector add ID --sources tailscale --config %s\n' "$config"
  fi
}
