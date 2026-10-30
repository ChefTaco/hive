#!/usr/bin/env bash
# Deploy the HiveMem memory-provider plugin into a Hermes Agent profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_SRC="$PLUGIN_ROOT/plugins/memory/hivemem"
CONFIGURE_HELPER="$SCRIPT_DIR/configure_profile.py"
REPO_DIR="$(cd "$PLUGIN_ROOT/.." && pwd)"

ENV_FILE=""
for ((index = 1; index <= $#; index++)); do
  argument="${!index}"
  if [[ "$argument" == "--env-file" ]]; then
    next=$((index + 1))
    ENV_FILE="${!next:-}"
  elif [[ "$argument" == --env-file=* ]]; then
    ENV_FILE="${argument#*=}"
  fi
done
if [[ -n "$ENV_FILE" ]]; then
  [[ "$ENV_FILE" == /* ]] || ENV_FILE="$REPO_DIR/$ENV_FILE"
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { printf 'ERROR: env file must be a regular file\n' >&2; exit 1; }
  env_mode="$(stat -c '%a' "$ENV_FILE")"
  (( (8#$env_mode & 8#077) == 0 )) || { printf 'ERROR: env file must have mode 0400 or 0600\n' >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
REMOTE_HERMES_HOME="${REMOTE_HERMES_HOME:-}"
API_URL="${HERMES_HIVEMEM_API_URL:-${HIVEMEM_API_URL:-http://localhost:18790}}"
TOKEN="${HERMES_HIVEMEM_TOKEN:-${HIVEMEM_TOKEN:-}}"
CA_FILE="${HERMES_HIVEMEM_CA_FILE:-${HIVEMEM_CA_FILE:-}}"
WORKSPACE_ID="${HERMES_HIVEMEM_WORKSPACE_ID:-default}"
DEFAULT_SCOPE="${HERMES_HIVEMEM_DEFAULT_SCOPE:-private}"
RECALL_MODE="${HERMES_HIVEMEM_RECALL_MODE:-hybrid}"
# Remote target: HERMES_DEPLOY_SSH_* (or the --ssh-* flags) take precedence; the
# SSH_*2 keys are a fallback for env files that describe an optional second target.
SSH_HOST="${HERMES_DEPLOY_SSH_HOST:-${SSH_HOST2:-}}"
SSH_USER="${HERMES_DEPLOY_SSH_USER:-${SSH_USERNAME2:-${USER:-}}}"
SSH_PORT="${HERMES_DEPLOY_SSH_PORT:-${SSH_PORT2:-22}}"
SSH_IDENTITY_FILE="${HERMES_DEPLOY_SSH_IDENTITY_FILE:-}"
SSH_KNOWN_HOSTS_FILE="${HERMES_DEPLOY_SSH_KNOWN_HOSTS_FILE:-}"
REMOTE_HERMES_BIN="hermes"
SET_ACTIVE=false
RESTART_GATEWAY=false
DRY_RUN=false
FORCE=false
REMOTE_STAGE=""

usage() {
  cat <<'USAGE'
Usage: deploy_hermes_plugin.sh [options]

Install options:
  --env-file PATH            Load protected deployment settings from PATH
  --hermes-home PATH         Local HERMES_HOME (default: $HERMES_HOME or ~/.hermes)
  --api-url URL              Exact HiveMem HTTPS origin; HTTP is loopback-only
  --server NAME              Alias for --api-url; bare hosts normalize to HTTPS
  --ca-file PATH             Optional PEM CA for private HiveMem PKI
  --workspace-id ID          Default HiveMem workspace_id (default: default)
  --default-scope private|shared
  --recall-mode hybrid|context|tools|off
  --set-active               Set Hermes memory.provider to hivemem
  --restart-gateway          Restart Hermes gateway after install
  --force                    Replace an existing token with the environment token
  --dry-run                  Print non-secret actions without changing files

The token is accepted only through HERMES_HIVEMEM_TOKEN/HIVEMEM_TOKEN or a
mode-0600 --env-file, never a command-line flag.

SSH options (all four are required for remote deployment):
  --ssh-host HOST
  --ssh-user USER
  --ssh-port PORT             Default: 22
  --ssh-identity-file PATH    Mode-0400/0600 private key
  --ssh-known-hosts-file PATH Pre-provisioned host-key pin
  --remote-hermes-home PATH   Default: ~/.hermes on the remote host
  --remote-hermes-bin PATH    Default: hermes
USAGE
}

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) shift 2 ;;
    --env-file=*) shift ;;
    --hermes-home) HERMES_HOME="${2:-}"; shift 2 ;;
    --api-url|--server) API_URL="${2:-}"; shift 2 ;;
    --ca-file) CA_FILE="${2:-}"; shift 2 ;;
    --workspace-id) WORKSPACE_ID="${2:-}"; shift 2 ;;
    --default-scope) DEFAULT_SCOPE="${2:-}"; shift 2 ;;
    --recall-mode) RECALL_MODE="${2:-}"; shift 2 ;;
    --ssh-host) SSH_HOST="${2:-}"; shift 2 ;;
    --ssh-user) SSH_USER="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
    --ssh-identity-file) SSH_IDENTITY_FILE="${2:-}"; shift 2 ;;
    --ssh-known-hosts-file) SSH_KNOWN_HOSTS_FILE="${2:-}"; shift 2 ;;
    --remote-hermes-home) REMOTE_HERMES_HOME="${2:-}"; shift 2 ;;
    --remote-hermes-bin) REMOTE_HERMES_BIN="${2:-}"; shift 2 ;;
    --set-active) SET_ACTIVE=true; shift ;;
    --restart-gateway) RESTART_GATEWAY=true; shift ;;
    --force) FORCE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -d "$PLUGIN_SRC" && -f "$CONFIGURE_HELPER" ]] || die "HiveMem plugin source is incomplete"
[[ "$WORKSPACE_ID" =~ ^[A-Za-z0-9_.:-]{1,128}$ ]] || die "--workspace-id contains unsupported characters"
[[ "$DEFAULT_SCOPE" == "private" || "$DEFAULT_SCOPE" == "shared" ]] || die "--default-scope must be private or shared"
[[ "$RECALL_MODE" =~ ^(hybrid|context|tools|off)$ ]] || die "--recall-mode must be hybrid, context, tools, or off"
[[ "$TOKEN" != *$'\n'* && "$TOKEN" != *$'\r'* ]] || die "HiveMem token contains a line break"

API_URL="$(PYTHONDONTWRITEBYTECODE=1 python3 - "$PLUGIN_SRC/__init__.py" "$API_URL" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location('_hivemem_deploy_validation', sys.argv[1])
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
try:
    print(module.normalize_api_url(sys.argv[2]))
except ValueError as exc:
    raise SystemExit(f'ERROR: {exc}') from exc
PY
)"

if [[ -n "$CA_FILE" ]]; then
  [[ -f "$CA_FILE" && ! -L "$CA_FILE" ]] || die "--ca-file must name a regular PEM file"
  openssl x509 -in "$CA_FILE" -noout >/dev/null 2>&1 || die "--ca-file is not a valid PEM certificate"
fi

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmpdir"
  if [[ -n "$REMOTE_STAGE" && "$REMOTE_STAGE" =~ ^/tmp/hivemem-hermes\.[A-Za-z0-9]+$ && ${#SSH_CMD[@]} -gt 0 ]]; then
    "${SSH_CMD[@]}" "$SSH_TARGET" "rm -rf -- '$REMOTE_STAGE'" >/dev/null 2>&1 || true
  fi
}
SSH_CMD=()
SCP_CMD=()
SSH_TARGET=""
trap cleanup EXIT

create_payload() {
  local destination="$1"
  DEPLOY_PAYLOAD_PATH="$destination" \
  DEPLOY_API_URL="$API_URL" \
  DEPLOY_TOKEN="$TOKEN" \
  DEPLOY_WORKSPACE_ID="$WORKSPACE_ID" \
  DEPLOY_DEFAULT_SCOPE="$DEFAULT_SCOPE" \
  DEPLOY_RECALL_MODE="$RECALL_MODE" \
  DEPLOY_FORCE="$FORCE" \
  DEPLOY_SET_ACTIVE="$SET_ACTIVE" \
  DEPLOY_CA_FILE="$2" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ['DEPLOY_PAYLOAD_PATH'])
path.write_text(json.dumps({
    'api_url': os.environ['DEPLOY_API_URL'],
    'token': os.environ.get('DEPLOY_TOKEN', ''),
    'workspace_id': os.environ['DEPLOY_WORKSPACE_ID'],
    'default_scope': os.environ['DEPLOY_DEFAULT_SCOPE'],
    'recall_mode': os.environ['DEPLOY_RECALL_MODE'],
    'force': os.environ['DEPLOY_FORCE'] == 'true',
    'set_active': os.environ['DEPLOY_SET_ACTIVE'] == 'true',
    'ca_file': os.environ.get('DEPLOY_CA_FILE', ''),
}, sort_keys=True) + '\n', encoding='utf-8')
path.chmod(0o600)
PY
}

install_plugin_tree() {
  local target="$1"
  local stage="$target.new.$$"
  rm -rf -- "$stage"
  mkdir -p -- "$stage"
  tar -C "$PLUGIN_SRC" --exclude='__pycache__' --exclude='*.pyc' --exclude='hivemem-ca.pem' -cf - . | tar -C "$stage" -xf -
  if [[ -n "$CA_FILE" ]]; then
    install -m 0600 "$CA_FILE" "$stage/hivemem-ca.pem"
  fi
  rm -rf -- "$target"
  mv -- "$stage" "$target"
}

restart_local_gateway() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --user restart hermes-gateway.service >/dev/null 2>&1; then
    return
  fi
  if command -v hermes >/dev/null 2>&1; then
    HERMES_HOME="$HERMES_HOME" hermes gateway restart
    return
  fi
  die "Hermes gateway restart requested but no supported service/command was found"
}

deploy_local() {
  local home="$HERMES_HOME"
  [[ "$home" =~ ^/[A-Za-z0-9_./-]+$ && "$home" != "/" && "$home" != *".."* ]] || die "--hermes-home must be a safe absolute path"
  local target="$home/plugins/hivemem"
  local remote_ca=""
  log "Installing HiveMem Hermes plugin locally: $target"
  if $DRY_RUN; then
    log "[dry-run] install plugin and protected profile configuration"
    return
  fi
  mkdir -p "$home/plugins"
  chmod 0700 "$home"
  install_plugin_tree "$target"
  if [[ -n "$CA_FILE" ]]; then
    remote_ca="$target/hivemem-ca.pem"
  fi
  create_payload "$tmpdir/profile.json" "$remote_ca"
  python3 "$CONFIGURE_HELPER" --home "$home" --payload "$tmpdir/profile.json"
  if $RESTART_GATEWAY; then
    restart_local_gateway
  fi
}

prepare_remote_ssh() {
  [[ "$SSH_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "--ssh-host must be a DNS name or pinned SSH alias"
  [[ "$SSH_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "--ssh-user contains unsupported characters"
  [[ "$SSH_PORT" =~ ^[0-9]+$ ]] && (( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || die "--ssh-port must be 1-65535"
  [[ -f "$SSH_IDENTITY_FILE" && ! -L "$SSH_IDENTITY_FILE" ]] || die "--ssh-identity-file must name a regular private key"
  [[ -f "$SSH_KNOWN_HOSTS_FILE" && ! -L "$SSH_KNOWN_HOSTS_FILE" ]] || die "--ssh-known-hosts-file must name a regular pin file"
  identity_mode="$(stat -c '%a' "$SSH_IDENTITY_FILE")"
  [[ "$identity_mode" == "400" || "$identity_mode" == "600" ]] || die "SSH identity must have mode 0400 or 0600"
  [[ "$(stat -c '%u' "$SSH_IDENTITY_FILE")" == "$(id -u)" ]] || die "SSH identity must be owned by the deploy user"
  known_mode="$(stat -c '%a' "$SSH_KNOWN_HOSTS_FILE")"
  (( (8#$known_mode & 8#022) == 0 )) || die "SSH known-hosts file must not be group/world writable"
  query="$SSH_HOST"
  [[ "$SSH_PORT" == "22" ]] || query="[$SSH_HOST]:$SSH_PORT"
  ssh-keygen -F "$query" -f "$SSH_KNOWN_HOSTS_FILE" >/dev/null || die "No pinned host key for $query"
  SSH_TARGET="$SSH_USER@$SSH_HOST"
  security=(
    -o IdentitiesOnly=yes -o BatchMode=yes -o PasswordAuthentication=no
    -o KbdInteractiveAuthentication=no -o StrictHostKeyChecking=yes
    -o UpdateHostKeys=no -o GlobalKnownHostsFile=/dev/null
    -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS_FILE" -o ConnectTimeout=15 -o LogLevel=ERROR
  )
  SSH_CMD=(ssh -i "$SSH_IDENTITY_FILE" -p "$SSH_PORT" "${security[@]}")
  SCP_CMD=(scp -i "$SSH_IDENTITY_FILE" -P "$SSH_PORT" "${security[@]}")
}

restart_remote_gateway() {
  "${SSH_CMD[@]}" "$SSH_TARGET" "HERMES_HOME='$1' REMOTE_HERMES_BIN='$REMOTE_HERMES_BIN' bash -s" <<'REMOTE'
set -euo pipefail
if command -v systemctl >/dev/null 2>&1 && systemctl --user restart hermes-gateway.service >/dev/null 2>&1; then
  exit 0
fi
if command -v launchctl >/dev/null 2>&1; then
  uid="$(id -u)"
  launchctl kickstart -k "gui/$uid/ai.hermes.gateway" >/dev/null 2>&1 && exit 0
fi
"$REMOTE_HERMES_BIN" gateway restart
REMOTE
}

deploy_remote() {
  prepare_remote_ssh
  local remote_home="${REMOTE_HERMES_HOME:-~/.hermes}"
  [[ "$remote_home" =~ ^(~|/)[A-Za-z0-9_./-]+$ && "$remote_home" != *".."* ]] || die "--remote-hermes-home is unsafe"
  [[ "$REMOTE_HERMES_BIN" =~ ^[A-Za-z0-9_./-]+$ && "$REMOTE_HERMES_BIN" != *".."* ]] || die "--remote-hermes-bin is unsafe"
  if $DRY_RUN; then
    log "[dry-run] secure SSH prerequisites validated; remote changes skipped"
    return
  fi
  remote_user_home="$("${SSH_CMD[@]}" "$SSH_TARGET" 'printf %s "$HOME"')"
  [[ "$remote_user_home" =~ ^/[A-Za-z0-9_./-]+$ && "$remote_user_home" != *".."* ]] || die "Remote HOME is unsafe"
  remote_home="${remote_home/#\~/$remote_user_home}"
  local target="$remote_home/plugins/hivemem"
  REMOTE_STAGE="$("${SSH_CMD[@]}" "$SSH_TARGET" 'umask 077; mktemp -d /tmp/hivemem-hermes.XXXXXXXXXX')"
  [[ "$REMOTE_STAGE" =~ ^/tmp/hivemem-hermes\.[A-Za-z0-9]+$ ]] || die "Remote staging path is unsafe"
  local remote_ca=""
  [[ -z "$CA_FILE" ]] || remote_ca="$target/hivemem-ca.pem"
  create_payload "$tmpdir/profile.json" "$remote_ca"
  tar -C "$PLUGIN_SRC" --exclude='__pycache__' --exclude='*.pyc' --exclude='hivemem-ca.pem' -czf "$tmpdir/hivemem.tar.gz" .
  "${SCP_CMD[@]}" "$tmpdir/hivemem.tar.gz" "$CONFIGURE_HELPER" "$tmpdir/profile.json" "$SSH_TARGET:$REMOTE_STAGE/"
  if [[ -n "$CA_FILE" ]]; then
    "${SCP_CMD[@]}" "$CA_FILE" "$SSH_TARGET:$REMOTE_STAGE/hivemem-ca.pem"
  fi
  log "Installing HiveMem Hermes plugin remotely: $SSH_TARGET:$target"
  "${SSH_CMD[@]}" "$SSH_TARGET" "bash -s -- '$remote_home' '$REMOTE_STAGE' '${CA_FILE:+1}'" <<'REMOTE'
set -euo pipefail
home="$1"
stage="$2"
has_ca="$3"
target="$home/plugins/hivemem"
candidate="$home/plugins/.hivemem.new.$$"
umask 077
mkdir -p "$home/plugins" "$candidate"
tar -xzf "$stage/hivemem.tar.gz" -C "$candidate"
if [[ "$has_ca" == "1" ]]; then
  install -m 0600 "$stage/hivemem-ca.pem" "$candidate/hivemem-ca.pem"
fi
rm -rf -- "$target"
mv -- "$candidate" "$target"
python3 "$stage/configure_profile.py" --home "$home" --payload "$stage/profile.json"
REMOTE
  if $RESTART_GATEWAY; then
    restart_remote_gateway "$remote_home"
  fi
  "${SSH_CMD[@]}" "$SSH_TARGET" "rm -rf -- '$REMOTE_STAGE'"
  REMOTE_STAGE=""
}

if [[ -n "$SSH_HOST" ]]; then
  deploy_remote
else
  deploy_local
fi

log ""
log "HiveMem Hermes plugin deployed."
log "API URL: $API_URL"
log "TLS trust: $([[ -n "$CA_FILE" ]] && printf 'custom CA' || printf 'system CA store')"
if [[ -z "$TOKEN" ]]; then
  log "No replacement token supplied; an existing protected profile token was preserved if present."
fi
if ! $RESTART_GATEWAY; then
  log "Restart active Hermes sessions/gateway to load the provider."
fi
