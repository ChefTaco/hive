#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/console-certificate-service.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
fail() { printf 'certificate service test: %s\n' "$*" >&2; exit 1; }
owner=$(id -u)
unit="$work/renewal.service" config="$work/installation.json"
old=/opt/hive-releases/2.4.1 new=/opt/hive-releases/2.4.2
plan() { hive_certificate_service_plan "$unit" "$config" "$new" "$owner"; }
refused() { local status=0; plan > "$work/planned" || status=$?; [[ "$status" == "$1" ]] || fail "expected status $1, got $status"; }
refused 10
for flags in ' --owner deploy' ' --no-tailscale'; do
  hive_certificate_service_text "$old" "$config" "$flags" > "$unit"
  chmod 0644 "$unit"
  before=$(sha256sum "$unit")
  plan > "$work/planned" || fail 'legacy managed unit refused'
  cmp -s "$work/planned" <(hive_certificate_service_text "$new" "$config" "$flags") || fail 'renewal options were not retained'
  [[ $(sha256sum "$unit") == "$before" ]] || fail 'planning changed the service'
  hive_certificate_service_plan "$unit" /opt/other/installation.json "$new" "$owner" > "$work/other" && fail 'another installation was selected'
  [[ ! -s "$work/other" ]] || fail 'another installation produced replacement content'
  hive_certificate_service_text "$new" "$config" "$flags" > "$unit"
  cmp -s "$unit" <(plan) || fail 'same-release repeat is not a no-op'
done
hive_certificate_service_text "$old" "$config" ' --owner deploy' > "$unit"
mkdir "$unit.d"; refused 20; rmdir "$unit.d"
printf 'Environment=CUSTOM_OPTION=example\n' >> "$unit"
refused 20
hive_certificate_service_text "$old" "$config" ' --owner deploy' > "$unit"
printf '\n' >> "$unit"
refused 20
hive_certificate_service_text "$old" "$config" ' --owner deploy' > "$unit"
chmod 0664 "$unit"; refused 20; chmod 0644 "$unit"
hive_certificate_service_plan "$unit" "$config" "$new" "$((owner+1))" >/dev/null && fail 'wrong ownership was accepted'
mv "$unit" "$work/original"; ln -s "$work/original" "$unit"; refused 20
rm "$unit"; ln -s /dev/null "$unit"; refused 20
rm "$unit"; mkdir "$unit"; refused 20

# Exercise the real upgrade hook without writing system service files or using sudo.
# Only fixture ownership is stubbed; the pure planner above checks real ownership.
rmdir "$unit"
mkdir "$work/bin"
stat_binary=$(command -v stat)
cat > "$work/bin/stat" <<EOF
#!/usr/bin/env bash
if [[ \$1 == -c && \$2 == %u && \$3 == "$unit" ]]; then echo 0; else exec "$stat_binary" "\$@"; fi
EOF
cat > "$work/bin/systemctl" <<EOF
#!/usr/bin/env bash
case \$(cat "$work/systemctl-mode") in fail) exit 1;; custom) echo /etc/systemd/system/example.conf;; esac
EOF
chmod +x "$work/bin/"*
printf 'normal\n' > "$work/systemctl-mode"
(
  export PATH="$work/bin:$PATH"
  source "$ROOT/scripts/suite/controller.sh"
  source "$ROOT/scripts/suite/guided-setup.sh"
  HIVE_ROOT=$ROOT HIVE_CONFIG=$config HIVE_VERSION=2.4.2
  unset HIVE_REGISTRY_ORIGINAL_CONFIG
  selected=2.4.2
  hive_checkout_release() { printf '%s\n' "$selected"; }
  hive_setup_sudo() { printf '%s\n' "$*" >> "$work/sudo.log"; }
  printf '{"bootstrap":{},"console":{"host":"control"},"hosts":{"control":{"target":"local"}}}\n' > "$config"
  hive_setup_refresh_certificate "$unit"
  [[ ! -e "$work/sudo.log" ]] || fail 'absent service requested sudo'
  hive_certificate_service_text "$old" "$config" ' --owner deploy' > "$unit"; chmod 0644 "$unit"
  hive_setup_refresh_certificate "$unit"
  grep -qF -- '--refresh-existing' "$work/sudo.log" || fail 'upgrade did not request the guarded refresh'
  rm "$work/sudo.log"
  for mode in custom fail; do
    printf '%s\n' "$mode" > "$work/systemctl-mode"
    hive_setup_refresh_certificate "$unit" 2> "$work/refusal"
    [[ ! -e "$work/sudo.log" && -s "$work/refusal" ]] || fail 'unknown or custom overrides requested sudo'
  done
  printf 'normal\n' > "$work/systemctl-mode"
  selected=2.4.1
  hive_setup_refresh_certificate "$unit" 2> "$work/refusal"
  [[ ! -e "$work/sudo.log" && -s "$work/refusal" ]] || fail 'a different checkout was scheduled'
  selected=2.4.2
  hive_certificate_service_text "$ROOT" "$config" ' --owner deploy' > "$unit"
  hive_setup_refresh_certificate "$unit"
  [[ ! -e "$work/sudo.log" ]] || fail 'repeat requested sudo'
  # The configured credential is validated by the real transport helper and sent
  # on stdin, so unattended upgrades do not fall back to a terminal prompt.
  hive_certificate_service_text "$old" "$config" ' --owner deploy' > "$unit"
  printf 'obviously-fake-sudo-password\n' > "$work/password"; chmod 0600 "$work/password"
  jq --arg file "$work/password" '.hosts.control.sudoPasswordFile=$file' "$config" > "$work/config.new"; mv "$work/config.new" "$config"
  cat > "$work/bin/sudo" <<EOF
#!/usr/bin/env bash
set -euo pipefail
IFS= read -r password
[[ \$password == obviously-fake-sudo-password ]]
printf '%s\\n' "\$*" >> "$work/sudo.log"
EOF
  chmod +x "$work/bin/sudo"
  hive_setup_refresh_certificate "$unit"
  grep -qF -- '-k -S -p' "$work/sudo.log" || fail 'configured sudo file was not used'
  ! grep -qF 'obviously-fake-sudo-password' "$work/sudo.log" || fail 'password entered arguments'
  rm "$work/sudo.log"
  chmod 0644 "$work/password"
  ( hive_setup_refresh_certificate "$unit" ) > "$work/unsafe" 2>&1 && fail 'group-readable sudo credential was accepted'
  [[ ! -e "$work/sudo.log" ]] || fail 'unsafe credential reached sudo'
)
printf 'Passed: legacy service rebind, both renewal modes, repeat no-op, isolation, customizations, ownership, modes and symlink refusal.\n'
