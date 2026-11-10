#!/usr/bin/env bash
# CI runners only. Keep package authentication intact while avoiding a stalled regional
# HTTP mirror and bounding inactive downloads. HIVE_CI_APT_ROOT is for isolated tests.
set -Eeuo pipefail
root=${HIVE_CI_APT_ROOT:-/}
die() { printf 'ci-apt-setup: %s\n' "$*" >&2; exit 1; }
if [[ "$root" == / ]]; then
  [[ $(id -u) == 0 && ${GITHUB_ACTIONS:-} == true ]] || die 'System changes require a root GitHub Actions runner'
else
  [[ "$root" == /* && "$root" == "$(realpath -m -- "$root")" && -d "$root" && ! -L "$root" ]] || die 'Test root must be a canonical directory'
fi
apt="${root%/}/etc/apt"
for directory in "${root%/}/etc" "$apt" "$apt/apt.conf.d"; do
  [[ -d "$directory" && ! -L "$directory" ]] || die 'Expected a regular APT configuration directory'
done
config="$apt/apt.conf.d/99hive-ci-network"
mirrors="$apt/apt-mirrors.txt"
for file in "$config" "$mirrors"; do
  [[ ! -L "$file" && ( ! -e "$file" || -f "$file" ) ]] || die 'Refusing a non-regular configuration file'
done
cat > "$config" <<'EOF'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT::Update::Error-Mode "any";
EOF
chmod 0644 "$config"
if [[ -f "$mirrors" ]]; then
  # This is the official HTTPS fallback already present in the hosted runner's list.
  # Retain priority attributes, other mirrors and all distribution signing-key settings.
  sed -E -i 's#^http://azure\.archive\.ubuntu\.com/ubuntu(/?)([[:space:]].*)?$#https://archive.ubuntu.com/ubuntu\1\2#' "$mirrors"
fi
