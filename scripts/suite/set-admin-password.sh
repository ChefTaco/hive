#!/usr/bin/env bash
# Sets the password of the one administrator account a migrated installation signs in
# with, using its one-use reset token. Run it on the suite host, as root, on a terminal:
#   sudo /path/to/installation/bin/hive-set-admin-password [--token-file FILE]
# Both secrets are read without echo and leave this script only on curl's standard input,
# so neither reaches a command line, the environment, a log or shell history. The token is
# never a command-line value: use the prompt or a protected file. The running identity
# service checks the token, the password policy and the throttle.
set -Eeuo pipefail
set +x
umask 077
ulimit -c 0 2>/dev/null || true
unset HISTFILE
die() { printf 'Hive: %s\n' "$*" >&2; exit 1; }
token_file=''
if (($#)); then
  [[ $# == 2 && $1 == --token-file ]] || die 'Usage: hive-set-admin-password [--token-file FILE]. The token and the password are never command-line values.'
  token_file=$2
fi
for tool in jq curl; do command -v "$tool" >/dev/null || die "Required tool missing: $tool"; done
script=$(readlink -f -- "${BASH_SOURCE[0]}")
target=$(dirname -- "$(dirname -- "$script")")/migration/reset-target.json
[[ -f "$target" && ! -L "$target" && -r "$target" ]] || die 'This installation has no administrator reset configuration'
installation=$(jq -er .installation "$target")
username=$(jq -er .username "$target")
url=$(jq -er .url "$target")
resolve=$(jq -er .resolve "$target")
ca=$(jq -er .caFile "$target")
if [[ -n "$token_file" ]]; then
  [[ -f "$token_file" && ! -L "$token_file" ]] || die 'The token file must be a regular file'
  (( (8#$(stat -c %a -- "$token_file") & 077)==0 )) || die 'The token file must be owner-only'
  IFS= read -r token < "$token_file" || true
else
  IFS= read -rs -p "Reset token for $username on $installation: " token || true
  printf '\n' >&2
fi
[[ "$token" =~ ^hive-reset\.([a-z][a-z0-9-]*)\.[a-f0-9]{64}$ ]] || die 'That is not a reset token'
[[ "${BASH_REMATCH[1]}" == "$installation" ]] || die 'This token belongs to another installation; nothing was sent'
IFS= read -rs -p "New password for $username: " password || true
printf '\n' >&2
IFS= read -rs -p 'Repeat the new password: ' repeated || true
printf '\n' >&2
[[ -n "$password" ]] || die 'No password was entered; the token is still unused'
[[ "$password" == "$repeated" ]] || die 'The passwords differ; the token is still unused'
reply=$(printf '%s\n%s' "$token" "$password" |
  jq -Rs 'index("\n") as $line|{token:.[:$line],newPassword:.[$line+1:]}' |
  curl -sS --proto '=https' --max-time 60 --resolve "$resolve" --cacert "$ca" -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}' "$url") || { unset token password repeated; die 'The identity service could not be reached; the token is still unused'; }
unset token password repeated
status=${reply##*$'\n'}
body=${reply%$'\n'*}
message=$(jq -r '.message // .error // empty' <<< "$body" 2>/dev/null || true)
case "$status" in
  200) printf 'Password set for %s on %s. Sign in to the console, then remove the token file if you used one.\n' "$username" "$installation";;
  429) die 'Too many attempts from this address. Wait five minutes and try again.';;
  *) die "Refused (HTTP $status): ${message:-no detail}";;
esac
