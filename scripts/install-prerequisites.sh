#!/usr/bin/env bash
# Installs what hive.sh needs on a Debian or Ubuntu machine: Docker Engine and the Compose plugin
# from Docker's apt repository, and the command-line tools the controller and host scripts use.
#
#   sudo ./scripts/install-prerequisites.sh            show the changes, ask, then apply them
#   sudo ./scripts/install-prerequisites.sh --yes      apply without asking
#   ./scripts/install-prerequisites.sh --dry-run       show the changes and exit
#   ./scripts/install-prerequisites.sh --check         report readiness only; exits 1 if not ready
#
# Options:
#   --user NAME        account that runs hive.sh (default: the sudo caller). It is added to the
#                      docker group, and owns the --directory it creates.
#   --directory DIR    also create the empty installation directory DIR (for example /opt/hive),
#                      owned by that account with mode 0750
#   --controller       a controller that only manages other hosts over SSH: tools only, no Docker
#   --no-docker-group  never change group membership
#   --replace-conflicting
#                      remove distribution container packages (docker.io, podman-docker, ...)
#                      that conflict with Docker's packages. Containers they run stop.
#
# Supported: Ubuntu 22.04 and 24.04, Debian 12 and 13, on amd64 or arm64. Safe to re-run: every
# step checks the current state first and does nothing when it is already satisfied. It never
# changes firewall rules, Docker daemon settings or existing containers.
set -Eeuo pipefail
umask 022

OS_RELEASE=${HIVE_PREREQ_OS_RELEASE:-/etc/os-release}
APT_DIR=${HIVE_PREREQ_APT_DIR:-/etc/apt}
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# Command and its Debian package. hive.sh, its host scripts and the documented commands use these.
TOOLS=(
  'curl curl' 'git git' 'jq jq' 'openssl openssl' 'ssh openssh-client' 'ss iproute2' 'flock util-linux'
  'tar tar' 'gzip gzip' 'find findutils' 'cmp diffutils' 'awk mawk' 'sed sed' 'grep grep'
  'sha256sum coreutils' 'base64 coreutils' 'stat coreutils' 'df coreutils' 'sort coreutils'
  'timeout coreutils' 'realpath coreutils' 'install coreutils' 'mktemp coreutils'
)
DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-compose-plugin)
CONFLICTING_PACKAGES=(docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc)

mode=apply assume_yes=false target_user=${SUDO_USER:-$(id -un)} manage_group=true
replace_conflicting=false controller=false directory=''
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
while (($#)); do
  case "$1" in
    --check) mode=check;;
    --dry-run) mode=dry-run;;
    --yes|-y) assume_yes=true;;
    --user|--directory)
      [[ $# -ge 2 && -n "$2" ]] || { printf '%s needs a value\n' "$1" >&2; exit 2; }
      if [[ "$1" == --user ]]; then target_user=$2; else directory=$2; fi
      shift;;
    --controller) controller=true;;
    --no-docker-group) manage_group=false;;
    --replace-conflicting) replace_conflicting=true;;
    -h|--help) usage; exit 0;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'install-prerequisites: %s\n' "$*" >&2; exit 1; }
