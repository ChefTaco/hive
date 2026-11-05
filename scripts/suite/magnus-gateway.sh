#!/usr/bin/env bash
# Controller side of the optional Magnus fleet gateway. jq and SSH only.

# A signed release may offer the gateway, but it is never part of a profile, so nothing
# deploys the web terminal unless the installation configuration selects it.
hive_magnus_gateway_release() {
  jq -e '
    (.profiles|to_entries|all(.value|index("magnus-gateway")==null)) and
    (if .components["magnus-gateway"] then
      (.components["magnus-gateway"].kind // "application")=="application" and
      ((.components["magnus-gateway"].requiresLocal // [])|index("magnus")!=null)
    else true end)
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'The Magnus fleet gateway must be an optional application that requires Magnus on its host; a release profile cannot select it'
}

# hive.sh magnus-trust list|scan|add|rotate|extra|remove, passed to the gateway's own CLI on
# its host. The gateway never learns a key from a connection: `add` needs the fingerprint the
# operator read on the node. Values travel as JSON and reach the container as arguments.
hive_magnus_trust() {
  local subcommand=${1:-} value
  jq -e '.components["magnus-gateway"]!=null' "$HIVE_CONFIG" >/dev/null || hive_die 'This installation has no magnus-gateway component; the web terminal is off'
  case "$subcommand" in scan|add|rotate|extra|remove|list) ;; *) hive_die 'Use: magnus-trust list|scan|add|rotate|extra|remove with --node-id, --host, --port, --fingerprint, --previous, --approved-by and --approval-ref as the gateway requires';; esac
  for value in "${@:2}"; do [[ "$value" =~ ^[A-Za-z0-9-][A-Za-z0-9:._/+-]{0,252}$ ]] || hive_die 'Invalid magnus-trust value'; done
  HIVE_HOST_ACTION=magnus-trust HIVE_MAGNUS_TRUST_INPUT=$(jq -nc '$ARGS.positional' --args -- "$@") \
    hive_host "$(jq -r '.components["magnus-gateway"].host' "$HIVE_CONFIG")" "$(cat "$HIVE_ROOT/scripts/suite/magnus-gateway-host.sh")" || hive_die 'The fleet gateway refused this host-key change; nothing was approved'
}
