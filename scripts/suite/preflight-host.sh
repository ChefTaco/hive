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
if jq -e '.bootstrap.productEndpoints!=null' <<< "$input" >/dev/null; then
  command -v ss >/dev/null
  while IFS=$'\t' read -r component target port bind hostname; do
    config=$(jq -er --arg name "$component" '.placements[$name].configDirectory' <<< "$input")
    for file in tls.crt tls.key authority.pem; do [[ -f "$config/$file" && ! -L "$config/$file" && -r "$config/$file" ]]; done
    permissions=$(stat -c %a "$config/tls.key"); (( (8#$permissions & 077)==0 ))
    openssl x509 -in "$config/tls.crt" -noout -checkend 86400 >/dev/null
    hostname_option=-verify_hostname; [[ ! "$hostname" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || hostname_option=-verify_ip
    openssl verify -CAfile "$config/authority.pem" "$hostname_option" "$hostname" "$config/tls.crt" >/dev/null
    certificate_key=$(openssl x509 -in "$config/tls.crt" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
    private_key=$(openssl pkey -in "$config/tls.key" -pubout -outform DER 2>/dev/null | sha256sum)
    [[ "$certificate_key" == "$private_key" ]] || { printf 'Product certificate and private key do not match\n' >&2; exit 1; }
    if [[ -n $(ss -H -lnt "sport = :$port") ]]; then
      [[ -f "$directory/compose.json" ]] || { printf 'Requested product HTTPS port is already occupied\n' >&2; exit 1; }
      container=$(docker compose -f "$directory/compose.json" ps -q "$component")
      [[ -n "$container" ]] || { printf 'Product HTTPS listener is not owned by this installation\n' >&2; exit 1; }
      docker inspect "$container" | jq -e --arg target "$target/tcp" --arg port "$port" --arg bind "$bind" '.[0].HostConfig.PortBindings[$target]|any(.[];.HostPort==$port and .HostIp==$bind)' >/dev/null
    fi
  done < <(jq -r '. as $input | .placements|keys[]|. as $name|$input.bootstrap.productEndpoints[$name]|select(.!=null)|. as $endpoint| [{name:$name,url:.origin,target:({oathweave:4200,emberpath:9443,hivemem:18790,hiveskills:4030,magnus:4000,"magnus-gateway":4310,cindertrace:4101,chattermost:8065}[$name])}] + (if $name=="emberpath" then [{name:$name,url:.inferenceOrigin,target:4020}] else [] end)|.[]|. as $listener|(.url|capture("^https://(?<hostname>[^:]+)(?::(?<port>[0-9]+))?$"))|[$name,($listener.target|tostring),(.port // "443"),$endpoint.bindAddress,.hostname]|@tsv' <<< "$input")
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
  bind=$(jq -r .console.bindAddress <<< "$input")
  # A listener on another specific address does not conflict with this one.
  occupied() {
    if [[ "$bind" == 0.0.0.0 || "$bind" == :: ]]; then ss -H -lnt "sport = :$1"
    else ss -H -lnt "sport = :$1" | awk -v bind="$bind" '{split($4,a,":"); if (a[1]==bind || a[1]=="0.0.0.0" || a[1]=="*" || a[1]=="[::]") print}'; fi
  }
  if [[ -n $(occupied "$port") ]]; then
    [[ -f "$directory/compose.json" ]] || { printf 'Requested HTTPS port is already occupied\n' >&2; exit 1; }
    container=$(docker compose -f "$directory/compose.json" ps -q ingress)
    [[ -n "$container" ]] || { printf 'HTTPS listener is not owned by this installation\n' >&2; exit 1; }
    docker inspect "$container" | jq -e --arg port "$port" --arg bind "$bind" \
      '.[0].HostConfig.PortBindings["8443/tcp"]|any(.[];.HostPort==$port and .HostIp==$bind)' >/dev/null
  fi
  # Native clients' ports must be free as well, or owned by this installation's ingress.
  while IFS= read -r port; do
    if [[ -n $(occupied "$port") ]]; then
      [[ -f "$directory/compose.json" && -n $(docker compose -f "$directory/compose.json" ps -q ingress) ]] || { printf 'Native listener port %s is still occupied by another process\n' "$port" >&2; exit 1; }
    fi
  done < <(jq -r '.console.nativeListeners[]?.port' <<< "$input")
fi
if jq -e '.placements["hive-registry"]!=null' <<< "$input" >/dev/null; then
  config=$(jq -r '.placements["hive-registry"].configDirectory' <<< "$input")
  for file in read-token write-token; do
    [[ -f "$config/$file" && ! -L "$config/$file" && -r "$config/$file" ]] || { printf 'Hive Registry credentials are missing\n' >&2; exit 1; }
    permissions=$(stat -c %a "$config/$file"); (( (8#$permissions & 077)==0 )) || { printf 'Hive Registry credentials must be owner-only\n' >&2; exit 1; }
  done
  if jq -e '.console!=null' <<< "$input" >/dev/null; then
    grep -q 'hive-registry:8095' "$(jq -r .placements.ingress.configDirectory <<< "$input")/Caddyfile" || { printf 'The ingress Caddyfile predates the Hive Registry; use deployment/Caddyfile from this release\n' >&2; exit 1; }
  fi
fi
