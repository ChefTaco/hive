#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
fixture="$temporary/runner"
mkdir -p "$fixture/etc/apt/apt.conf.d" "$fixture/etc/apt/sources.list.d"
cat > "$fixture/etc/apt/apt-mirrors.txt" <<'EOF'
http://azure.archive.ubuntu.com/ubuntu priority:1
http://azure.archive.ubuntu.com/ubuntu/
https://archive.ubuntu.com/ubuntu priority:2
http://mirror.example.com/ubuntu
http://azureXarchiveXubuntuXcom/ubuntu
http://azure.archive.ubuntu.com/ubuntuextra
EOF
printf 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' > "$fixture/etc/apt/sources.list.d/ubuntu.sources"
before=$(sha256sum "$fixture/etc/apt/sources.list.d/ubuntu.sources")
run() { HIVE_CI_APT_ROOT="$fixture" bash "$root/scripts/ci-apt-setup.sh"; }
run
mirrors="$fixture/etc/apt/apt-mirrors.txt"
grep -qxF 'https://archive.ubuntu.com/ubuntu priority:1' "$mirrors" || fail 'Priority was lost'
grep -qxF 'https://archive.ubuntu.com/ubuntu/' "$mirrors" || fail 'Trailing slash was lost'
for unchanged in 'https://archive.ubuntu.com/ubuntu priority:2' 'http://mirror.example.com/ubuntu' 'http://azureXarchiveXubuntuXcom/ubuntu' 'http://azure.archive.ubuntu.com/ubuntuextra'; do
  grep -qxF "$unchanged" "$mirrors" || fail 'An unrelated mirror was rewritten'
