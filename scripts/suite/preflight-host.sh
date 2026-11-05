#!/usr/bin/env bash
# Read-only host preflight. This script never creates deployment state.
set -euo pipefail
read -r input
directory=$(jq -r .directory <<< "$input")
for tool in docker jq flock openssl tar gzip sha256sum stat find sort curl df realpath timeout; do
  command -v "$tool" >/dev/null
done
docker info >/dev/null
docker compose version >/dev/null
case $(uname -m) in x86_64|aarch64) ;; *) printf 'Unsupported host architecture\n' >&2; exit 1;; esac
[[ "$directory" == "$(realpath -m -- "$directory")" ]] || { printf 'Installation path must be canonical and contain no symlink ancestors\n' >&2; exit 1; }
parent=$directory
while [[ ! -d "$parent" && "$parent" != / ]]; do parent=$(dirname -- "$parent"); done
[[ -w "$parent" ]]
available=$(df -Pm -- "$parent" | awk 'NR==2 {print $4}')
required=$(jq -r '.minimumFreeMiB // 2048' <<< "$input")
(( available >= required )) || { printf 'Insufficient disk space for the configured minimum\n' >&2; exit 1; }
while IFS= read -r path; do
  [[ "$path" == /dev/null ]] && continue
  [[ -f "$path" && ! -L "$path" && -r "$path" && "$path" == "$(realpath -m -- "$path")" ]]
  permissions=$(stat -c %a "$path")
  (( (8#$permissions & 077) == 0 ))
done < <(jq -r '.placements[].envFile // "/dev/null"' <<< "$input")
while IFS= read -r path; do
  [[ -f "$path" && ! -L "$path" && -r "$path" && "$path" == "$(realpath -m -- "$path")" ]]
  [[ $(stat -c %u "$path") == "$(id -u)" ]]
  permissions=$(stat -c %a "$path")
  (( (8#$permissions & 077) == 0 ))
done < <(jq -r '.agents[].environmentFile, (.inference[]|.authHeaderFile,.caFile,.registration.credentialFile,.registration.caFile|select(.!=null))' <<< "$input")
while IFS= read -r path; do
  [[ -d "$path" && ! -L "$path" && "$path" == "$(realpath -m -- "$path")" ]]
  [[ -z $(find "$path" -type l -print -quit) ]]
done < <(jq -r '.placements[].configDirectory // empty' <<< "$input")
if [[ -e "$directory/installation.json" ]]; then
  [[ $(jq -r .installation "$directory/installation.json") == "$(jq -r .installation <<< "$input")" ]]
fi
if jq -e '.console!=null' <<< "$input" >/dev/null; then
  command -v ss >/dev/null
  runtime=$(jq -r .console.runtimeFile <<< "$input")
  hive_check_public_runtime "$runtime" || { printf 'Invalid or missing public console runtime\n' >&2; exit 1; }
  [[ "$runtime" == "$(realpath -m -- "$runtime")" ]]
  config=$(jq -r .placements.ingress.configDirectory <<< "$input")
  for file in Caddyfile console.crt console.key backend-ca.pem; do
    [[ -f "$config/$file" && ! -L "$config/$file" && -r "$config/$file" ]]
  done
  permissions=$(stat -c %a "$config/console.key")
  (( (8#$permissions & 077) == 0 ))
  hostname=$(jq -r '.origin|sub("^https://";"")|split(":")[0]' <<< "$input")
  openssl x509 -in "$config/console.crt" -noout -checkend 86400 >/dev/null
  openssl x509 -in "$config/console.crt" -noout -checkhost "$hostname" >/dev/null
  certificate_key=$(openssl x509 -in "$config/console.crt" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
  private_key=$(openssl pkey -in "$config/console.key" -pubout -outform DER 2>/dev/null | sha256sum)
  [[ "$certificate_key" == "$private_key" ]] || { printf 'Console certificate and private key do not match\n' >&2; exit 1; }
  openssl crl2pkcs7 -nocrl -certfile "$config/backend-ca.pem" | openssl pkcs7 -print_certs -noout >/dev/null
  port=$(jq -r .console.httpsPort <<< "$input")
  if [[ -n $(ss -H -lnt "sport = :$port") ]]; then
    [[ -f "$directory/compose.json" ]] || { printf 'Requested HTTPS port is already occupied\n' >&2; exit 1; }
    container=$(docker compose -f "$directory/compose.json" ps -q ingress)
    [[ -n "$container" ]] || { printf 'HTTPS listener is not owned by this installation\n' >&2; exit 1; }
    docker inspect "$container" | jq -e --arg port "$port" --arg bind "$(jq -r .console.bindAddress <<< "$input")" \
      '.[0].HostConfig.PortBindings["8443/tcp"]|any(.[];.HostPort==$port and .HostIp==$bind)' >/dev/null
  fi
fi
