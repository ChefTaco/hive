#!/usr/bin/env bash
# hive.sh magnus-agent install|status|remove: the Magnus agent on a fleet host, through the
# controller's normal transport. The default host is the Magnus host; --host names an inventory
# host or an SSH target (user@host, with --ssh-config and --sudo-password-file as needed).
# The agent version and its tarball integrity come from the signed release; the node credentials
# move from the Magnus host's configuration to the agent's root-only environment without being
# printed, passed as arguments or written anywhere else.

hive_magnus_agent_release() {
  jq -ce '.components.magnus.agentPackage|select(.name=="@hivemagnus/magnus-agent" and (.version|test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and (.integrity|test("^sha512-[A-Za-z0-9+/]{86}==$")))' "$HIVE_MANIFEST" 2>/dev/null ||
    hive_die "Release $HIVE_VERSION pins no Magnus agent package. Use the checkout of a release that does (2.0.4 or later)"
}

# The host to run on: an inventory host, or a fleet host given as an SSH target, added to a
# private copy of the configuration that only this command uses.
hive_magnus_agent_target() {
  local target=$1 magnus_host console_host
  magnus_host=$(jq -r .components.magnus.host "$HIVE_CONFIG")
  if [[ -z "$target" ]]; then HIVE_AGENT_HOST=$magnus_host
  elif jq -e --arg host "$target" '.hosts[$host]!=null' "$HIVE_CONFIG" >/dev/null; then HIVE_AGENT_HOST=$target
  else
    [[ "$target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || hive_die '--host is an inventory host ID or an SSH target such as deploy@node-1.example.com'
    HIVE_AGENT_CONFIG_DIRECTORY=$(mktemp -d)
    jq --arg target "$target" --arg ssh "$HIVE_AGENT_SSH_CONFIG" --arg sudo "$HIVE_AGENT_SUDO_FILE" \
      '.hosts["fleet-agent"]={target:$target,directory:"/opt/magnus-agent"}+(if $ssh!="" then {sshConfig:$ssh} else {} end)+(if $sudo!="" then {sudoPasswordFile:$sudo} else {} end)' \
      "$HIVE_CONFIG" > "$HIVE_AGENT_CONFIG_DIRECTORY/installation.json"
    chmod 600 "$HIVE_AGENT_CONFIG_DIRECTORY/installation.json"
    trap 'rm -rf -- "$HIVE_AGENT_CONFIG_DIRECTORY"; if [[ -n "${HIVE_REGISTRY_TEMPORARY:-}" ]]; then rm -f -- "$HIVE_REGISTRY_TEMPORARY"; fi' EXIT
    HIVE_AGENT_HOST=fleet-agent HIVE_AGENT_BASE_CONFIG=$HIVE_CONFIG HIVE_CONFIG=$HIVE_AGENT_CONFIG_DIRECTORY/installation.json
  fi
  HIVE_MAGNUS_HOST=$magnus_host
  console_host=$(jq -r .console.host "$HIVE_CONFIG")
  [[ "$HIVE_AGENT_HOST" == "$console_host" ]] && HIVE_AGENT_ON_CONSOLE=true || HIVE_AGENT_ON_CONSOLE=false
}

# Runs one host action. On the local host it runs as root through sudo when this account is not
# root; the request still travels on standard input only.
hive_magnus_agent_action() {
  local host=$1 action=$2 request=$3 root=${4:-false} target
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  if [[ "$root" == true && "$target" == local && $(id -u) != 0 ]]; then
    HIVE_HOST_LOCAL_SUDO=true HIVE_HOST_ACTION=$action HIVE_MAGNUS_AGENT_INPUT=$request hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/magnus-agent-host.sh")"
  else
    HIVE_HOST_ACTION=$action HIVE_MAGNUS_AGENT_INPUT=$request hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/magnus-agent-host.sh")"
  fi
}

hive_magnus_agent_confirm() { # FLAG QUESTION
  [[ "$1" != true ]] || return 0
  [[ -t 0 ]] || return 1
  local answer
  read -r -p "$2 [y/N] " answer
  [[ "$answer" == y || "$answer" == yes ]]
}

hive_magnus_agent_node_record() { # FQDN
  local directory
  directory=$(jq -r --arg host "$HIVE_MAGNUS_HOST" '.hosts[$host].directory' "${HIVE_AGENT_BASE_CONFIG:-$HIVE_CONFIG}")
  HIVE_CONFIG=${HIVE_AGENT_BASE_CONFIG:-$HIVE_CONFIG} hive_magnus_agent_action "$HIVE_MAGNUS_HOST" magnus-agent-heartbeat \
    "$(jq -nc --arg compose "$directory/compose.json" --arg fqdn "$1" '{compose:$compose,hostFqdn:$fqdn}')"
}

hive_magnus_agent() {
  local subcommand=${1:-} port origin console_name preflight package fqdn request certificate magnus_directory started record fingerprint result
  jq -e '.components.magnus!=null' "$HIVE_CONFIG" >/dev/null || hive_die 'This installation has no Magnus'
  case "$subcommand" in install|status|remove) ;; *) hive_die 'Use: magnus-agent install|status|remove --config FILE [--host TARGET] [--install-node] [--trust] [--yes]';; esac
  port=$(jq -r '[.console.nativeListeners // [] | .[] | select(.component=="magnus") | .port][0] // empty' "$HIVE_CONFIG")
  [[ -n "$port" || "$subcommand" != install ]] || hive_die 'This installation publishes no Magnus agent port, so an agent could not reach Magnus. A fresh installation gets one from the setup question "Port for Magnus host agents" (console.nativeListeners in the installation file); adding it to an existing installation is not supported yet. See deployment/FULL.md#magnus-host-agents'
  origin=$(jq -r .origin "$HIVE_CONFIG"); console_name=${origin#https://}; console_name=${console_name%%:*}
  magnus_directory=$(jq -r --arg host "$(jq -r .components.magnus.host "$HIVE_CONFIG")" '.hosts[$host].directory' "$HIVE_CONFIG")
  hive_magnus_agent_target "$HIVE_AGENT_TARGET"
  preflight=$(hive_magnus_agent_action "$HIVE_AGENT_HOST" magnus-agent-preflight '{}') || hive_die "Host $HIVE_AGENT_HOST could not be checked; see above"
  if [[ "$HIVE_AGENT_ON_CONSOLE" == true ]]; then fqdn=$console_name; else fqdn=$(jq -r .tailnetName <<< "$preflight"); fi

  case "$subcommand" in
    status)
      record=$(hive_magnus_agent_node_record "$fqdn" 2>/dev/null || printf 'null\n')
      jq -n --arg host "$HIVE_AGENT_HOST" --arg fqdn "$fqdn" --argjson preflight "$preflight" --argjson node "${record:-null}" \
        '{host:$host,hostFqdn:$fqdn,installedVersion:($preflight.installedVersion|if .=="" then null else . end),service:$preflight.service,node:$node}'
      if [[ -n "$record" && "$record" != null ]] && jq -e '.components["magnus-gateway"]!=null' "$HIVE_CONFIG" >/dev/null; then
        printf 'Web terminal approvals:\n'
        HIVE_CONFIG=${HIVE_AGENT_BASE_CONFIG:-$HIVE_CONFIG} hive_magnus_trust list 2>/dev/null | grep -F -- "$(jq -r .id <<< "$record")" || printf '  none for this node\n'
      fi
      return;;
    remove)
      hive_magnus_agent_confirm "$HIVE_CONFIRMED" "Stop and remove the Magnus agent on $HIVE_AGENT_HOST?" || hive_die 'Cancelled; nothing was changed'
      record=$(hive_magnus_agent_node_record "$fqdn" 2>/dev/null || printf 'null\n')
      hive_magnus_agent_action "$HIVE_AGENT_HOST" magnus-agent-remove '{}' true >/dev/null || hive_die 'The agent could not be removed; see above'
      printf 'Removed the Magnus agent from %s. Magnus keeps its record of the node.\n' "$HIVE_AGENT_HOST"
      if [[ "$HIVE_AGENT_TRUST" == true && -n "$record" && "$record" != null ]] && jq -e '.components["magnus-gateway"]!=null' "$HIVE_CONFIG" >/dev/null; then
        HIVE_CONFIG=${HIVE_AGENT_BASE_CONFIG:-$HIVE_CONFIG} hive_magnus_trust remove --node-id "$(jq -r .id <<< "$record")" --host "$fqdn" && printf 'Revoked the web terminal approval for this node.\n'
      fi
      return;;
  esac

  package=$(hive_magnus_agent_release)
  [[ $(jq -r .systemd <<< "$preflight") == true ]] || hive_die "Host $HIVE_AGENT_HOST has no systemd; the agent runs as a systemd service"
  [[ $(jq -r .port.state <<< "$preflight") != occupied ]] || hive_die "Port 4100 on $HIVE_AGENT_HOST is in use by something other than the Magnus agent"
  [[ -n "$fqdn" ]] || hive_die "Host $HIVE_AGENT_HOST is not the console host and has no Tailscale certificate name; the agent needs a certificate for its listener"
  if [[ $(jq -r '.node.ok // false' <<< "$preflight") != true ]]; then
    printf 'Node.js on %s: %s. The Magnus agent needs ^24.22.1 or ^26.13.0.\n' "$HIVE_AGENT_HOST" "$(jq -r '.node.version // "not installed"' <<< "$preflight")"
    if ! hive_magnus_agent_confirm "$HIVE_AGENT_INSTALL_NODE" "Install Node.js 24 on $HIVE_AGENT_HOST from NodeSource's signed apt repository?"; then
      hive_die "Node.js was not installed. Install it yourself, then run this again: on $HIVE_AGENT_HOST, as root, add https://deb.nodesource.com/node_24.x (suite nodistro, component main) signed by https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key with fingerprint 6F71F525282841EEDAF851B42F59B5F99B1BE0B4, then apt-get install nodejs; or rerun with --install-node"
    fi
    [[ $(jq -r .apt <<< "$preflight") == true ]] || hive_die "Host $HIVE_AGENT_HOST has no apt; install Node.js 24 yourself"
    result=$(hive_magnus_agent_action "$HIVE_AGENT_HOST" magnus-agent-node '{}' true) || hive_die 'Node.js could not be installed; see above'
    printf 'Installed Node.js %s on %s.\n' "$(jq -r .node <<< "$result")" "$HIVE_AGENT_HOST"
  fi

  # The listener certificate: the console's own on the console host, renewed with it;
  # elsewhere a Tailscale certificate the agent renews itself.
  if [[ "$HIVE_AGENT_ON_CONSOLE" == true ]]; then
    certificate=$(jq -c '{certificate:.bootstrap.certificateFile,key:.bootstrap.privateKeyFile,renewal:"console"}' "$HIVE_CONFIG")
  else
    [[ $(jq -r .tailscale <<< "$preflight") == true ]] || hive_die "Host $HIVE_AGENT_HOST has no tailscale for its listener certificate"
    certificate=$(jq -nc --arg root "${HIVE_MAGNUS_AGENT_ROOT:-/opt/magnus-agent}" '{certificate:($root+"/certs/agent.crt"),key:($root+"/certs/agent.key"),renewal:"tailscale"}')
  fi
  request=$(jq -nc --argjson package "$package" --arg control "https://$console_name:$port" --arg fqdn "$fqdn" --argjson certificate "$certificate" \
    --arg root "${HIVE_MAGNUS_AGENT_ROOT:-}" '{package:$package,controlApiUrl:$control,hostFqdn:$fqdn,certificate:$certificate}+(if $root!="" then {root:$root} else {} end)')
  # The node credentials: read on the Magnus host itself when the agent runs there; for another
  # host they stream through this controller in an owner-only file and on standard input only.
  local secrets=''
  if [[ "$HIVE_AGENT_HOST" == "$HIVE_MAGNUS_HOST" ]]; then
    request=$(jq -c --arg file "$magnus_directory/config/magnus.env" '.magnusEnvironment=$file' <<< "$request")
  else
    secrets=$(mktemp); chmod 600 "$secrets"
    HIVE_CONFIG=${HIVE_AGENT_BASE_CONFIG:-$HIVE_CONFIG} hive_magnus_agent_action "$HIVE_MAGNUS_HOST" magnus-agent-secrets \
      "$(jq -nc --arg file "$magnus_directory/config/magnus.env" '{magnusEnvironment:$file}')" > "$secrets" || { rm -f -- "$secrets"; hive_die 'The node credentials could not be read on the Magnus host'; }
  fi
  hive_magnus_agent_confirm "$HIVE_CONFIRMED" "Install or update the Magnus agent $(jq -r .version <<< "$package") on $HIVE_AGENT_HOST as $fqdn?" || { [[ -z "$secrets" ]] || rm -f -- "$secrets"; hive_die 'Cancelled; nothing was changed'; }
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  result=$(HIVE_HOST_SECRET_FILE=$secrets hive_magnus_agent_action "$HIVE_AGENT_HOST" magnus-agent-install "$request" true) || { [[ -z "$secrets" ]] || rm -f -- "$secrets"; hive_die 'The agent was not installed; see above'; }
  [[ -z "$secrets" ]] || rm -f -- "$secrets"
  printf 'Magnus agent %s on %s: service %s.\n' "$(jq -r .version <<< "$result")" "$HIVE_AGENT_HOST" "$(jq -r .service <<< "$result")"

  # Bounded wait for Magnus to accept the agent's heartbeat.
  local attempt
  for attempt in $(seq 1 24); do
    record=$(hive_magnus_agent_node_record "$fqdn" 2>/dev/null || true)
    if [[ -n "$record" && "$record" != null ]] && jq -e --arg since "$started" '.lastHeartbeatAt!=null and .lastHeartbeatAt>=$since' <<< "$record" >/dev/null; then break; fi
    record=''; sleep 5
  done
  [[ -n "$record" ]] || hive_die "Magnus has not accepted a heartbeat from $fqdn within 2 minutes. Check: journalctl -u magnus-agent on $HIVE_AGENT_HOST, and ./hive.sh magnus-agent status --config FILE"
  printf 'Magnus accepted the heartbeat: node %s (%s), %s.\n' "$(jq -r .id <<< "$record")" "$fqdn" "$(jq -r .status <<< "$record")"

  if jq -e '.components["magnus-gateway"]!=null' "$HIVE_CONFIG" >/dev/null; then
    fingerprint=$(hive_magnus_agent_action "$HIVE_AGENT_HOST" magnus-agent-host-key '{}' | jq -r .fingerprint) || hive_die 'The host key could not be read'
    printf 'Host key read on %s: %s\n' "$HIVE_AGENT_HOST" "$fingerprint"
    if hive_magnus_agent_confirm "$HIVE_AGENT_TRUST" "Approve this host key for the web terminal?"; then
      HIVE_CONFIG=${HIVE_AGENT_BASE_CONFIG:-$HIVE_CONFIG} hive_magnus_trust add --node-id "$(jq -r .id <<< "$record")" --host "$fqdn" --fingerprint "$fingerprint" \
        --approved-by "${USER:-operator}" --approval-ref magnus-agent-install || hive_die 'The web terminal approval failed; the agent is installed'
      printf 'The web terminal can open sessions on this node.\n'
    else
      printf 'Not approved for the web terminal. Later: ./hive.sh magnus-trust add --config FILE --node-id %s --host %s --fingerprint %s --approved-by NAME --approval-ref REF\n' "$(jq -r .id <<< "$record")" "$fqdn" "$fingerprint"
    fi
  fi
}