done
[[ $(sha256sum "$fixture/etc/apt/sources.list.d/ubuntu.sources") == "$before" ]] || fail 'Distribution signing keys were changed'
[[ $(grep -cxF $'https://mirrors.kernel.org/ubuntu\tpriority:0' "$mirrors") == 1 ]] || fail 'Independent authenticated mirror is absent or duplicated'
config="$fixture/etc/apt/apt.conf.d/zz-hive-ci-network"
# A runner-provided setting must not override ours: APT reads the parts in byte order.
printf 'Acquire::Retries "1";\nAcquire::https::Timeout "15";\n' > "$fixture/etc/apt/apt.conf.d/99timeout"
printf 'Dir::Etc::Parts "%s";\n' "$fixture/etc/apt/apt.conf.d" > "$temporary/apt-main.conf"
[[ $(APT_CONFIG="$temporary/apt-main.conf" apt-config shell R Acquire::Retries T Acquire::https::Timeout) == $'R=\'3\'\nT=\'30\'' ]] || fail 'A runner-provided APT setting overrides the CI settings'
rm "$fixture/etc/apt/apt.conf.d/99timeout"
[[ $(stat -c %a "$config") == 644 ]] || fail 'APT sandbox cannot read the configuration'
apt-config -c "$config" dump > "$temporary/parsed-apt-config"
grep -qxF 'Acquire::Retries "3";' "$temporary/parsed-apt-config" || fail 'Retry configuration was not accepted by APT'
grep -qxF 'Acquire::https::Timeout "30";' "$temporary/parsed-apt-config" || fail 'HTTPS inactivity timeout was not accepted by APT'
grep -qxF 'APT::Update::Error-Mode "any";' "$temporary/parsed-apt-config" || fail 'Partial-index failures were not made fatal'
sha=$(sha256sum "$config" "$mirrors")
run
[[ $(sha256sum "$config" "$mirrors") == "$sha" ]] || fail 'Repeated setup changed the configuration'
printf 'https://mirror.example.com/ubuntu priority:1\n' > "$mirrors"
custom=$(sha256sum "$mirrors")
run
[[ $(sha256sum "$mirrors") == "$custom" ]] || fail 'A custom non-Ubuntu mirror list was changed'
rm "$mirrors"
run
[[ ! -e "$mirrors" ]] || fail 'A mirror list was invented for a different distribution layout'
sources="$fixture/etc/apt/sources.list.d/ubuntu.sources"
ports="$fixture/etc/apt/hive-ci-ports-mirrors.txt"
cat > "$sources" <<'PORTS'
Types: deb
URIs: http://ports.ubuntu.com/ubuntu-ports/
Suites: noble noble-updates noble-security
Components: main universe
Architectures: arm64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
PORTS
sed 's#http://ports.ubuntu.com/ubuntu-ports/#mirror+file:/etc/apt/hive-ci-ports-mirrors.txt#' "$sources" > "$temporary/expected-sources"
run
cmp "$sources" "$temporary/expected-sources" || fail 'Ports source metadata or signing key changed'
grep -qxF $'https://mirrors.mit.edu/ubuntu-ports\tpriority:0' "$ports" || fail 'The ports HTTPS mirror is absent'
grep -qxF $'https://ports.ubuntu.com/ubuntu-ports\tpriority:1' "$ports" || fail 'The original ports fallback is absent'
[[ $(stat -c %a "$ports") == 644 ]] || fail 'APT cannot read the ports mirror list'
ports_sha=$(sha256sum "$sources" "$ports")
run
[[ $(sha256sum "$sources" "$ports") == "$ports_sha" ]] || fail 'Ports setup is not repeatable'
printf 'outside\n' > "$temporary/outside"
rm "$ports"; ln -s "$temporary/outside" "$ports"
if run >/dev/null 2>&1; then fail 'A ports mirror symlink was accepted'; fi
[[ $(cat "$temporary/outside") == outside ]] || fail 'A ports mirror symlink target changed'
rm "$ports"; run
mv "$sources" "$temporary/sources"; ln -s "$temporary/outside" "$sources"
if run >/dev/null 2>&1; then fail 'An Ubuntu source symlink was accepted'; fi
rm "$sources"; mv "$temporary/sources" "$sources"
printf 'outside\n' > "$temporary/outside"
rm -f "$mirrors"; ln -s "$temporary/outside" "$mirrors"
if run >/dev/null 2>&1; then fail 'A mirror symlink was accepted'; fi
[[ $(cat "$temporary/outside") == outside ]] || fail 'A symlink target was modified'
rm "$mirrors" "$config"; ln -s "$temporary/outside" "$config"
if run >/dev/null 2>&1; then fail 'A configuration symlink was accepted'; fi
if HIVE_CI_APT_ROOT=/ GITHUB_ACTIONS=false bash "$root/scripts/ci-apt-setup.sh" >/dev/null 2>&1; then fail 'System configuration was changed outside CI'; fi
install() { HIVE_CI_APT_GET="$temporary/apt-get" HIVE_CI_APT_UPDATE_SECONDS=2 HIVE_CI_APT_INSTALL_SECONDS=2 bash "$root/scripts/ci-apt-install.sh" "$@"; }
cat > "$temporary/apt-get" <<'STUB'
#!/usr/bin/env bash
log="$(dirname "$0")/apt-calls"
printf '%s\n' "$*" >> "$log"
# The first update stalls past its limit, as a hung mirror does; later calls succeed.
if [[ $1 == update && $(grep -c '^update' "$log") == 1 ]]; then exec sleep 30; fi
exit 0
STUB
chmod 700 "$temporary/apt-get"
started=$SECONDS
install ripgrep redis-server 2>"$temporary/install-errors" || fail 'A stalled first attempt was not retried'
(( SECONDS - started < 20 )) || fail 'A stalled apt-get was not cut off'
[[ $(cat "$temporary/apt-calls") == $'update\nupdate\ninstall -y ripgrep redis-server' ]] || fail 'Unexpected apt-get calls'
grep -qF 'attempt 1 of 3 failed or exceeded its time limit' "$temporary/install-errors" || fail 'The cut-off attempt was not reported'
printf '#!/usr/bin/env bash\nexit 100\n' > "$temporary/apt-get"
if install jq 2>"$temporary/install-errors"; then fail 'Repeated apt-get failures were accepted'; fi
grep -qF 'failed after 3 attempts' "$temporary/install-errors" || fail 'The final failure was not reported'
if install 'jq;rm' >/dev/null 2>&1; then fail 'An invalid package name was accepted'; fi
if install >/dev/null 2>&1; then fail 'An empty package list was accepted'; fi
if GITHUB_ACTIONS=false bash "$root/scripts/ci-apt-install.sh" jq >/dev/null 2>&1; then fail 'Packages were installed outside CI'; fi
printf 'Passed: bounded authenticated APT setup read after the runner settings, time-limited retried installs, independent Ubuntu mirror fallback, custom-source and signing-key preservation, repeatability and symlink refusal.\n'
