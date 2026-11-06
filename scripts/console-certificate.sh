#!/usr/bin/env bash
# Gets, checks and renews the console HTTPS certificate of a Hive installation.
#
#   sudo ./scripts/console-certificate.sh tailscale [--dir DIR] [--owner USER] [--name NAME]
#       Issue (or refresh) a certificate for this host's Tailscale MagicDNS name with
#       `tailscale cert`, into DIR/console.crt and DIR/console.key (default DIR: /etc/hive/tls).
#       USER (default: the sudo caller) owns both files, so it can run hive.sh; the key is 0600.
#   ./scripts/console-certificate.sh check --cert FILE --key FILE [--name NAME]
#       Check a certificate and key the way hive.sh does before it uses them.
#   sudo ./scripts/console-certificate.sh renew --config FILE [--hive DIR] [--no-tailscale]
#       After installation: refresh the Tailscale certificate at the configured paths (skipped
#       with --no-tailscale, for a certificate you renew some other way), then run
#       `hive.sh tls-refresh`, which installs it into the ingress and restarts only the ingress
#       when it changed. It runs as the account that owns FILE.
#   sudo ./scripts/console-certificate.sh schedule --config FILE [--hive DIR] [--no-tailscale]
#       Run `renew` weekly from a systemd timer (hive-console-certificate.timer). Re-run it from
#       the new checkout after each upgrade; `systemctl disable --now
#       hive-console-certificate.timer` stops it.
#
# FILE is the installation JSON that `./hive.sh` setup wrote (for example
# ~/.config/hive/ID/installation.json). DIR is the release checkout whose hive.sh runs the
# refresh (default: the checkout this script is in). Run renew and schedule on the console host.
set -Eeuo pipefail
umask 077

die() { printf 'console-certificate: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

command=${1:-}; [[ -n "$command" ]] || { usage >&2; exit 2; }; shift
dir=/etc/hive/tls owner=${SUDO_USER:-} name='' cert='' key='' config='' use_tailscale=true hive=''
while (($#)); do
  case "$1" in
    --dir) dir=${2:?--dir needs a value}; shift;;
    --owner) owner=${2:?--owner needs a value}; shift;;
    --name) name=${2:?--name needs a value}; shift;;
    --cert) cert=${2:?--cert needs a value}; shift;;
    --key) key=${2:?--key needs a value}; shift;;
    --config) config=${2:?--config needs a value}; shift;;
    --hive) hive=${2:?--hive needs a value}; shift;;
    --no-tailscale) use_tailscale=false;;
    -h|--help) usage; exit 0;;
    *) die "unknown option: $1";;
  esac
  shift
done
for tool in openssl jq sha256sum; do command -v "$tool" >/dev/null || die "required tool missing: $tool (run scripts/install-prerequisites.sh)"; done

