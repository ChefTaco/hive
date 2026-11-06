#!/usr/bin/env bash
# Tests scripts/install-prerequisites.sh against stubbed apt, dpkg, Docker and systemd tools.
# Nothing on this machine changes: the apt directory is temporary and every privileged tool is a stub.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/install-prerequisites.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'install-prerequisites test: %s\n' "$*" >&2; exit 1; }
FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

# One fake machine: os-release, an apt directory, a dpkg database and a bin directory of stubs.
machine() {
  local id=$1 version=$2 codename=$3
  box="$temporary/box$((++boxes))"
  mkdir -p "$box/bin" "$box/apt/sources.list.d"
  printf 'ID=%s\nVERSION_ID="%s"\nVERSION_CODENAME=%s\nPRETTY_NAME="%s %s"\n' "$id" "$version" "$codename" "$id" "$version" > "$box/os-release"
  printf 'ca-certificates\n' > "$box/installed"
  : > "$box/log"
  printf '%s\n' "${ARCH:-amd64}" > "$box/arch"
  printf '%s\n' "${KEY_FPR:-$FPR}" > "$box/fpr"
  cat > "$box/bin/dpkg" <<EOF
#!/usr/bin/env bash
[[ "\$1" == --print-architecture ]] && cat "$box/arch"
EOF
  cat > "$box/bin/dpkg-query" <<EOF
#!/usr/bin/env bash
grep -qx -- "\${@: -1}" "$box/installed" && printf installed || exit 1
EOF
  cat > "$box/bin/apt-get" <<EOF
#!/usr/bin/env bash
printf 'apt-get %s\n' "\$*" >> "$box/log"
case "\$1" in
  install) for p in "\$@"; do [[ "\$p" == -* || "\$p" == install ]] || printf '%s\n' "\$p" >> "$box/installed"; done
    if grep -qx docker-ce-cli "$box/installed"; then cp "$box/docker.stub" "$box/bin/docker"; fi;;
  remove) for p in "\$@"; do grep -vx -- "\$p" "$box/installed" > "$box/installed.new" || true; mv "$box/installed.new" "$box/installed"; done
    rm -f "$box/bin/docker";;
esac
EOF
  cat > "$box/docker.stub" <<EOF
#!/usr/bin/env bash
case "\$*" in
  'compose version'*) grep -qxE 'docker-compose-plugin|docker-compose-v2' "$box/installed" || exit 1; echo 2.40.0;;
  'version'*) echo 28.5.0;;
  'info'*) [[ -f "$box/daemon" ]] || exit 1;;
esac
EOF
  cat > "$box/bin/systemctl" <<EOF
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >> "$box/log"
case "\$1" in enable) touch "$box/daemon";; is-active|is-enabled) [[ -f "$box/daemon" ]];; esac
EOF
  cat > "$box/bin/usermod" <<EOF
#!/usr/bin/env bash
printf 'usermod %s\n' "\$*" >> "$box/log"; touch "$box/grouped"
EOF
  # Root for the script, the caller's real identity otherwise; the docker group follows usermod.
  cat > "$box/bin/id" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == -u ]]; then echo 0; exit; fi
if [[ "\$1" == -nG ]]; then echo users; [[ -f "$box/grouped" ]] && echo docker; exit 0; fi
exec $(command -v id) "\$@"
EOF
  cat > "$box/bin/snap" <<EOF
#!/usr/bin/env bash
[[ -f "$box/snap-docker" ]]
EOF
  cat > "$box/bin/curl" <<EOF
