#!/usr/bin/env bash

hive_bootstrap_validate() {
  jq -e '
    def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
    def origin: type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?$") and
      ((capture("^https://[^:]+(?::(?<port>[0-9]+))?$").port // "443")|tonumber|.>=1 and .<=65535);
    def bind: type=="string" and (.=="::" or .=="::1" or (split(".")|length==4 and all(.[];test("^[0-9]{1,3}$") and (tonumber<=255))));
    . as $c | .bootstrap as $b |
    if $b.productEndpoints then
      ($b.trustBundleFile|path) and all(["oathweave","emberpath","hivemem","hiveskills"][];$c.components[.]!=null) and
      ($b.productEndpoints|type=="object" and keys==["emberpath","hivemem","hiveskills","oathweave"] and all(to_entries[];
        (.value|type=="object" and (keys-["origin","inferenceOrigin","bindAddress","certificateFile","privateKeyFile"]|length==0)) and
        (.value.origin|origin) and (.value.bindAddress|bind) and (.value.certificateFile|path) and (.value.privateKeyFile|path) and
        (if .key=="emberpath" then (.value.inferenceOrigin|origin) and
          (.value.origin|split(":")[1])==(.value.inferenceOrigin|split(":")[1]) and .value.origin!=.value.inferenceOrigin
         else (.value|has("inferenceOrigin")|not) end))) and
      ([ $b.productEndpoints|to_entries[]|.key as $name|.value as $endpoint|(.value.origin,.value.inferenceOrigin // empty)|capture("^https://[^:]+(?::(?<port>[0-9]+))?$")|[$c.components[$name].host,$endpoint.bindAddress,((.port // "443")|tonumber|tostring)] ] +
        [[$c.console.host,$c.console.bindAddress,($c.console.httpsPort|tostring)]]|unique|length)==6
    else ($b|has("trustBundleFile")|not) end
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Distributed bootstrap requires four explicit product HTTPS endpoints, a distinct Emberpath inference origin, protected product certificate/key references and a trust bundle present on each host. Datastores remain private and local to their product.'
}

hive_initialize() {
  # Fresh independent product state only. Existing installations continue
  # through explicit adoption and reviewed account enrollment.
  jq -e '
    .bootstrap!=null and .console!=null and
    (.components|keys)==["emberpath","hivemem","hivemem-qdrant","hiveskills","hivexui","ingress","oathweave","oathweave-redis"] and
    .components.oathweave.host==.components["oathweave-redis"].host and
    .components.hivemem.host==.components["hivemem-qdrant"].host and
    (if (.hosts|length)>1 then .bootstrap.productEndpoints!=null else true end) and
    (. as $c|all(.hosts|keys[];. as $host|any($c.components[];.host==$host))) and
    (. as $c|all(.components|to_entries[]; if .key=="hivexui" then true else
      .value.configDirectory==($c.hosts[.value.host].directory+"/config/"+.key) and
      (if .key=="hivemem-qdrant" or .key=="oathweave-redis" then true else .value.envFile==($c.hosts[.value.host].directory+"/config/"+.key+".env") end)
    end))
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Fresh core initialization requires core products, locally placed private datastores, ingress, explicit HTTPS endpoints across hosts and standard protected config paths. Existing or separately configured products must use their owning setup workflow; this command never adopts or overwrites their state.'
  HIVE_BOOTSTRAP_USERS=$(jq -c --slurpfile config "$HIVE_CONFIG" '.components|with_entries(select(.key as $name|$config[0].components[$name]!=null))|map_values(.service.user)' "$HIVE_MANIFEST")
  HIVE_BOOTSTRAP_INGRESS=$(base64 -w0 "$HIVE_ROOT/deployment/Caddyfile")
  local host identity_host
  identity_host=$(jq -r .components.oathweave.host "$HIVE_CONFIG")
  HIVE_BOOTSTRAP_IDENTITIES=null
  while IFS= read -r host; do
    HIVE_HOST_ACTION=initialize-check hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/initialize-host.sh")" || hive_die 'Fresh initialization preflight failed; existing resources are unchanged'
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  HIVE_HOST_ACTION=initialize hive_host "$identity_host" "$(cat "$HIVE_ROOT/scripts/suite/initialize-host.sh")" || hive_die 'Fresh identity configuration initialization held; preserve its protected receipt and rerun with identical inputs'
  HIVE_BOOTSTRAP_IDENTITIES=$(HIVE_HOST_ACTION=initialize-identities hive_host "$identity_host" 'set -Eeuo pipefail; read -r input;
    directory=$(jq -er .directory <<< "$input"); receipt="$directory/config/.initializer/receipt.json";
    jq -e --arg installation "$(jq -er .installation <<< "$input")" --arg host "$(jq -er .host <<< "$input")" ".phase==\"complete\" and .installation==\$installation and .host==\$host" "$receipt" >/dev/null;
    jq -n --arg identity "$(cat "$directory/config/.initializer/secrets/identity-id")" --arg model "$(cat "$directory/config/.initializer/secrets/model-id")" --arg memory "$(cat "$directory/config/.initializer/secrets/memory-id")" "{identity:\$identity,model:\$model,memory:\$memory}"') || hive_die 'Fresh identity coordination receipt could not be verified'
  while IFS= read -r host; do
    [[ "$host" != "$identity_host" ]] || continue
    HIVE_HOST_ACTION=initialize hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/initialize-host.sh")" || hive_die 'Fresh configuration initialization held; preserve its protected receipt and rerun with identical inputs'
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  printf 'Protected core configuration prepared. Review the plan, then run install with this same configuration. Initial sign-in instructions are stored on the identity host in config/initial-credentials.env.\n'
}