# The same checks as the installer: regular canonical files, an owner-only key, the
# name on the certificate, at least one day of validity, and a matching key pair.
check_pair() {
  local certificate=$1 private_key=$2 hostname=$3 path
  for path in "$certificate" "$private_key"; do
    [[ "$path" == /* ]] || die "$path: use an absolute path"
    [[ -f "$path" && ! -L "$path" ]] || die "$path: not a regular file (symlinks are refused)"
    [[ "$path" == "$(realpath -m -- "$path")" ]] || die "$path: the path must not go through a symlink"
    [[ -r "$path" ]] || die "$path: not readable by $(id -un)"
  done
  (( (8#$(stat -c %a "$private_key") & 077) == 0 )) || die "$private_key: the key must be owner-only (chmod 600)"
  openssl x509 -in "$certificate" -noout >/dev/null 2>&1 || die "$certificate: not a PEM certificate"
  if [[ -n "$hostname" ]]; then
    openssl x509 -in "$certificate" -noout -checkhost "$hostname" | grep -q 'does match' || die "$certificate: not valid for $hostname"
  fi
  openssl x509 -in "$certificate" -noout -checkend 86400 >/dev/null || die "$certificate: expires within one day"
  [[ $(openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum) == \
     "$(openssl pkey -in "$private_key" -pubout -outform DER 2>/dev/null | sha256sum)" ]] || die "$certificate and $private_key are not a key pair"
}
expiry() { openssl x509 -in "$1" -noout -enddate | cut -d= -f2; }
need_root() { [[ $(id -u) == 0 ]] || die "$command needs root: run it with sudo"; }
resolve_owner() {
  [[ -n "$owner" ]] || die 'name the account that runs hive.sh with --owner USER'
  id "$owner" >/dev/null 2>&1 || die "unknown account: $owner"
}

tailscale_name() {
  command -v tailscale >/dev/null || die 'tailscale is not installed; see https://tailscale.com/download, or bring your own certificate'
  local status
  status=$(tailscale status --json 2>/dev/null) || die 'tailscale is not running or not logged in (tailscale up)'
  jq -e '(.CertDomains // [])|length>0' <<< "$status" >/dev/null || die 'HTTPS certificates are off for this tailnet. Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console (DNS page), then retry.'
  jq -r '.Self.DNSName|sub("\\.$";"")' <<< "$status"
}

# Writes a fresh Tailscale certificate for $name to $1/$2, owned by $owner. Prints "changed" when
# the files differ from what was there. tailscale returns its cached certificate until renewal is due.
tailscale_issue() {
  local certificate=$1 private_key=$2 work group
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' RETURN
  tailscale cert --cert-file "$work/console.crt" --key-file "$work/console.key" "$name" >&2 || die "tailscale cert failed for $name"
  group=$(id -gn "$owner")
  install -d -m 0750 -o "$owner" -g "$group" "$(dirname "$certificate")"
  if [[ -f "$certificate" && -f "$private_key" ]] && cmp -s "$work/console.crt" "$certificate" && cmp -s "$work/console.key" "$private_key"; then
    chown "$owner:$group" "$certificate" "$private_key"; chmod 0644 "$certificate"; chmod 0600 "$private_key"
    return 0
  fi
  install -m 0600 -o "$owner" -g "$group" "$work/console.key" "$private_key.new"
  install -m 0644 -o "$owner" -g "$group" "$work/console.crt" "$certificate.new"
  mv -f -- "$private_key.new" "$private_key"; mv -f -- "$certificate.new" "$certificate"
  printf 'changed\n'
}

installation() {
  [[ -n "$config" && -f "$config" ]] || die 'name the installation JSON with --config FILE'
  config=$(realpath -- "$config")
  jq -e '.console.host and .bootstrap.certificateFile and .bootstrap.privateKeyFile and .origin' "$config" >/dev/null ||
    die "$config: not a fresh installation with a console (needs console, origin and bootstrap certificate files)"
  [[ $(jq -r '.hosts[.console.host].target' "$config") == local ]] ||
    die 'the console host is reached over SSH; run this script on the console host with a copy of the installation JSON whose console host target is local'
  source_certificate=$(jq -r .bootstrap.certificateFile "$config")
  source_key=$(jq -r .bootstrap.privateKeyFile "$config")
  hostname=$(jq -r '.origin|sub("^https://";"")|split(":")[0]' "$config")
}

# The release checkout whose hive.sh installs the certificate: --hive, or the one holding this script.
release_checkout() {
  [[ -n "$hive" ]] || hive=$(dirname -- "$(dirname -- "$(realpath -- "$0")")")
  hive=$(realpath -- "$hive")
  [[ -x "$hive/hive.sh" && -f "$hive/scripts/console-certificate.sh" ]] || die "$hive is not a Hive release checkout: pass --hive DIR"
  grep -q 'tls-refresh' "$hive/scripts/suite/controller.sh" || die "$hive has no hive.sh tls-refresh: use the checkout of release 2.0.2 or later"
}

case "$command" in
  tailscale)
    need_root; resolve_owner
    [[ -n "$name" ]] || name=$(tailscale_name)
    [[ "$dir" == /* && "$dir" == "$(realpath -m -- "$dir")" ]] || die "$dir: use an absolute path without symlinks"
    result=$(tailscale_issue "$dir/console.crt" "$dir/console.key")
    check_pair "$dir/console.crt" "$dir/console.key" "$name"
    say "Certificate for $name ${result:+(new) }valid until $(expiry "$dir/console.crt"), owned by $owner:"
    say "  certificate: $dir/console.crt"
    say "  private key: $dir/console.key"
    say "Give these paths to ./hive.sh, and use https://$name as the console origin."
    say 'Tailscale certificates last 90 days. After installing, keep it current with:'
    say "  sudo $(realpath -- "$0") schedule --config FILE";;
  check)
    [[ -n "$cert" && -n "$key" ]] || die 'check needs --cert FILE and --key FILE'
    check_pair "$cert" "$key" "$name"
    say "OK: $cert${name:+ is valid for $name,} matches $key and is valid until $(expiry "$cert").";;
  renew)
    need_root; installation; release_checkout
    account=$(stat -c %U "$config")
    if [[ "$use_tailscale" == true ]]; then
      [[ -n "$owner" ]] || owner=$(stat -c %U "$source_key")
      resolve_owner; name=$hostname
      tailscale_issue "$source_certificate" "$source_key" >/dev/null
    fi
    check_pair "$source_certificate" "$source_key" "$hostname"
    # hive.sh keeps the installation's protected files owned by the account that installed it.
    if [[ "$account" == root ]]; then "$hive/hive.sh" tls-refresh --config "$config"
    else runuser -u "$account" -- "$hive/hive.sh" tls-refresh --config "$config"; fi;;
  schedule)
    need_root; installation; release_checkout
    command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || die 'systemd is not running; schedule renew with your own scheduler instead'
    if [[ "$use_tailscale" == true && -z "$owner" ]]; then owner=$(stat -c %U "$source_key"); fi
    flags=" --hive $hive"; [[ "$use_tailscale" == true ]] && flags+=" --owner $owner" || flags+=' --no-tailscale'
    printf '[Unit]\nDescription=Renew the Hive console certificate\nAfter=network-online.target docker.service tailscaled.service\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart=%s renew --config %s%s\n' \
      "$hive/scripts/console-certificate.sh" "$config" "$flags" > /etc/systemd/system/hive-console-certificate.service
    printf '[Unit]\nDescription=Renew the Hive console certificate weekly\n\n[Timer]\nOnCalendar=weekly\nRandomizedDelaySec=6h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' \
      > /etc/systemd/system/hive-console-certificate.timer
    chmod 0644 /etc/systemd/system/hive-console-certificate.service /etc/systemd/system/hive-console-certificate.timer
    systemctl daemon-reload
    systemctl enable --now hive-console-certificate.timer >/dev/null
    say "Scheduled: hive-console-certificate.timer runs renew weekly with $hive/hive.sh."
    say "  next run: $(systemctl show hive-console-certificate.timer --property=NextElapseUSecRealtime --value)"
    say '  run now:  sudo systemctl start hive-console-certificate.service'
    say '  logs:     journalctl -u hive-console-certificate.service'
    say 'After upgrading to a new release, run schedule again from its checkout.';;
  *) usage >&2; exit 2;;
esac
