#!/usr/bin/env bash
# Runs a developer rehearsal the way a production host runs hive.sh's host side: as root, through
# sudo -S, over SSH, while the suite's services run as their own non-root users.
#
#   scripts/suite/sudo-host.sh --scratch DIR [--mount DIR]... [--name NAME] -- COMMAND [ARGUMENTS...]
#
# COMMAND runs as root in a disposable container on the host network, with the host's Docker
# daemon and the repository, DIR and every --mount at their own paths, so every bind mount the
# host side asks the daemon for means the same path. It provides an unprivileged account,
# deploy, whose sudo needs a password; the rehearsal drivers (scripts/suite/sudo-target.mjs)
# start an sshd for it and give the controller sshConfig and sudoPasswordFile, as production
# installations have. Services run as HIVE_SERVICE_USER, the invoking operator's uid:gid.
# Afterwards DIR and every --mount are given back to the invoking operator.
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
die() { printf 'sudo-host: %s\n' "$*" >&2; exit 1; }
scratch='' mounts=() name=''
while (($#)); do
  case $1 in
    --scratch) scratch=$2; shift 2;;
    --mount) mounts+=("$2"); shift 2;;
    --name) name=$2; shift 2;;
    --) shift; break;;
    *) die "Unknown option: $1";;
  esac
done
(($#)) || die 'A command is required'
[[ "$scratch" == /* ]] || die '--scratch needs an absolute directory'
for path in "${mounts[@]}"; do [[ "$path" == /* && -d "$path" ]] || die "--mount needs an existing absolute directory: $path"; done
[[ $(id -u) != 0 ]] || die 'Run as the unprivileged operator; the container provides root'
mkdir -p "$scratch/tmp" "$scratch/home"

# The host's own Docker client and Compose plugin, so the container speaks the daemon's version.
docker_cli=$(readlink -f "$(command -v docker)")
compose=$(docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}' 2>/dev/null)
[[ -x "$docker_cli" && -x "$compose" ]] || die 'The Docker client and its Compose plugin are required'

dockerfile=$(cat <<'EOF'
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server openssh-client sudo jq curl ca-certificates openssl sqlite3 git util-linux procps xz-utils python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash deploy \
    && printf 'deploy ALL=(ALL:ALL) ALL\nDefaults:deploy timestamp_timeout=0\n' > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy \
    && sed -i '/secure_path/d' /etc/sudoers && mkdir -p /run/sshd
EOF
)
image="hive-sudo-host:$(printf '%s' "$dockerfile" | sha256sum | cut -c1-16)"
docker image inspect "$image" >/dev/null 2>&1 || printf '%s\n' "$dockerfile" | docker build --quiet --tag "$image" - >/dev/null

# --name lets a companion process reach the root side with docker exec, for files only root can read.
[[ -n "$name" ]] || name="hive-sudo-host-$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$name" =~ ^hive-sudo-host-[a-z0-9-]{1,40}$ ]] || die '--name must be hive-sudo-host-<lowercase id>'
volumes=(-v /var/run/docker.sock:/var/run/docker.sock -v "$docker_cli:/usr/bin/docker:ro" -v "$compose:/usr/libexec/docker/cli-plugins/docker-compose:ro"
  -v "$root:$root" -v "$scratch:$scratch")
for path in "${mounts[@]}"; do volumes+=(-v "$path:$path"); done
give_back() {
  # Everything the root side wrote becomes the operator's again, so it can be read and removed.
  local path; local -a own=(-v "$scratch:$scratch")
  for path in "${mounts[@]}"; do own+=(-v "$path:$path"); done
  docker run --rm "${own[@]}" --entrypoint chown "$image" -R "$(id -u):$(id -g)" "$scratch" "${mounts[@]}" >/dev/null 2>&1 || true
}
trap give_back EXIT
# The sudo password exists only in this container: a random value, readable by root alone.
status=0
docker run --rm --name "$name" --network host "${volumes[@]}" -w "$PWD" \
  -e HIVE_SUDO_HOST=1 -e "HIVE_SERVICE_USER=$(id -u):$(id -g)" -e "TMPDIR=$scratch/tmp" -e "HOME=$scratch/home" \
  ${HIVE_SUDO_HOST_ENV:+-e "$HIVE_SUDO_HOST_ENV"} \
  --entrypoint bash "$image" -c '
    set -Eeuo pipefail
    umask 077
    password=$(head -c 24 /dev/urandom | base64 | tr -d "/+=" | head -c 24)
    printf "deploy:%s\n" "$password" | chpasswd
    printf "%s\n" "$password" > /run/hive-sudo-password; chmod 600 /run/hive-sudo-password
    unset password
    umask 022
    export HIVE_SUDO_PASSWORD_FILE=/run/hive-sudo-password
    exec "$@"' sudo-host "$@" || status=$?
exit "$status"
