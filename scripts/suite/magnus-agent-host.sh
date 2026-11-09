#!/usr/bin/env bash
# The Magnus agent on a fleet host, transported verbatim by the controller (hive.sh magnus-agent).
# Requests arrive as JSON data on standard input; the node credentials either are read here from
# the Magnus host's own configuration, or arrive in that JSON for another host. They are written
# only to the agent's root-only environment file and are never printed or passed as arguments.
#   magnus-agent-preflight  what this host has: Node.js, jq, tailscale, the agent's port, systemd
#   magnus-agent-node       install Node.js 24 from NodeSource's signed apt repository
#   magnus-agent-install    install, repair or upgrade the agent and its service
#   magnus-agent-host-key   this host's SSH host key fingerprint, for the web terminal
#   magnus-agent-local      installed version and service state
#   magnus-agent-remove     stop, disable and remove the agent
#   magnus-agent-secrets    (Magnus host) the node credentials, for another host only
#   magnus-agent-heartbeat  (Magnus host) Magnus's record of a node, read inside its container
set -Eeuo pipefail
umask 077
read -r input
action=$(jq -er .action <<< "$input")
request=$(jq -c '.magnusAgent // {}' <<< "$input")
root=$(jq -r '.root // "/opt/magnus-agent"' <<< "$request")
package=$(jq -r '.package.name // "@hivemagnus/magnus-agent"' <<< "$request")
port=$(jq -r '.agentPort // 4100' <<< "$request")
die() { printf 'Magnus agent: %s\n' "$*" >&2; exit 1; }
[[ "$root" =~ ^/[A-Za-z0-9_./-]+$ && "$root" != *'/../'* && "$root" != / ]] || die 'Invalid agent directory'
[[ "$port" =~ ^[0-9]{2,5}$ ]] || die 'Invalid agent port'
NODESOURCE_FINGERPRINT=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
unit=${MAGNUS_AGENT_UNIT:-/etc/systemd/system/magnus-agent.service}
entry() { printf '%s/node_modules/%s/dist/index.js\n' "$root" "$package"; }
# Node.js satisfies the agent's engines: ^24.22.1 || ^26.13.0.
node_ok() {
  local version major minor patch
  version=$(node --version 2>/dev/null) || return 1
  [[ "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}
  case "$major" in
    24) (( minor > 22 || (minor == 22 && patch >= 1) ));;
    26) (( minor > 13 || (minor == 13 && patch >= 0) ));;
    *) return 1;;
  esac
}
installed_version() {
  local file="$root/node_modules/$package/package.json"
  [[ -f "$file" ]] && jq -r .version "$file" || true
}
service_state() { systemctl is-active magnus-agent 2>/dev/null || true; }
need_root() { [[ $(id -u) == 0 ]] || die 'Installing the agent needs root on this host'; }
# Compose semantics: the last assignment wins; one pair of quotes is removed.
get() {
  jq -Rrs --arg key "$2" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|
    if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$1"
}

preflight() {
  local node=null listener=free state
  if command -v node >/dev/null 2>&1; then node=$(jq -nc --arg version "$(node --version 2>/dev/null || true)" --argjson ok "$(node_ok && echo true || echo false)" '{version:$version,ok:$ok}'); fi
  state=$(service_state)
  if command -v ss >/dev/null 2>&1 && [[ -n $(ss -H -lnt "sport = :$port" 2>/dev/null) ]]; then
    if [[ "$state" == active ]]; then listener=agent; else listener=occupied; fi
  fi
  jq -n --argjson node "$node" --arg listener "$listener" --arg state "$state" --arg version "$(installed_version)" \
    --argjson jq true --argjson tailscale "$(command -v tailscale >/dev/null 2>&1 && echo true || echo false)" \
    --argjson systemd "$([[ -d /run/systemd/system ]] && echo true || echo false)" --argjson root "$([[ $(id -u) == 0 ]] && echo true || echo false)" \
    --argjson apt "$(command -v apt-get >/dev/null 2>&1 && echo true || echo false)" --arg arch "$(uname -m)" \
    --arg magicDns "$(command -v tailscale >/dev/null 2>&1 && tailscale status --json 2>/dev/null | jq -r 'if ((.CertDomains // [])|length)>0 then .Self.DNSName|sub("\\.$";"") else "" end' || true)" \
    '{node:$node,jq:$jq,tailscale:$tailscale,tailnetName:$magicDns,systemd:$systemd,root:$root,apt:$apt,arch:$arch,port:{state:$listener},service:$state,installedVersion:$version}'
}

