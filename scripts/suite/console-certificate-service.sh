#!/usr/bin/env bash
# Plan an update only for the exact service template installed by Hive. Return 10
# for an absent/other installation and 20 for an unsafe or customized service.
# The optional owner argument lets unprivileged tests exercise real fixture files;
# production callers always require root ownership.
hive_certificate_service_plan() {
  local file=$1 config=$2 hive=$3 expected_owner=${4:-0} line previous flags actual
  local -a arguments=()
  [[ -e "$file" || -L "$file" ]] || return 10
  [[ -f "$file" && ! -L "$file" && $(stat -c %u "$file") == "$expected_owner" && $(stat -c %a "$file") == 644 && $(stat -c %s "$file") -lt 8192 ]] || return 20
  [[ ! -e "$file.d" && ! -L "$file.d" ]] || return 20
  line=$(sed -n 's/^ExecStart=//p' "$file")
  read -r -a arguments <<< "$line"
  [[ ${#arguments[@]} == 7 || ${#arguments[@]} == 8 ]] || return 20
  [[ ${arguments[1]} == renew && ${arguments[2]} == --config && ${arguments[4]} == --hive ]] || return 20
  [[ ${arguments[3]} == "$config" ]] || return 10
  previous=${arguments[5]}
  [[ ${arguments[0]} == "$previous/scripts/console-certificate.sh" ]] || return 20
  # These paths are embedded in systemd's ExecStart, not interpreted by a shell.
  [[ "$previous" =~ ^/[A-Za-z0-9_./+-]+$ && "$config" =~ ^/[A-Za-z0-9_./+-]+$ && "$hive" =~ ^/[A-Za-z0-9_./+-]+$ ]] || return 20
  if [[ ${#arguments[@]} == 8 && ${arguments[6]} == --owner && ${arguments[7]} =~ ^[a-z_][a-z0-9_-]*[$]?$ ]]; then
    flags=" --owner ${arguments[7]}"
  elif [[ ${#arguments[@]} == 7 && ${arguments[6]} == --no-tailscale ]]; then flags=' --no-tailscale'
  else return 20; fi
  actual=$(cat -- "$file")
  [[ "$actual" == "$(hive_certificate_service_text "$previous" "$config" "$flags")" ]] || return 20
  # Reject extra trailing whitespace/newlines too, preserving customized units.
  cmp -s "$file" <(hive_certificate_service_text "$previous" "$config" "$flags") || return 20
  hive_certificate_service_text "$hive" "$config" "$flags"
}

hive_certificate_service_text() {
  printf '[Unit]\nDescription=Renew the Hive console certificate\nAfter=network-online.target docker.service tailscaled.service\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart=%s/scripts/console-certificate.sh renew --config %s --hive %s%s\n' "$1" "$2" "$1" "$3"
}
