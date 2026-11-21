#!/usr/bin/env bash
# CI runners only: apt-get update and install with a wall-clock bound on each attempt.
# APT's own timeouts only cover an inactive connection, so a mirror that stalls part-way
# through can hold a step until the job's timeout. Each attempt is cut off and retried instead.
#   sudo env GITHUB_ACTIONS=true bash scripts/ci-apt-install.sh PACKAGE...
# HIVE_CI_APT_GET, HIVE_CI_APT_ATTEMPTS, HIVE_CI_APT_UPDATE_SECONDS and HIVE_CI_APT_INSTALL_SECONDS
# are for isolated tests.
set -Eeuo pipefail
die() { printf 'ci-apt-install: %s\n' "$*" >&2; exit 1; }
apt_get=${HIVE_CI_APT_GET:-apt-get}
attempts=${HIVE_CI_APT_ATTEMPTS:-3}
update_seconds=${HIVE_CI_APT_UPDATE_SECONDS:-180}
install_seconds=${HIVE_CI_APT_INSTALL_SECONDS:-300}
if [[ "$apt_get" == apt-get ]]; then
  [[ $(id -u) == 0 && ${GITHUB_ACTIONS:-} == true ]] || die 'System changes require a root GitHub Actions runner'
fi
for value in "$attempts" "$update_seconds" "$install_seconds"; do [[ "$value" =~ ^[1-9][0-9]{0,3}$ ]] || die 'Attempts and timeouts must be positive integers'; done
(( $# > 0 )) || die 'Name at least one package'
for package in "$@"; do [[ "$package" =~ ^[a-z0-9][a-z0-9.+-]*$ ]] || die "Invalid package name: $package"; done
if [[ "$apt_get" == apt-get ]]; then
  apt-config shell retries Acquire::Retries http Acquire::http::Timeout https Acquire::https::Timeout | sed 's/^/ci-apt-install: effective /'
fi
for (( attempt = 1; attempt <= attempts; attempt++ )); do
  if timeout --kill-after=15 "$update_seconds" "$apt_get" update &&
     timeout --kill-after=15 "$install_seconds" "$apt_get" install -y "$@"; then
    exit 0
  fi
  printf 'ci-apt-install: attempt %d of %d failed or exceeded its time limit\n' "$attempt" "$attempts" >&2
done
die "Package installation failed after $attempts attempts"