install_node() {
  need_root
  command -v apt-get >/dev/null || die 'Installing Node.js here needs apt; install Node.js 24 yourself'
  local key arch
  export DEBIAN_FRONTEND=noninteractive
  command -v gpg >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y --no-install-recommends gpg curl ca-certificates >/dev/null; }
  key=$(mktemp)
  curl -fsSL --proto '=https' --tlsv1.2 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key"
  gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '$1=="fpr" {print $10}' | grep -qx "$NODESOURCE_FINGERPRINT" ||
    { rm -f -- "$key"; die "NodeSource's signing key did not match fingerprint $NODESOURCE_FINGERPRINT; nothing was added"; }
  install -d -m 0755 /etc/apt/keyrings
  install -m 0644 "$key" /etc/apt/keyrings/nodesource.asc; rm -f -- "$key"
  arch=$(dpkg --print-architecture)
  printf 'Types: deb\nURIs: https://deb.nodesource.com/node_24.x\nSuites: nodistro\nComponents: main\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/nodesource.asc\n' "$arch" > /etc/apt/sources.list.d/nodesource.sources
  chmod 0644 /etc/apt/sources.list.d/nodesource.sources
  apt-get update -qq
  apt-get install -y nodejs >/dev/null
  node_ok || die "Node.js $(node --version 2>/dev/null || echo missing) does not satisfy ^24.22.1 || ^26.13.0"
  jq -nc --arg version "$(node --version)" '{node:$version}'
}

