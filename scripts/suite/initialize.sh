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
    ($names-["hive-registry","emberpath","hivemem","hivemem-qdrant","hiveskills","hivexui","ingress","oathweave","oathweave-redis","magnus","magnus-gateway","magnus-postgres","magnus-redis","cindertrace","cindertrace-postgres","cindertrace-redis","chattermost","chattermost-postgres","emberfold"]|length==0) and
    (. as $c|all(["magnus","cindertrace","chattermost"][];. as $name| if $c.components[$name] then
      $release[0].components[$name].initialization!=null and
      $c.components[$name+"-postgres"].host==$c.components[$name].host and
      (if $name!="chattermost" then $c.components[$name+"-redis"].host==$c.components[$name].host else true end) and
      (if $c.bootstrap.productEndpoints then $c.bootstrap.productEndpoints[$name]!=null else true end)
     else $c.components[$name+"-postgres"]==null and $c.components[$name+"-redis"]==null end)) and
    (if .components.emberfold then .components.emberfold.host==.console.host else true end) and
    (if .components["magnus-gateway"] then .components.magnus!=null and .components["magnus-gateway"].host==.components.magnus.host else true end) and
    .components.oathweave.host==.components["oathweave-redis"].host and
    (if .components.hivemem then .components["hivemem-qdrant"]!=null and .components.hivemem.host==.components["hivemem-qdrant"].host else .components["hivemem-qdrant"]==null end) and
    (if (.hosts|length)>1 then .bootstrap.productEndpoints!=null else true end) and
    (. as $c|all(.hosts|keys[];. as $host|any($c.components[];.host==$host))) and
    (. as $c|all(.components|to_entries[]; if .key=="hivexui" then true else
      .value.configDirectory==($c.hosts[.value.host].directory+"/config/"+.key) and
      (if (.key|test("-(qdrant|redis|postgres)$")) then true else .value.envFile==($c.hosts[.value.host].directory+"/config/"+.key+".env") end)
    end))
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Fresh suite initialization requires the Hive Registry, Oathweave, its private Redis, HiveXUI and ingress, locally placed selected-product datastores, explicit HTTPS endpoints across hosts and standard protected config paths. Existing or separately configured products must use their owning setup workflow; this command never adopts or overwrites their state.'
  HIVE_BOOTSTRAP_USERS=$(jq -c --slurpfile config "$HIVE_CONFIG" '.components|with_entries(select(.key as $name|$config[0].components[$name]!=null))|map_values(.service.user)' "$HIVE_MANIFEST")
  HIVE_BOOTSTRAP_IMAGES=$(jq -c --slurpfile config "$HIVE_CONFIG" ' .components|with_entries(select(.key as $name|$config[0].components[$name]!=null))|map_values(.image)' "$HIVE_MANIFEST")
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
  printf 'Protected selected-product configuration prepared. Review the plan, then run install with this same configuration. Initial sign-in instructions are stored on the identity host in config/initial-credentials.env.\n'
}
