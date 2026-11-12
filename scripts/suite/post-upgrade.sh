#!/usr/bin/env bash
# hive.sh post-upgrade: the steps that follow an upgrade, in one command. It checks the Magnus
# host agent on the Magnus host against the release's pinned agent and upgrades it through the
# existing magnus-agent paths. It adds HiveXUI browser clients that are missing from Oathweave,
# using console-clients add. Then it lists what is left for the operator. Every change goes
# through the confirmations of the command it uses; nothing is changed without them. Each step it
# finds done is marked done in the setup checklist the registry recorded, at once and idempotently.

# Runs one controller command as its own process, so that its errexit and traps behave exactly as
# when the operator runs it. It uses the same installation file and verified release.
hive_post_upgrade_run() {
  local -a confirmation=()
  [[ "${HIVE_CONFIRMED:-false}" != true ]] || confirmation=(--yes)
  bash "$HIVE_ROOT/hive.sh" "$@" --config "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}" --release "$HIVE_VERSION" \
    --manifest "$HIVE_MANIFEST" --signature "$HIVE_SIGNATURE" --trust-key "$HIVE_TRUST_KEY" "${confirmation[@]}"
}

# Marks a recorded setup checklist item done. Nothing happens when the registry recorded no
# checklist (a registry before 1.3.0) or the item is not on it or already done.
hive_post_upgrade_done() {
  [[ -n "${HIVE_POST_UPGRADE_CHECKLIST:-}" ]] || return 0
  hive_checklist_settle "$HIVE_POST_UPGRADE_CHECKLIST" "$1" done || return 0
  HIVE_POST_UPGRADE_CHECKLIST=$(jq -c --arg id "$1" 'map(if .id==$id then .status="done" else . end)' <<< "$HIVE_POST_UPGRADE_CHECKLIST")
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
    hive_post_upgrade_done magnus-agent-enrolled
    return 0
  fi
  printf -- '- Magnus agent: %s on the Magnus host; this release pins %s.\n' "$installed" "$wanted"
  # Topology is not enrollment authority. Package updates preserve an operator's limited,
  # Ardent-only or full-node posture; full enrollment requires its separate explicit command.
  if hive_post_upgrade_run magnus-agent install; then hive_post_upgrade_done magnus-agent-enrolled
  else printf '  The agent was not upgraded; see above. Rerun: ./hive.sh magnus-agent install --config %s\n' "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}"; fi
}

# Browser clients for products added since the Oathweave store was created. The command
# creates only the missing ones and reports "none" when nothing was missing.
hive_post_upgrade_clients() {
  jq -e '.components.oathweave!=null and .console!=null' "$HIVE_CONFIG" >/dev/null || return 0
  ! jq -e '.bootstrap.magnusGateway.grantTerminalToInitialOperator==true' "$HIVE_CONFIG" >/dev/null || return 0
  [[ $(hive_console_clients_wanted) != '[]' ]] || return 0
  printf -- '- HiveXUI browser clients in Oathweave:\n'
  if hive_post_upgrade_run console-clients add; then hive_post_upgrade_done oathweave-console-clients
  else printf '  Not applied; see above. Rerun: ./hive.sh console-clients add --config %s\n' "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}"; fi
}

hive_post_upgrade() {
  HIVE_POST_UPGRADE_CHECKLIST=$(hive_checklist_recorded 2>/dev/null) || HIVE_POST_UPGRADE_CHECKLIST=''
  printf 'After the upgrade to %s:\n' "$HIVE_VERSION"
  hive_post_upgrade_agent
  hive_post_upgrade_clients
  if jq -e '.components.magnus!=null or .external.magnus!=null' "$HIVE_CONFIG" >/dev/null; then
    printf -- '- Ardent: in HiveXUI, open Magnus > Ardent > Installations. Stop running profiles, choose Update package, then start them again.\n'
    printf -- '- Fleet hosts with their own Magnus agent: run ./hive.sh magnus-agent install --config %s --host HOST for each one.\n' "$HIVE_CONFIG"
  fi
  case "$(hive_checklist_certificate_scheduled)" in
    false) printf -- '- HTTPS certificate: nothing renews it on this host. See deployment/QUICKSTART.md, section 9.\n';;
    true) hive_post_upgrade_done certificate-renewal;;
  esac
  if [[ -n "$HIVE_POST_UPGRADE_CHECKLIST" ]]; then hive_checklist_print_pending "$HIVE_POST_UPGRADE_CHECKLIST"; fi
  printf 'Check the result with: ./hive.sh doctor --config %s\n' "${HIVE_REGISTRY_ORIGINAL_CONFIG:-$HIVE_CONFIG}"
}
