#!/usr/bin/env bash

# Emberpath reaches HiveMem with short-lived Oathweave client_credentials tokens that it
# renews itself, so no operator, timer or reminder ever renews a memory token. This declares
# that client wherever Emberpath serves HiveMem-backed endpoints, on migration, upgrade or
# install. A fresh suite does not expose them, so its Emberpath gets no HiveMem identity.
# The client secret is generated on, and stays on, the host that runs Oathweave and Emberpath.
hive_memory_credential_action() {
  local host=$1 action=$2 input=$3
  HIVE_HOST_ACTION=$action HIVE_MEMORY_CREDENTIAL_INPUT=$input hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/memory-credential-host.sh")"
}

hive_memory_credential_provision() {
  jq -e '.components.oathweave!=null and .components.emberpath!=null and .components.hivemem!=null' "$HIVE_CONFIG" >/dev/null || return 0
  local identity_host memory_host endpoints result
  identity_host=$(jq -r .components.oathweave.host "$HIVE_CONFIG")
  memory_host=$(jq -r .components.hivemem.host "$HIVE_CONFIG")
  if [[ $(jq -r .components.emberpath.host "$HIVE_CONFIG") != "$identity_host" ]]; then
    printf 'Note: Emberpath and Oathweave run on different hosts, so the self-renewing memory credential is not configured here. Emberpath memory features need HIVE_ROUTER_MEMORY_PROXY_TOKEN.\n' >&2
    return 0
  fi
  endpoints=$(jq -c '{identityOrigin:(.bootstrap.productEndpoints.oathweave.origin // "https://oathweave:4200"),memoryOrigin:(.bootstrap.productEndpoints.hivemem.origin // "https://hivemem:18790")}' "$HIVE_CONFIG")
  result=$(hive_memory_credential_action "$identity_host" memory-credential-identity "$endpoints") || hive_die 'The Emberpath memory credential could not be prepared; no service was changed'
  ! jq -e '.skipped==true' <<< "$result" >/dev/null || return 0
  hive_memory_credential_action "$memory_host" memory-credential-link "$(jq -c '{clientId,issuer,localId}' <<< "$result")" >/dev/null || hive_die 'HiveMem could not be linked to the Emberpath memory credential; no service was changed'
}
