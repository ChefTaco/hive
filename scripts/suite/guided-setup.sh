#!/usr/bin/env bash
# Optional host preparation for a person running a fresh, local installation.
# Saved configurations, planning and unattended commands never enter this path.

hive_setup_ask() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == y || "$answer" == yes ]]
}

hive_setup_sudo() {
  if [[ $(id -u) == 0 ]]; then "$@"; else sudo -- "$@"; fi
}

# Refresh Docker membership, then restore the operator's primary group. The signed
# service owner remains uid:original-gid even when Docker was just added.
hive_setup_refresh_groups() {
  local invocation restored
  printf -v invocation '%q ' bash "$HIVE_ROOT/hive.sh" "${HIVE_SETUP_ARGUMENTS[@]}"
  printf -v restored '%q ' sg "$(id -gn)" -c "$invocation"
  exec sg docker -c "$restored"
}

hive_setup_start() {
  HIVE_GUIDED_SETUP=false
  local command=install option
  HIVE_SETUP_ARGUMENTS=("$@")
  [[ -t 0 ]] || return 0
  if (($#)) && [[ $1 != --* ]]; then command=$1; shift; fi
  [[ "$command" == install ]] || return 0
  while (($#)); do
    option=$1; shift
    case "$option" in
      --config|--non-interactive|--help|-h|--manifest|--signature|--trust-key) return 0;;
      --release) (($#)) || return 0; shift;;
      --yes|--relax-auth-limits) ;;
      *) return 0;;
    esac
  done
  HIVE_GUIDED_SETUP=true
  if [[ ${HIVE_SETUP_LOCAL:-} != yes && ${HIVE_SETUP_LOCAL:-} != no ]]; then
    printf 'Hive can prepare this machine with Docker and the required tools. Remote installations need only the controller tools here.\n'
    if hive_setup_ask 'Prepare this machine for a local installation?'; then HIVE_SETUP_LOCAL=yes
    else HIVE_SETUP_LOCAL=no; fi
    export HIVE_SETUP_LOCAL
  fi
  local -a preparation=()
  if [[ "$HIVE_SETUP_LOCAL" == no ]]; then preparation+=(--controller); fi
  if ! bash "$HIVE_ROOT/scripts/install-prerequisites.sh" --check "${preparation[@]}" >/dev/null 2>&1; then
    bash "$HIVE_ROOT/scripts/install-prerequisites.sh" --dry-run "${preparation[@]}"
    if hive_setup_ask 'Apply these prerequisite changes with sudo?'; then
      hive_setup_sudo bash "$HIVE_ROOT/scripts/install-prerequisites.sh" --yes "${preparation[@]}"
    else
      printf 'Prerequisites were not changed. Prepare them manually before continuing.\n' >&2
      return 1
    fi
    # New group membership takes effect in this child shell, without a logout.
    if [[ "$HIVE_SETUP_LOCAL" == yes && $(id -u) != 0 ]] && ! docker info >/dev/null 2>&1; then
      if id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker; then
        printf 'Continuing setup in a shell with the new Docker group membership.\n'
        hive_setup_refresh_groups
      fi
      hive_die 'Docker is not reachable after preparation; run scripts/install-prerequisites.sh --check'
    fi
  fi
}

hive_setup_directory() {
  local directory=$1
  [[ ${HIVE_GUIDED_SETUP:-false} == true && ${HIVE_SETUP_LOCAL:-no} == yes ]] || return 0
  if ! hive_writable_directory "$directory"; then
    [[ "$directory" == /* && "$directory" != / && "$directory" == "$(realpath -m -- "$directory")" ]] || return 0
    if hive_setup_ask "Create $directory for $(id -un) with sudo?"; then
      hive_setup_sudo bash "$HIVE_ROOT/scripts/install-prerequisites.sh" --yes --directory "$directory"
    fi
  fi
}

hive_setup_origin() {
  HIVE_SETUP_ORIGIN=''
  [[ ${HIVE_GUIDED_SETUP:-false} == true && ${HIVE_SETUP_LOCAL:-no} == yes ]] || return 0
  command -v tailscale >/dev/null || return 0
  local name
  name=$(tailscale status --json 2>/dev/null | jq -er 'select((.CertDomains // [])|length>0)|.Self.DNSName|sub("\\.$";"")') || return 0
  [[ "$name" =~ ^[A-Za-z0-9.-]+$ ]] || return 0
  HIVE_SETUP_ORIGIN="https://$name"
}

hive_setup_certificate() {
  HIVE_SETUP_CERTIFICATE='' HIVE_SETUP_PRIVATE_KEY='' HIVE_SETUP_TAILSCALE=false
  [[ ${HIVE_GUIDED_SETUP:-false} == true && -n ${HIVE_SETUP_ORIGIN:-} && ${HIVE_SETUP_ORIGIN:-} == "$1" ]] || return 0
  if ! bash "$HIVE_ROOT/scripts/console-certificate.sh" check --cert /etc/hive/tls/console.crt --key /etc/hive/tls/console.key --name "${1#https://}" >/dev/null 2>&1; then
    printf 'Tailscale can obtain a trusted HTTPS certificate for this console. Its name will appear in public Certificate Transparency logs.\n'
    hive_setup_ask 'Obtain the console certificate with sudo?' || return 0
    hive_setup_sudo bash "$HIVE_ROOT/scripts/console-certificate.sh" tailscale --owner "$(id -un)" --name "${1#https://}"
  fi
  HIVE_SETUP_CERTIFICATE=/etc/hive/tls/console.crt HIVE_SETUP_PRIVATE_KEY=/etc/hive/tls/console.key HIVE_SETUP_TAILSCALE=true
}

hive_setup_terminal() {
  HIVE_SETUP_TERMINAL_USER='' HIVE_SETUP_TERMINAL_KEY=''
  [[ ${HIVE_GUIDED_SETUP:-false} == true && ${HIVE_SETUP_LOCAL:-no} == yes ]] || return 0
  printf 'The local web terminal uses a dedicated account without sudo and its own SSH key.\n'
  if hive_setup_ask 'Prepare that account and key on this machine with sudo?'; then
    hive_setup_sudo bash "$HIVE_ROOT/scripts/prepare-terminal.sh" --owner "$(id -un)"
    HIVE_SETUP_TERMINAL_USER=hive-terminal HIVE_SETUP_TERMINAL_KEY=/etc/hive/fleet/gateway-key
  fi
}

hive_setup_finish() {
  [[ ${HIVE_GUIDED_SETUP:-false} == true && ${HIVE_SETUP_LOCAL:-no} == yes ]] || return 0
  if [[ ${HIVE_SETUP_TAILSCALE:-false} == true ]] && hive_setup_ask 'Keep the HTTPS certificate current with a weekly renewal timer?'; then
    hive_setup_sudo bash "$HIVE_ROOT/scripts/console-certificate.sh" schedule --config "$HIVE_CONFIG"
  fi
  if jq -e '.components.magnus!=null and any(.console.nativeListeners[]?; .component=="magnus")' "$HIVE_CONFIG" >/dev/null &&
      hive_setup_ask 'Install the Magnus host agent here, so this machine can run agents?'; then
    bash "$HIVE_ROOT/hive.sh" magnus-agent install --config "$HIVE_CONFIG" --install-node --trust --yes
    if jq -e '.components.ardentstudio!=null' "$HIVE_CONFIG" >/dev/null && hive_setup_ask 'Review this new host for managed Ardent actions?'; then
      bash "$HIVE_ROOT/hive.sh" magnus-agent prepare-ardent --config "$HIVE_CONFIG"
    fi
  fi
}