#!/usr/bin/env bash
printf 'curl %s\n' "\$*" >> "$box/log"
while (( \$# )); do [[ "\$1" == -o ]] && { printf 'FAKE KEY\n' > "\$2"; shift; }; shift; done
EOF
  cat > "$box/bin/gpg" <<EOF
#!/usr/bin/env bash
printf 'pub:-:4096:1:8D81803C0EBFCD88:::::\nfpr:::::::::%s:\n' "\$(cat "$box/fpr")"
EOF
  cat > "$box/bin/runuser" <<EOF
#!/usr/bin/env bash
shift 3; exec "\$@"
EOF
  chmod +x "$box"/bin/* "$box/docker.stub"
}
boxes=0
# Only these real tools are visible, so the machine's own Docker, snap or ufw never leak in.
mkdir -p "$temporary/system"
for tool in bash env cat grep sed awk tr cut head tail wc stat realpath mktemp install chmod chown mv rm cp touch \
  mkdir dirname sort df timeout base64 sha256sum find cmp tar gzip flock ss jq openssl git ssh; do
  path=$(command -v "$tool") || fail "test needs $tool"
  ln -s "$path" "$temporary/system/$tool"
done
run() {
  env PATH="$box/bin:$temporary/system" SUDO_USER="$(id -un)" HIVE_PREREQ_OS_RELEASE="$box/os-release" HIVE_PREREQ_APT_DIR="$box/apt" \
    bash "$SCRIPT" "$@" > "$box/out" 2>&1
}
expect() { grep -qF -- "$1" "$box/out" || { cat "$box/out" >&2; fail "expected output: $1"; }; }
logged() { grep -qF -- "$1" "$box/log" || { cat "$box/log" >&2; fail "expected call: $1"; }; }

# Fresh Ubuntu 24.04: the plan lists every change, applying it writes Docker's repository and installs.
machine ubuntu 24.04 noble
run --dry-run || fail 'dry-run failed'
expect "Add Docker's apt repository (ubuntu noble, stable)"
expect 'Install Docker packages: docker-ce docker-ce-cli containerd.io docker-compose-plugin'
expect "Add $(id -un) to the docker group"
[[ ! -s "$box/log" ]] || fail 'dry-run changed something'
run --check && fail '--check passed without Docker'
expect 'missing: Docker Engine with the Compose plugin'
run --yes --directory "$box/opt/hive" || { cat "$box/out" >&2; fail 'apply failed'; }
grep -qx 'Suites: noble' "$box/apt/sources.list.d/docker.sources" || fail 'wrong suite'
grep -qx 'URIs: https://download.docker.com/linux/ubuntu' "$box/apt/sources.list.d/docker.sources" || fail 'wrong repository'
grep -qx "Signed-By: $box/apt/keyrings/docker.asc" "$box/apt/sources.list.d/docker.sources" || fail 'wrong keyring'
[[ $(stat -c %a "$box/apt/keyrings/docker.asc") == 644 ]] || fail 'keyring mode'
logged 'apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin'
logged 'curl -fsSL --proto =https --tlsv1.2 https://download.docker.com/linux/ubuntu/gpg'
logged "usermod -aG docker $(id -un)"
[[ -d "$box/opt/hive" && $(stat -c %a "$box/opt/hive") == 750 ]] || fail 'installation directory'
if [[ -d /run/systemd/system ]]; then logged 'systemctl enable --now docker.service containerd.service'; fi
expect 'compose    2.40.0'

# Re-running changes nothing.
: > "$box/log"
run --yes || { cat "$box/out" >&2; fail 'rerun failed'; }
expect 'Nothing to change'
grep -q 'apt-get install\|usermod\|curl' "$box/log" && fail 'rerun changed something'
run --check || { cat "$box/out" >&2; fail '--check failed after install'; }
expect 'Ready'

# Debian 12 uses Docker's Debian repository; a key with another fingerprint is refused.
KEY_FPR=0000000000000000000000000000000000000000 machine debian 12 bookworm
run --yes && fail 'a wrong signing key was accepted'
expect 'did not match fingerprint'
[[ ! -e "$box/apt/sources.list.d/docker.sources" ]] || fail 'repository written despite a wrong key'
machine debian 12 bookworm
run --yes --no-docker-group || { cat "$box/out" >&2; fail 'Debian apply failed'; }
grep -qx 'URIs: https://download.docker.com/linux/debian' "$box/apt/sources.list.d/docker.sources" || fail 'Debian repository'
grep -qx 'Suites: bookworm' "$box/apt/sources.list.d/docker.sources" || fail 'Debian suite'
grep -q usermod "$box/log" && fail '--no-docker-group changed groups'

# An existing repository file is reused rather than duplicated.
machine ubuntu 22.04 jammy
printf 'deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable\n' > "$box/apt/sources.list.d/docker.list"
run --yes || { cat "$box/out" >&2; fail 'apply with an existing repository failed'; }
[[ ! -e "$box/apt/sources.list.d/docker.sources" ]] || fail 'duplicated the Docker repository'

# Unsupported systems and architectures are refused before anything changes.
machine fedora 41 none
run --dry-run && fail 'accepted Fedora'
expect 'unsupported distribution'
ARCH=armhf machine ubuntu 24.04 noble
run --dry-run && fail 'accepted armhf'
expect 'unsupported architecture: armhf'

# Docker from a snap is refused; docker.io without Compose needs --replace-conflicting.
machine ubuntu 24.04 noble
touch "$box/snap-docker"
run --dry-run && fail 'accepted snap Docker'
expect 'installed as a snap'
machine ubuntu 24.04 noble
printf 'docker.io\ncontainerd\nrunc\n' >> "$box/installed"; cp "$box/docker.stub" "$box/bin/docker"
run --yes && fail 'replaced docker.io without consent'
expect '--replace-conflicting'
[[ ! -s "$box/log" ]] || fail 'changed something before refusing'
run --yes --replace-conflicting || { cat "$box/out" >&2; fail 'replacement failed'; }
logged 'apt-get remove -y docker.io containerd runc'
logged 'apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin'

# docker.io that already has Compose is kept, with a warning.
machine ubuntu 24.04 noble
printf 'docker.io\ndocker-compose-v2\n' >> "$box/installed"; cp "$box/docker.stub" "$box/bin/docker"; touch "$box/daemon" "$box/grouped"
run --yes || { cat "$box/out" >&2; fail 'existing docker.io with Compose was not accepted'; }
expect 'Keeping the existing Docker Engine (docker.io)'
grep -q 'apt-get install' "$box/log" && fail 'reinstalled Docker over docker.io'

# A controller needs no Docker at all.
machine ubuntu 24.04 noble
run --controller --check || { cat "$box/out" >&2; fail 'controller check failed'; }
expect 'Controller: ubuntu 24.04'
grep -q docker "$box/out" && fail 'controller mode reported Docker'

# Options are validated.
machine ubuntu 24.04 noble
run --directory relative/path && fail 'accepted a relative directory'
run --bogus && fail 'accepted an unknown option'
printf 'install-prerequisites tests passed\n'
