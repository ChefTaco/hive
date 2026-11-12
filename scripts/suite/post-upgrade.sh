#!/usr/bin/env bash
# hive.sh post-upgrade: the steps that follow an upgrade, in one command. It checks the Magnus
# host agent on the Magnus host against the release's pinned agent and upgrades it through the
# existing magnus-agent paths. It adds HiveXUI browser clients that are missing from Oathweave,
# using console-clients add. Then it lists what is left for the operator. Every change goes
# through the confirmations of the command it uses; nothing is changed without them.

# Runs one controller command as its own process, so that its errexit and traps behave exactly as
# when the operator runs it. It uses the same installation file and verified release.
hive_post_upgrade_run() {
  local -a confirmation=()
  [[ "${HIVE_CONFIRMED:-false}" != true ]] || confirmation=(--yes)
  bash "$HIVE_ROOT/hive.sh" "$@" --config "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}" --release "$HIVE_VERSION" \
    --manifest "$HIVE_MANIFEST" --signature "$HIVE_SIGNATURE" --trust-key "$HIVE_TRUST_KEY" "${confirmation[@]}"
}

# The step for the Magnus agent on the Magnus host: done, a command to run, or nothing to do.
hive_post_upgrade_agent() {
  local status installed wanted
  jq -e '.components.magnus!=null' "$HIVE_CONFIG" >/dev/null || return 0
  wanted=$(hive_magnus_agent_release | jq -er .version) || return 0
  if ! status=$(hive_post_upgrade_run magnus-agent status 2>/dev/null); then
    printf -- '- Magnus agent: could not be checked. Run: ./hive.sh magnus-agent status --config %s\n' "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}"
    return 0
  fi
  installed=$(jq -r '.installedVersion // empty' <<< "$status")
  if [[ -z "$installed" ]]; then
    printf -- '- Magnus agent: not installed on the Magnus host. Nothing to upgrade.\n'
    return 0
  fi
  if [[ "$installed" == "$wanted" ]]; then
    printf -- '- Magnus agent: %s, as this release pins.\n' "$installed"
    return 0
  fi
  printf -- '- Magnus agent: %s on the Magnus host; this release pins %s.\n' "$installed" "$wanted"
  # Topology is not enrollment authority. Package updates preserve an operator's limited,
  # Ardent-only or full-node posture; full enrollment requires its separate explicit command.
  hive_post_upgrade_run magnus-agent install || printf '  The agent was not upgraded; see above. Rerun: ./hive.sh magnus-agent install --config %s\n' "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}"
}

# Browser clients for products added since the Oathweave store was created. The command
# creates only the missing ones and reports "none" when nothing was missing.
hive_post_upgrade_clients() {
  jq -e '.components.oathweave!=null and .console!=null' "$HIVE_CONFIG" >/dev/null || return 0
  ! jq -e '.bootstrap.magnusGateway.grantTerminalToInitialOperator==true' "$HIVE_CONFIG" >/dev/null || return 0
  [[ $(hive_console_clients_wanted) != '[]' ]] || return 0
  printf -- '- HiveXUI browser clients in Oathweave:\n'
  hive_post_upgrade_run console-clients add || printf '  Not applied; see above. Rerun: ./hive.sh console-clients add --config %s\n' "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}"
}

hive_post_upgrade() {
  printf 'After the upgrade to %s:\n' "$HIVE_VERSION"
  hive_post_upgrade_agent
  hive_post_upgrade_clients
  if jq -e '.components.magnus!=null or .external.magnus!=null' "$HIVE_CONFIG" >/dev/null; then
    printf -- '- Ardent: in HiveXUI, open Magnus > Ardent > Installations. Stop running profiles, choose Update package, then start them again.\n'
    printf -- '- Fleet hosts with their own Magnus agent: run ./hive.sh magnus-agent install --config %s --host HOST for each one.\n' "$HIVE_CONFIG"
  fi
  if jq -e '.bootstrap!=null and .console!=null and .hosts[.console.host].target=="local"' "$HIVE_CONFIG" >/dev/null &&
      [[ ! -e /etc/systemd/system/hive-console-certificate.service ]]; then
    printf -- '- HTTPS certificate: nothing renews it on this host. See deployment/QUICKSTART.md, section 9.\n'
  fi
  printf 'Check the result with: ./hive.sh doctor --config %s\n' "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}"
}