[[ "$target_user" != root ]] || target_user=''
if [[ -n "$directory" ]]; then
  [[ "$controller" == false ]] || die '--directory is for the host that runs the suite, not --controller'
  [[ "$directory" == /* && "$directory" != / && "$directory" == "$(realpath -m -- "$directory")" ]] ||
    die "$directory: use a canonical absolute path without symlinks, for example /opt/hive"
  [[ -n "$target_user" ]] || die '--directory needs the owning account: pass --user NAME'
fi
in_group() { id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qx docker; }

# --- Platform -------------------------------------------------------------------------------
[[ -r "$OS_RELEASE" ]] || die "cannot read $OS_RELEASE; this script supports Debian and Ubuntu only"
os_id=$(. "$OS_RELEASE"; printf '%s' "${ID:-}")
os_version=$(. "$OS_RELEASE"; printf '%s' "${VERSION_ID:-}")
os_codename=$(. "$OS_RELEASE"; printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
os_name=$(. "$OS_RELEASE"; printf '%s' "${PRETTY_NAME:-$os_id $os_version}")
case "$os_id:$os_version" in
  ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;;
  *) die "unsupported distribution: $os_name. Supported: Ubuntu 22.04 and 24.04, Debian 12 and 13. Elsewhere, install Docker Engine with the Compose plugin (https://docs.docker.com/engine/install/) and the tools this script lists with --check yourself.";;
esac
command -v dpkg >/dev/null && command -v apt-get >/dev/null || die 'dpkg and apt-get are required'
architecture=$(dpkg --print-architecture)
case "$architecture" in amd64|arm64) ;; *) die "unsupported architecture: $architecture. Hive releases publish linux/amd64 and linux/arm64 images only";; esac
[[ -z "$target_user" ]] || id "$target_user" >/dev/null 2>&1 || die "unknown account: $target_user"

installed() { [[ $(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null || true) == installed ]]; }
docker_repository() { grep -rlsE '^[^#]*download\.docker\.com/linux/(ubuntu|debian)' "$APT_DIR/sources.list" "$APT_DIR/sources.list.d" 2>/dev/null | head -n1 || true; }

# --- Inspect --------------------------------------------------------------------------------
missing_packages=()
for entry in "${TOOLS[@]}"; do
  read -r tool package <<< "$entry"
  if ! command -v "$tool" >/dev/null 2>&1; then
    [[ " ${missing_packages[*]} " == *" $package "* ]] || missing_packages+=("$package")
  fi
done
installed ca-certificates || missing_packages+=(ca-certificates)

install_docker=false add_repository=false remove_conflicts=false conflicts=() docker_source=none
group_change=false start_docker=false create_directory=false compose_ok=false
systemd=false; [[ -d /run/systemd/system ]] && systemd=true
if [[ "$controller" == false ]]; then
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then docker_source=snap
  elif installed docker-ce; then docker_source=docker-ce
  elif installed docker.io; then docker_source=docker.io
  elif command -v docker >/dev/null 2>&1; then docker_source=other; fi
  [[ "$docker_source" != snap ]] || die 'Docker is installed as a snap. The snap only reaches files under /home, so hive.sh cannot use an installation directory such as /opt/hive. Remove it with "sudo snap remove --purge docker" (this deletes its containers and images), then re-run this script.'
  for package in "${CONFLICTING_PACKAGES[@]}"; do if installed "$package"; then conflicts+=("$package"); fi; done
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then compose_ok=true; fi
  case "$docker_source" in
    none) install_docker=true;;
    docker-ce) for package in "${DOCKER_PACKAGES[@]}"; do installed "$package" || install_docker=true; done;;
    docker.io|other)
      if [[ "$compose_ok" == true && "$replace_conflicting" == false ]]; then
        warn "Keeping the existing Docker Engine ($docker_source), which has the Compose plugin. Hive is tested with Docker's own packages; re-run with --replace-conflicting to switch to them."
      elif [[ "$replace_conflicting" == true && "$docker_source" == docker.io ]]; then install_docker=true
      else die "Docker Engine is installed from $docker_source without the Compose v2 plugin. Re-run with --replace-conflicting to replace it with Docker's packages (running containers stop; images and volumes in /var/lib/docker are kept), or install the Compose plugin for your Docker yourself."; fi;;
  esac
  if [[ "$install_docker" == true ]]; then
    [[ -n $(docker_repository) ]] || add_repository=true
    if ((${#conflicts[@]})); then
      [[ "$replace_conflicting" == true ]] || die "These installed packages conflict with Docker's packages: ${conflicts[*]}. Re-run with --replace-conflicting to remove them first. Containers they run stop; data in /var/lib/docker is kept."
      remove_conflicts=true
    fi
  fi
  if [[ "$add_repository" == true ]] && ! command -v gpg >/dev/null 2>&1; then missing_packages+=(gpg); fi
  if [[ "$manage_group" == true && -n "$target_user" ]] && ! in_group "$target_user"; then group_change=true; fi
  if [[ "$systemd" == true ]] && { [[ "$install_docker" == true ]] || ! systemctl is-active --quiet docker 2>/dev/null || ! systemctl is-enabled --quiet docker 2>/dev/null; }; then start_docker=true; fi
  if [[ -n "$directory" ]]; then
    if [[ -e "$directory" ]]; then
      [[ -d "$directory" && ! -L "$directory" ]] || die "$directory exists and is not a directory"
      [[ $(stat -c %U "$directory") == "$target_user" ]] || warn "$directory exists and is owned by $(stat -c %U "$directory"), not $target_user. Fresh setup then needs sudo."
    else create_directory=true; fi
  fi
fi

docker_reachable() {
  if [[ $(id -u) == 0 && -n "$target_user" ]] && command -v runuser >/dev/null 2>&1; then runuser -u "$target_user" -- docker info >/dev/null 2>&1
  else docker info >/dev/null 2>&1; fi
}
report() {
  local entry tool package state ready=true account=${target_user:-$(id -un)}
  say "$([[ "$controller" == true ]] && printf Controller || printf Host): $os_name ($architecture)"
  for entry in "${TOOLS[@]}"; do
    read -r tool package <<< "$entry"
    if command -v "$tool" >/dev/null 2>&1; then state=ok; else state="missing (package $package)"; ready=false; fi
    printf '  %-10s %s\n' "$tool" "$state"
  done
  if [[ "$controller" == true ]]; then [[ "$ready" == true ]]; return; fi
  if [[ "$compose_ok" == true ]]; then
    printf '  %-10s %s\n' docker "$(docker version --format '{{.Client.Version}}' 2>/dev/null || true) from $docker_source"
    printf '  %-10s %s\n' compose "$(docker compose version --short 2>/dev/null)"
    if docker_reachable; then printf '  %-10s %s\n' daemon "reachable by $account"
    else printf '  %-10s %s\n' daemon "not reachable by $account (the daemon is not running, or $account is not in the docker group yet)"; ready=false; fi
  else printf '  %-10s %s\n' docker 'missing: Docker Engine with the Compose plugin'; ready=false; fi
  if [[ -n "$directory" ]]; then
    if [[ -d "$directory" ]]; then printf '  %-10s %s\n' directory "$directory (owner $(stat -c %U "$directory"))"
    else printf '  %-10s %s\n' directory "$directory missing"; ready=false; fi
  fi
  [[ "$ready" == true ]]
}

if [[ "$mode" == check ]]; then
  if report; then say 'Ready: hive.sh prerequisites are installed.'; exit 0; fi
  if [[ "$controller" == true ]]; then say "Not ready. Run: sudo $0 --controller"; else say "Not ready. Run: sudo $0"; fi
  exit 1
fi

# --- Plan -----------------------------------------------------------------------------------
plan=()
if [[ "$remove_conflicts" == true ]]; then plan+=("Remove conflicting packages: ${conflicts[*]}"); fi
if ((${#missing_packages[@]})); then plan+=("Install packages: ${missing_packages[*]}"); fi
if [[ "$add_repository" == true ]]; then plan+=("Add Docker's apt repository ($os_id $os_codename, stable) with its signing key in $APT_DIR/keyrings/docker.asc, checking fingerprint $DOCKER_KEY_FINGERPRINT"); fi
if [[ "$install_docker" == true ]]; then plan+=("Install Docker packages: ${DOCKER_PACKAGES[*]}"); fi
if [[ "$start_docker" == true ]]; then plan+=('Enable and start the docker service'); fi
if [[ "$group_change" == true ]]; then plan+=("Add $target_user to the docker group (takes effect at the next login)"); fi
if [[ "$create_directory" == true ]]; then plan+=("Create the installation directory $directory, owned by $target_user, mode 0750"); fi
if ((${#plan[@]} == 0)); then
  say "Nothing to change on $os_name ($architecture)."
else
  say "Planned changes on $os_name ($architecture):"
  printf '  - %s\n' "${plan[@]}"
fi
if [[ "$mode" == dry-run ]]; then exit 0; fi
if ((${#plan[@]})); then
  [[ $(id -u) == 0 ]] || die 'Changes need root: run it with sudo (or use --dry-run or --check)'
  if [[ "$assume_yes" != true ]]; then
    [[ -t 0 ]] || die 'Confirmation needs a terminal; re-run with --yes to apply the plan above'
    read -r -p 'Apply these changes? [y/N] ' answer
    [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]] || die 'Cancelled; nothing was changed'
  fi
fi

# --- Apply ----------------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt_updated=false
apt_update() { if [[ "$apt_updated" != true ]]; then apt-get update -qq; apt_updated=true; fi; }
if [[ "$remove_conflicts" == true ]]; then apt-get remove -y "${conflicts[@]}"; fi
if ((${#missing_packages[@]})); then apt_update; apt-get install -y --no-install-recommends "${missing_packages[@]}"; fi
if [[ "$add_repository" == true ]]; then
  install -d -m 0755 "$APT_DIR/keyrings"
  key=$(mktemp)
  trap 'rm -f -- "$key"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$os_id/gpg" -o "$key"
  fingerprints=$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '$1=="fpr" {print $10}')
  grep -qx "$DOCKER_KEY_FINGERPRINT" <<< "$fingerprints" || die "Docker's signing key did not match fingerprint $DOCKER_KEY_FINGERPRINT; the repository was not added"
  install -m 0644 "$key" "$APT_DIR/keyrings/docker.asc"
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: %s/keyrings/docker.asc\n' \
    "$os_id" "$os_codename" "$architecture" "$APT_DIR" > "$APT_DIR/sources.list.d/docker.sources"
  chmod 0644 "$APT_DIR/sources.list.d/docker.sources"
  apt_updated=false
fi
if [[ "$install_docker" == true ]]; then apt_update; apt-get install -y "${DOCKER_PACKAGES[@]}"; fi
if [[ "$start_docker" == true ]]; then systemctl enable --now docker.service containerd.service; fi
if [[ "$group_change" == true ]]; then usermod -aG docker "$target_user"; fi
if [[ "$create_directory" == true ]]; then install -d -m 0750 -o "$target_user" -g "$(id -gn "$target_user")" "$directory"; fi

# --- Verify ---------------------------------------------------------------------------------
say ''
if [[ "$controller" == false ]]; then
  compose_ok=false
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then compose_ok=true; fi
  if installed docker-ce; then docker_source=docker-ce; fi
fi
ready=true; report || ready=false
if [[ "$controller" == false ]]; then
  if [[ "$systemd" != true ]]; then warn 'systemd is not running here, so the docker service was not started. Start dockerd yourself.'; fi
  if [[ "$(docker info --format '{{join .SecurityOptions " "}}' 2>/dev/null || true)" == *rootless* ]]; then
    warn 'This Docker daemon runs in rootless mode, which Hive does not support: its services run as UID 1000 and need host files owned by that UID.'
  fi
  say ''
  if [[ -n "$target_user" ]]; then
    if in_group "$target_user"; then
      say "$target_user is in the docker group. Members of that group control Docker, which is equivalent to root on this host."
      if [[ "$group_change" == true ]]; then say "Log out and back in (or run: newgrp docker) so $target_user's shell picks up the new group."; fi
    fi
    uid=$(id -u "$target_user")
    if [[ "$uid" != 1000 ]]; then
      warn "$target_user has UID $uid. Suite services run as UID/GID 1000, so run fresh setup with sudo, or as the account with UID 1000."
    fi
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    say 'ufw is active. Ports that Docker publishes bypass ufw rules, so the console is reachable on whatever address you bind it to. Choose the bind address on purpose: 127.0.0.1, a private or tailnet address, or 0.0.0.0.'
  fi
fi
if [[ "$ready" == true ]]; then
  if [[ "$controller" == true ]]; then say 'Done. Next: run ./hive.sh --release VERSION with an SSH target for each host.'
  else say 'Done. Next: get a console certificate (scripts/console-certificate.sh), then run ./hive.sh --release VERSION.'; fi
else
  say 'Some prerequisites are not ready yet; see above.'
  exit 1
fi