# The verified package tarball: its sha512 must equal the release's pinned integrity.
fetch_package() {
  local work=$1 version integrity file actual
  version=$(jq -er .package.version <<< "$request"); integrity=$(jq -er .package.integrity <<< "$request")
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$integrity" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]] || die 'The release pins no valid agent package'
  (cd "$work" && npm pack --silent --ignore-scripts --registry=https://registry.npmjs.org/ "$package@$version" > "$work/pack.out" 2>"$work/pack.err") || die "npm could not download $package@$version"
  file="$work/$(tail -n 1 "$work/pack.out")"
  [[ -f "$file" && ! -L "$file" ]] || die 'npm did not produce the package tarball'
  actual="sha512-$(openssl dgst -sha512 -binary "$file" | base64 -w0)"
  [[ "$actual" == "$integrity" ]] || die "The $package@$version tarball does not match the integrity this release pins; nothing was installed"
  printf '%s\n' "$file"
}

# The signed tarball must carry a complete standalone shrinkwrap, not only semver ranges.
# Resolve only its locked registry URLs and integrities, and never execute dependency scripts.
install_locked_package() {
  local prefix=$1 tarball=$2 work=$3 member candidate target
  candidate="$work/package"
  while IFS= read -r member; do
    [[ "$member" == package/* && "$member" != *'/../'* && "$member" != */.. && "$member" != *'/./'* ]] || die 'Unsafe path in the agent archive'
  done < <(tar -tzf "$tarball")
  tar -tvzf "$tarball" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' || die 'The agent archive contains links or special files'
  mkdir -p "$candidate"
  tar --extract --gzip --file "$tarball" --directory "$candidate" --strip-components=1 --no-same-owner --no-same-permissions
  [[ -f "$candidate/npm-shrinkwrap.json" && -f "$candidate/package.json" ]] || die 'The agent package has no locked dependency graph; use a release with npm-shrinkwrap.json'
  jq -e --slurpfile package "$candidate/package.json" --arg name "$package" --arg version "$(jq -r .package.version <<< "$request")" '
    .lockfileVersion==3 and .name==$name and .version==$version and
    $package[0].name==$name and $package[0].version==$version and
    .packages[""].dependencies==$package[0].dependencies and
    (.packages|to_entries|all(.key=="" or
      ((.key|startswith("node_modules/")) and (.value.version|type=="string") and
       (.value.resolved|type=="string" and startswith("https://registry.npmjs.org/")) and
       (.value.integrity|type=="string" and test("^sha512-[A-Za-z0-9+/]{86}==$")) and
       (.value.link // false | not))))' "$candidate/npm-shrinkwrap.json" >/dev/null || die 'The agent shrinkwrap is incomplete or does not match the signed package'
  : > "$work/user.npmrc"; : > "$work/global.npmrc"
  npm ci --prefix "$candidate" --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
    --registry=https://registry.npmjs.org/ --userconfig="$work/user.npmrc" --globalconfig="$work/global.npmrc" --cache="$work/npm-cache" > "$work/install.log" 2>&1 ||
    die 'The locked agent dependencies could not be installed; the previous agent was retained'
  # Check the staged runtime before replacing any installed package or switching current.
  node "$candidate/dist/index.js" check --env-file "$root/.env" >/dev/null 2> "$work/check.log" || die 'The staged agent check failed; the previous agent was retained'
  target="$prefix/node_modules/$package"
  [[ ! -L "$prefix" && ! -L "$prefix/node_modules" && ! -L "$prefix/node_modules/@hivemagnus" && ! -L "$target" ]] || die 'Unsafe agent package destination'
  install -d -m 0755 "$prefix/node_modules/@hivemagnus"
  [[ ! -e "$target" ]] || mv -T -- "$target" "$work/previous-package"
  mv -T -- "$candidate" "$target"
}

write_environment() {
  local environment="$root/.env" temporary secret_source control fqdn certificate key renewal reconciliation='' staged_path='' supervisor='' terminal_user=''
  control=$(jq -er .controlApiUrl <<< "$request"); fqdn=$(jq -er .hostFqdn <<< "$request")
  certificate=$(jq -er .certificate.certificate <<< "$request"); key=$(jq -er .certificate.key <<< "$request")
  renewal=$(jq -r '.certificate.renewal // ""' <<< "$request")
  [[ "$control" =~ ^https://[A-Za-z0-9.-]+:[0-9]+$ && "$fqdn" =~ ^[A-Za-z0-9.-]+$ ]] || die 'Invalid control API URL or host name'
  temporary=$(mktemp "$root/.env.XXXXXX")
  if [[ -f "$environment" ]]; then staged_path=$(get "$environment" ARDENT_STAGED_PACKAGE); fi
  if [[ -f "$environment" ]]; then supervisor=$(get "$environment" MAGNUS_EXECUTION_SUPERVISOR_ENABLED); fi
  supervisor=${supervisor:-true}
  if jq -e '.enableSupervisor==true' <<< "$request" >/dev/null; then supervisor=true; fi
  terminal_user=$(jq -r '.terminalUser // ""' <<< "$request")
  if [[ -z "$terminal_user" && -f "$environment" ]]; then terminal_user=$(get "$environment" MAGNUS_AGENT_MANAGED_TERMINAL_USER); fi
  if [[ "$supervisor" != true ]]; then terminal_user=''; fi
  if [[ -n "$terminal_user" ]]; then
    [[ "$terminal_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && $(id -u "$terminal_user") != 0 && $(id -G "$terminal_user" | wc -w) == 1 ]] || die 'Managed terminal needs a dedicated non-root account without supplementary groups'
  fi
  if [[ -z "$staged_path" || "$staged_path" == "$root-artifacts/"* ]]; then staged_path=${native_stage_path:-$staged_path}; fi
  {
    # Retain operator settings for native runtimes when repairing or upgrading the host agent.
    # Only the connection, credentials and certificate settings below are installer-owned.
    if [[ -f "$environment" ]]; then
      awk '!/^(CONTROL_API_URL|HOST_FQDN|NODE_ENV|MAGNUS_AGENT_PRIVILEGED|NODE_MANAGER_PORT|TLS_CERT_PATH|TLS_KEY_PATH|LOG_LEVEL|MAGNUS_AGENT_TLS_RENEWAL|NODE_MANAGER_SECRET|RESULT_SIGNING_SECRET|COMMAND_RECONCILIATION_SECRET|ARDENT_OWNER_USER|ARDENT_STAGED_PACKAGE|MAGNUS_EXECUTION_SUPERVISOR_ENABLED|MAGNUS_AGENT_MANAGED_TERMINAL_USER)=/' "$environment"
    fi
    printf 'ARDENT_OWNER_USER=%s\n' "$native_owner"
    printf 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED=%s\n' "$supervisor"
    [[ -z "$terminal_user" ]] || printf 'MAGNUS_AGENT_MANAGED_TERMINAL_USER=%s\n' "$terminal_user"
    [[ -z "$staged_path" ]] || printf 'ARDENT_STAGED_PACKAGE=%s\n' "$staged_path"
    printf 'CONTROL_API_URL=%s\nHOST_FQDN=%s\nNODE_ENV=production\nMAGNUS_AGENT_PRIVILEGED=true\nNODE_MANAGER_PORT=%s\n' "$control" "$fqdn" "$port"
    printf 'TLS_CERT_PATH=%s\nTLS_KEY_PATH=%s\nLOG_LEVEL=info\n' "$certificate" "$key"
    [[ "$renewal" != tailscale ]] || printf 'MAGNUS_AGENT_TLS_RENEWAL=tailscale\n'
    # The credentials: from the Magnus host's configuration on that host, or from the request.
    secret_source=$(jq -r '.magnusEnvironment // ""' <<< "$request")
    if [[ -n "$secret_source" ]]; then
      [[ -f "$secret_source" && ! -L "$secret_source" ]] || die 'The Magnus configuration is missing on this host'
      printf 'NODE_MANAGER_SECRET=%s\nRESULT_SIGNING_SECRET=%s\n' "$(get "$secret_source" NODE_MANAGER_SECRET)" "$(get "$secret_source" RESULT_SIGNING_SECRET)"
      reconciliation=$(get "$secret_source" COMMAND_RECONCILIATION_SECRET)
    else
      printf 'NODE_MANAGER_SECRET=%s\nRESULT_SIGNING_SECRET=%s\n' "$(jq -r '.secret.NODE_MANAGER_SECRET // ""' <<< "$input")" "$(jq -r '.secret.RESULT_SIGNING_SECRET // ""' <<< "$input")"
      reconciliation=$(jq -r '.secret.COMMAND_RECONCILIATION_SECRET // ""' <<< "$input")
    fi
    # The server's reconciliation key, when it has one: the same value on the server and every agent.
    [[ -z "$reconciliation" ]] || printf 'COMMAND_RECONCILIATION_SECRET=%s\n' "$reconciliation"
  } > "$temporary"
  grep -qE '^NODE_MANAGER_SECRET=.{32,}$' "$temporary" && grep -qE '^RESULT_SIGNING_SECRET=.{32,}$' "$temporary" || { rm -f -- "$temporary"; die 'The Magnus node credentials are missing'; }
  [[ -z "$reconciliation" || ${#reconciliation} -ge 32 ]] || { rm -f -- "$temporary"; die 'COMMAND_RECONCILIATION_SECRET on the Magnus host is shorter than 32 characters'; }
  chmod 600 "$temporary"
  if [[ -f "$environment" ]] && cmp -s "$temporary" "$environment"; then rm -f -- "$temporary"; return 1; fi
  mv -T -- "$temporary" "$environment"
}

# The signed agent package's shrinkwrap pins its Ardent dependency. Stage those exact
# public bytes for the browser's Install package action, without installing a runtime.
stage_ardent_package() {
  local lock="$root/node_modules/$package/npm-shrinkwrap.json" version integrity base work archive actual target digest
  version=$(jq -r '.packages["node_modules/@hivemagnus/ardent"].version // empty' "$lock")
  [[ -n "$version" ]] || return 0
  integrity=$(jq -er '.packages["node_modules/@hivemagnus/ardent"].integrity' "$lock")
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$integrity" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]] || die 'The signed agent has no valid Ardent dependency pin'
  base="$root-artifacts"
  [[ ! -L "$base" ]] || die 'Native package staging cannot be a symlink'
  install -d -m 0755 "$base"
  # Integrity identifies the immutable directory, even if a registry tag were replaced.
  target="$base/$version-$(printf '%s' "$integrity" | sha256sum | cut -c1-16)"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -d "$target" && ! -L "$target" && -f "$target/ardent-package.tgz" && ! -L "$target/ardent-package.tgz" ]] || die 'Unsafe native package staging directory'
    actual="sha512-$(openssl dgst -sha512 -binary "$target/ardent-package.tgz" | base64 -w0)"
    [[ "$actual" == "$integrity" ]] || die 'The staged Ardent package changed; preserve and review it before retrying'
  else
    work=$(mktemp -d "$base/.stage-XXXXXX")
    if ! (cd "$work" && npm pack --silent --ignore-scripts --registry=https://registry.npmjs.org/ "@hivemagnus/ardent@$version" > pack.out 2> pack.err); then rm -rf -- "$work"; die 'Could not stage the pinned Ardent package'; fi
    archive="$work/$(tail -n 1 "$work/pack.out")"
    [[ -f "$archive" && ! -L "$archive" ]] || { rm -rf -- "$work"; die 'npm did not return an Ardent archive'; }
    actual="sha512-$(openssl dgst -sha512 -binary "$archive" | base64 -w0)"
    [[ "$actual" == "$integrity" ]] || { rm -rf -- "$work"; die 'Ardent archive differs from the signed agent dependency; nothing was staged'; }
    mv -- "$archive" "$work/ardent-package.tgz"
    digest=$(sha256sum "$work/ardent-package.tgz" | cut -d ' ' -f1)
    jq -nc --arg version "$version" --arg sha256 "$digest" '{name:"@hivemagnus/ardent",version:$version,sha256:$sha256}' > "$work/ardent-package.json"
    jq -nc --arg archive "$digest" --arg sidecar "$(sha256sum "$work/ardent-package.json" | cut -d ' ' -f1)" \
      '{component:"agent",files:[{path:"ardent-package.tgz",sha256:$archive},{path:"ardent-package.json",sha256:$sidecar}]}' > "$work/component-manifest.json"
    rm -- "$work/pack.out" "$work/pack.err"
    chmod 0755 "$work"; chmod 0644 "$work/ardent-package.tgz" "$work/ardent-package.json" "$work/component-manifest.json"
    mv -T -- "$work" "$target"
  fi
  native_stage_path="$target/ardent-package.tgz"
}

# Native profiles run as an unprivileged account, never as the root management daemon.
# Existing explicit ownership is retained. A new account is installation-owned and marked,
# so a same-named unrelated account cannot silently become the runtime owner.
prepare_native_owner() {
  # Keep the ownership record beside the agent directory: removing the management
  # daemon must not orphan the account that still owns native profiles.
  local environment="$root/.env" marker="$root.native-owner.json" home uid recorded_uid temporary
  [[ ! -L "$environment" && ! -L "$marker" ]] || die 'Native owner configuration cannot be a symlink'
  native_owner=''
  if [[ -f "$environment" ]]; then
    native_owner=$(get "$environment" ARDENT_OWNER_USER)
    [[ -n "$native_owner" ]] || native_owner=$(get "$environment" HERMES_USER)
  fi
  if [[ -z "$native_owner" && -f "$marker" ]]; then native_owner=$(jq -er .username "$marker"); fi
  if [[ -z "$native_owner" ]]; then
    native_owner=hive-agent
    if id "$native_owner" >/dev/null 2>&1; then die 'The hive-agent account already exists without an ownership record; set ARDENT_OWNER_USER explicitly before installing'; fi
    (set -o noclobber; jq -nc --arg username "$native_owner" '{schema:1,username:$username,phase:"preparing"}' > "$marker")
    chmod 600 "$marker"
    sync -f "$marker"
  fi
  [[ "$native_owner" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die 'Invalid native runtime owner'
  if ! id "$native_owner" >/dev/null 2>&1; then
    [[ -f "$marker" ]] && jq -e --arg name "$native_owner" '.username==$name and .phase=="preparing"' "$marker" >/dev/null || die 'The configured native owner account is missing'
    useradd --create-home --user-group --shell /bin/bash --comment 'Hive agent runtimes' "$native_owner"
  fi
  uid=$(id -u "$native_owner")
  [[ "$uid" != 0 ]] || die 'Native agent profiles must have a non-root owner'
  home=$(getent passwd "$native_owner" | cut -d: -f6)
  [[ "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] || die 'Native runtime owner needs a regular home directory'
  if [[ -f "$marker" && $(jq -r .username "$marker") == "$native_owner" ]]; then
    recorded_uid=$(jq -r '.uid // empty' "$marker")
    [[ -z "$recorded_uid" || "$recorded_uid" == "$uid" ]] || die 'The native owner UID changed; review account ownership before retrying'
    [[ $(id -nG "$native_owner") == "$native_owner" ]] || die 'The dedicated native account has additional groups; review its privileges before retrying'
    if [[ -z "$recorded_uid" ]]; then
      temporary=$(mktemp "$marker.XXXXXX")
      jq --argjson uid "$uid" '.phase="complete" | .uid=$uid' "$marker" > "$temporary"
      sync -f "$temporary"; mv -T -- "$temporary" "$marker"
    fi
  fi
  loginctl enable-linger "$native_owner"
  systemctl start "user@$uid.service"
}

prepare_certificate() {
  local certificate key fqdn
  certificate=$(jq -er .certificate.certificate <<< "$request"); key=$(jq -er .certificate.key <<< "$request"); fqdn=$(jq -er .hostFqdn <<< "$request")
  if [[ $(jq -r '.certificate.renewal // ""' <<< "$request") == tailscale ]]; then
    command -v tailscale >/dev/null || die 'tailscale is needed to issue this host certificate'
    install -d -m 0700 "$(dirname -- "$certificate")"
    if [[ ! -f "$certificate" ]] || ! openssl x509 -in "$certificate" -noout -checkend 86400 >/dev/null 2>&1; then
      tailscale cert --cert-file "$certificate" --key-file "$key" "$fqdn" >/dev/null 2>&1 || die "tailscale cert failed for $fqdn"
      chmod 600 "$key"; chmod 644 "$certificate"
    fi
  fi
  [[ -f "$certificate" && -f "$key" ]] || die 'The agent certificate or key is missing'
  openssl verify -partial_chain -no_check_time -trusted "$certificate" -verify_hostname "$fqdn" "$certificate" >/dev/null 2>&1 || die "The agent certificate is not valid for $fqdn"
}

install_agent() {
  need_root
  node_ok || die "Node.js $(node --version 2>/dev/null || echo 'is missing and') does not satisfy ^24.22.1 || ^26.13.0"
  local wanted current work tarball changed=false fresh=false
  wanted=$(jq -er .package.version <<< "$request")
  [[ ! -L "$root" ]] || die 'The agent directory cannot be a symlink'
  install -d -m 0700 "$root"
  prepare_certificate
  prepare_native_owner
  if write_environment; then changed=true; fi
  current=$(installed_version)
  if [[ "$current" != "$wanted" ]]; then
    work=$(mktemp -d)
    trap 'rm -rf -- "${work:-}"' EXIT
    tarball=$(fetch_package "$work") || { rm -rf -- "$work"; exit 1; }
    if [[ -L "$root/current" ]]; then
      # An upgrade in the agent's own versioned layout, as its self-upgrade does it.
      install -d -m 0755 "$root/versions/$wanted"
      install_locked_package "$root/versions/$wanted" "$tarball" "$work"
      ln -sfn "versions/$wanted" "$root/current.new" && mv -T -- "$root/current.new" "$root/current"
    else
      install_locked_package "$root" "$tarball" "$work"
      fresh=true
    fi
    rm -rf -- "$work"
    changed=true
  fi
  stage_ardent_package
  if write_environment; then changed=true; fi
  node "$(entry)" check --env-file "$root/.env" >/dev/null 2>"$root/check.log" || { cat -- "$root/check.log" >&2; die 'magnus-agent check failed; the service was not started'; }
  if [[ "$fresh" == true || ! -f "$unit" ]]; then
    # The agent's own service setup: versioned layout, upgrade launcher and unit.
    AGENT_INSTALL_DIR=$root node "$(entry)" install-service --dir "$root" --unit "$unit" >/dev/null
  fi
  systemctl daemon-reload
  systemctl enable magnus-agent >/dev/null 2>&1
  if [[ "$changed" == true || $(service_state) != active ]]; then systemctl restart magnus-agent; fi
  jq -nc --arg version "$(installed_version)" --arg state "$(service_state)" --argjson changed "$changed" '{version:$version,service:$state,changed:$changed}'
}

host_key() {
  local file=${MAGNUS_AGENT_HOST_KEY:-/etc/ssh/ssh_host_ed25519_key.pub}
  [[ -f "$file" ]] || die 'This host has no ed25519 SSH host key'
  ssh-keygen -lf "$file" | awk '{print $2}' | jq -Rc '{fingerprint:.}'
}

remove_agent() {
  need_root
  systemctl disable --now magnus-agent >/dev/null 2>&1 || true
  rm -f -- "$unit"
  systemctl daemon-reload
  [[ ! -e "$root" ]] || rm -rf -- "$root"
  jq -nc '{removed:true}'
}

magnus_secrets() {
  local file
  file=$(jq -er .magnusEnvironment <<< "$request")
  [[ -f "$file" && ! -L "$file" ]] || die 'The Magnus configuration is missing on this host'
  # Parsed inside jq from the file itself, so no value is ever an argument.
  jq -Rs --arg sq "'" 'split("\n") as $lines | def value($key): ($lines|map(select(startswith($key+"="))|.[($key|length)+1:]|
      if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // "");
    {NODE_MANAGER_SECRET:value("NODE_MANAGER_SECRET"),RESULT_SIGNING_SECRET:value("RESULT_SIGNING_SECRET"),COMMAND_RECONCILIATION_SECRET:value("COMMAND_RECONCILIATION_SECRET")}' "$file"
}

# Magnus's own record of the node, read through its API inside its container with the
# container's administrator secret, which never leaves it.
heartbeat() {
  local compose fqdn
  compose=$(jq -er .compose <<< "$request"); fqdn=$(jq -er .hostFqdn <<< "$request")
  [[ "$fqdn" =~ ^[A-Za-z0-9.-]+$ ]] || die 'Invalid host name'
  docker compose -f "$compose" exec -T -e "HIVE_NODE_FQDN=$fqdn" magnus node --input-type=module -e '
    const fqdn = process.env.HIVE_NODE_FQDN;
    const response = await fetch("https://localhost:" + (process.env.CONTROL_API_PORT || "4000") + "/api/v1/nodes?pageSize=100&query=" + encodeURIComponent(fqdn), { headers: { "x-api-secret": process.env.API_SECRET } });
    const body = await response.json();
    const node = (body.data || []).find((item) => item.hostname === fqdn || item.name === fqdn);
    console.log(JSON.stringify(node ? { id: node.id, name: node.name, status: node.status, lastHeartbeatAt: node.lastHeartbeatAt, agentVersion: node.agent?.version ?? null } : null));'
}

ardent_review() {
  need_root
  local owner uid home native_home profiles processes gateway=null config code mode proof initializer container maintenance=""
  [[ -f "$root.native-owner.json" && ! -L "$root.native-owner.json" ]] || die 'This host has no installer-owned native account; use the independent Magnus review workflow'
  owner=$(get "$root/.env" ARDENT_OWNER_USER)
  [[ "$owner" == "$(jq -er .username "$root.native-owner.json")" ]] || die 'Native owner differs from its installation record'
  uid=$(id -u "$owner"); [[ "$uid" != 0 ]] || die 'Native owner must be non-root'
  jq -e --argjson uid "$uid" '.phase=="complete" and .uid==$uid' "$root.native-owner.json" >/dev/null || die 'Native owner identity differs from its completed installation record'
  home=$(getent passwd "$owner" | cut -d: -f6)
  native_home=$(get "$root/.env" ARDENT_HOME); native_home=${native_home:-$home/.ardent}
  [[ "$native_home" == "$home/"* && ! -L "$native_home" && ! -L "$native_home/profiles" ]] || die 'Native profile path needs independent review'
  profiles=0
  if [[ -d "$native_home/profiles" ]]; then profiles=$(find "$native_home/profiles" -mindepth 1 -maxdepth 1 | wc -l); fi
  processes=$(ps -o comm= -u "$uid" | jq -Rsc 'split("\n")|map(gsub("^ +| +$";""))|map(select(length>0))')
  config=$(jq -er .configurationDirectory <<< "$request")
  initializer="$config/.initializer/receipt.json"
  [[ -f "$initializer" && ! -L "$initializer" ]] && jq -e '.phase=="complete"' "$initializer" >/dev/null || die 'A completed fresh initializer is required'
  if jq -e '.gatewaySelected==true' <<< "$request" >/dev/null; then
    container=$(docker compose -f "$(jq -er .compose <<< "$request")" ps -q magnus-gateway)
    [[ -n "$container" ]] || die 'The selected web terminal gateway is not running'
    gateway=$(docker top "$container" -eo pid,ppid,comm |
      awk '$1 ~ /^[0-9]+$/ {print $1, $2, $3}' | jq -Rsc 'split("\n")|map(select(length>0)|split(" ")|{pid:(.[0]|tonumber),ppid:(.[1]|tonumber),name:.[2]})')
  fi
  mode=$(jq -er .mode <<< "$request")
  proof=$(jq -nc --arg mode "$mode" --arg fqdn "$(jq -er .hostFqdn <<< "$request")" --arg owner "$owner" --argjson uid "$uid" \
    --argjson profiles "$profiles" --argjson processes "$processes" --argjson gateway "$gateway" \
    --arg initializer "$(sha256sum "$initializer" | cut -d ' ' -f1)" --arg review "$(jq -r '.reviewSHA256 // ""' <<< "$request")" \
    '{mode:$mode,hostFqdn:$fqdn,freshInstallation:true,initializerSHA256:$initializer,reviewSHA256:$review,owner:{username:$owner,uid:$uid,profileCount:$profiles,processes:$processes},gatewayProcesses:$gateway}')
  if [[ -f "$root/enrollment-maintenance.json" && ! -L "$root/enrollment-maintenance.json" ]]; then
    maintenance=$(jq -er '.releaseId // ""' "$root/enrollment-maintenance.json")
  fi
  proof=$(jq -c --arg id "$maintenance" --arg version "$(installed_version)" \
    --arg supervisor "$(get "$root/.env" MAGNUS_EXECUTION_SUPERVISOR_ENABLED)" --arg terminal "$(get "$root/.env" MAGNUS_AGENT_MANAGED_TERMINAL_USER)" \
    '.maintenanceId=$id | .agentRuntime={version:$version,supervisor:($supervisor=="true"),terminalUser:$terminal}' <<< "$proof")
  code=$(jq -er .reviewScript <<< "$request")
  printf '%s' "$code" | base64 -d | docker compose -f "$(jq -er .compose <<< "$request")" exec -T \
    -e "HIVE_ARDENT_REVIEW=$proof" magnus node --input-type=module
}

node_maintenance() {
  need_root
  local owner uid home receipt="$root/enrollment-maintenance.json" mode profile service units temporary
  mode=$(jq -er .mode <<< "$request")
  [[ -f "$root.native-owner.json" && ! -L "$root.native-owner.json" ]] || die 'Installer-owned native account required'
  owner=$(get "$root/.env" ARDENT_OWNER_USER); uid=$(id -u "$owner"); home=$(getent passwd "$owner" | cut -d: -f6)
  jq -e --arg owner "$owner" --argjson uid "$uid" '.phase=="complete" and .username==$owner and .uid==$uid and .uid>0' "$root.native-owner.json" >/dev/null || die 'Native ownership record differs'
  local native_home
  native_home=$(get "$root/.env" ARDENT_HOME); native_home=${native_home:-$home/.ardent}
  [[ "$native_home" == "$home/"* && ! -L "$native_home" && ! -L "$native_home/profiles" ]] || die 'Unsafe native profile location'
  if [[ -e "$receipt" ]]; then
    [[ -f "$receipt" && ! -L "$receipt" && $(stat -c %u "$receipt") == 0 && $(stat -c %a "$receipt") == 600 ]] || die 'Unsafe maintenance receipt'
    jq -e --arg owner "$owner" --argjson uid "$uid" '.version==1 and .owner==$owner and .uid==$uid and (.units|type=="array") and all(.units[];test("^ardent@[A-Za-z0-9_-]+\\.service$"))' "$receipt" >/dev/null || die 'Maintenance receipt differs'
  fi
  user_service() { runuser -u "$owner" -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" /usr/bin/systemctl --user "$@"; }
  if [[ "$mode" == resume ]]; then
    [[ -f "$receipt" ]] || return 0
    [[ $(jq -r .phase "$receipt") != resumed ]] || return 0
    while IFS= read -r service; do user_service start "$service"; done < <(jq -r '.units[]' "$receipt")
    temporary=$(mktemp "$root/.maintenance.XXXXXX"); jq '.phase="resumed"' "$receipt" > "$temporary"; sync -f "$temporary"; mv -T "$temporary" "$receipt"
    printf '{"profilesResumed":true}\n'; return
  fi
  [[ "$mode" == pause ]] || die 'Unknown native maintenance mode'
  # These are prerequisites of the selected full-node capability, not controller-only installs.
  if ! command -v crontab >/dev/null || ! command -v script >/dev/null; then
    command -v apt-get >/dev/null || die 'Install cron and util-linux before full-node enrollment'
    apt-get update -qq >&2; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cron util-linux >&2
  fi
  systemctl enable --now cron >/dev/null 2>&1
  if [[ ! -f "$receipt" || $(jq -r .phase "$receipt") == resumed ]]; then
    units='[]'
    if [[ -d "$native_home/profiles" ]]; then
      while IFS= read -r profile; do
        [[ "$profile" =~ ^[A-Za-z0-9_-]+$ && -d "$native_home/profiles/$profile" && ! -L "$native_home/profiles/$profile" ]] || die 'Unknown native profile entry requires independent review'
        service="ardent@$profile.service"
        if user_service is-active --quiet "$service"; then units=$(jq -c --arg unit "$service" '.+[$unit]' <<< "$units"); fi
      done < <(find "$native_home/profiles" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
    fi
    temporary=$(mktemp "$root/.maintenance.XXXXXX")
    jq -nc --arg owner "$owner" --argjson uid "$uid" --argjson units "$units" --arg id "$(cat /proc/sys/kernel/random/uuid)" '{version:1,owner:$owner,uid:$uid,releaseId:$id,phase:"pausing",units:$units}' > "$temporary"
    sync -f "$temporary"; mv -T "$temporary" "$receipt"
  fi
  while IFS= read -r service; do user_service stop "$service"; done < <(jq -r '.units[]' "$receipt")
  temporary=$(mktemp "$root/.maintenance.XXXXXX"); jq '.phase="paused"' "$receipt" > "$temporary"; sync -f "$temporary"; mv -T "$temporary" "$receipt"
  jq '{phase,units}' "$receipt"
}

case "$action" in
  magnus-agent-preflight) preflight;;
  magnus-agent-node) install_node;;
  magnus-agent-install) install_agent;;
  magnus-agent-host-key) host_key;;
  magnus-agent-local) jq -nc --arg version "$(installed_version)" --arg state "$(service_state)" '{version:$version,service:$state}';;
  magnus-agent-remove) remove_agent;;
  magnus-agent-secrets) magnus_secrets;;
  magnus-agent-heartbeat) heartbeat;;
  magnus-agent-ardent-review) ardent_review;;
  magnus-agent-node-maintenance) node_maintenance;;
  *) die 'Unknown magnus-agent action';;
esac
