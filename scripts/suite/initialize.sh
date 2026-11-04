#!/usr/bin/env bash

hive_initialize() {
  # The initial core contract is intentionally bounded. Existing installations
  # continue through explicit adoption and reviewed account enrollment.
  jq -e '
    .bootstrap!=null and .console!=null and (.hosts|length==1) and
    (.components|keys)==["emberpath","hivemem","hivemem-qdrant","hiveskills","hivexui","ingress","oathweave","oathweave-redis"] and
    (. as $c|all(.components[];.host==$c.console.host)) and
    (. as $c|all(.components|to_entries[]; if .key=="hivexui" then true else
      .value.configDirectory==($c.hosts[.value.host].directory+"/config/"+.key) and
      (if .key=="hivemem-qdrant" or .key=="oathweave-redis" then true else .value.envFile==($c.hosts[.value.host].directory+"/config/"+.key+".env") end)
    end))
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Fresh core initialization requires co-located core products, their private datastores, ingress, bootstrap certificate references and standard protected config paths. Existing or separately configured products must use their owning setup workflow; this command never adopts or overwrites their state.'
  HIVE_BOOTSTRAP_USERS=$(jq -c --slurpfile config "$HIVE_CONFIG" '.components|with_entries(select(.key as $name|$config[0].components[$name]!=null))|map_values(.service.user)' "$HIVE_MANIFEST")
  HIVE_BOOTSTRAP_INGRESS=$(base64 -w0 "$HIVE_ROOT/deployment/Caddyfile")
  local host
  host=$(jq -r .console.host "$HIVE_CONFIG")
  HIVE_HOST_ACTION=initialize-check hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/initialize-host.sh")" || hive_die 'Fresh initialization preflight failed; existing resources are unchanged'
  HIVE_HOST_ACTION=initialize hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/initialize-host.sh")" || hive_die 'Fresh configuration initialization held; preserve its protected receipt and rerun with identical inputs'
  printf 'Protected core configuration prepared. Review the plan, then run install with this same configuration. Initial sign-in instructions are stored on the identity host in config/initial-credentials.env.\n'
}
