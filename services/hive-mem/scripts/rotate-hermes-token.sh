#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# rotate-hermes-token.sh - Mint and install a HiveMem agent token on a Hermes host
#
# Mints a fresh HiveMem agent JWT (signed with the host's HIVEMEM_JWT_SECRET)
# that satisfies the HiveMem TypeScript core's claim policy, then installs it
# into a Hermes host's ~/.hermes/.env as HERMES_HIVEMEM_TOKEN with a timestamped
# backup. Useful for routine credential rotation or replacing a leaked token.
#
# The JWT secret never leaves the HiveMem host: signing happens remotely and
# only the resulting token is returned.
#
# Usage:
#   bash scripts/rotate-hermes-token.sh --agent-id agent-alpha --hermes-host agent-host
#   bash scripts/rotate-hermes-token.sh --agent-id agent-alpha --hermes-host agent-host \
#       --memory-host memory-host --scopes '*' --expires-days 365
#   bash scripts/rotate-hermes-token.sh --agent-id agent-alpha --memory-host memory-host --print-only
#
# The SSH user (default deploy) owns /opt/hivemem/.env and the Hermes
# ~/.hermes/.env, so no sudo is required. SSH is key-only and requires an
# already-pinned host key. Set DEPLOY_SSH_KEY (or HIVEMEM_SSH_KEY) and
# HIVEMEM_SSH_KNOWN_HOSTS_FILE as needed. The SSH user comes from the repo root
# .env (DEPLOY_USERNAME) or the standard DEPLOY_* variables.
# -----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

AGENT_ID=""
HERMES_HOST=""
MEMORY_HOST="${HIVEMEM_ROTATE_MEMORY_HOST:-}"
SCOPES="${HIVEMEM_ROTATE_SCOPES:-*}"
EXPIRES_DAYS="${HIVEMEM_ROTATE_EXPIRES_DAYS:-365}"
API_URL=""
PRINT_ONLY=false
DRY_RUN=false

usage() { sed -n '2,/^# ---/{ /^#/s/^# \?//p }' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --hermes-host) HERMES_HOST="$2"; shift 2 ;;
    --memory-host) MEMORY_HOST="$2"; shift 2 ;;
    --scopes) SCOPES="$2"; shift 2 ;;
    --expires-days) EXPIRES_DAYS="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --print-only) PRINT_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

load_env_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"; value="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ -z "$key" ]] && continue
    [[ -n "${!key:-}" ]] && continue
    export "$key=$value"
  done < "$file"
}

load_env_file "$REPO_ROOT/.env"

if [[ -z "$AGENT_ID" ]]; then echo "ERROR: --agent-id is required." >&2; exit 1; fi
if [[ -z "$MEMORY_HOST" ]]; then echo "ERROR: --memory-host (or HIVEMEM_ROTATE_MEMORY_HOST) is required." >&2; exit 1; fi
if [[ "$PRINT_ONLY" != "true" && -z "$HERMES_HOST" ]]; then
  echo "ERROR: --hermes-host is required unless --print-only is set." >&2; exit 1
fi
if ! [[ "$EXPIRES_DAYS" =~ ^[0-9]+$ ]] || [[ "$EXPIRES_DAYS" -lt 1 ]]; then
  echo "ERROR: --expires-days must be a positive integer." >&2; exit 1
fi

SSH_USER="${DEPLOY_USERNAME:-${DEPLOY_USER:-deploy}}"
SSH_KEY="${HIVEMEM_SSH_KEY:-${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}}"
SSH_KNOWN_HOSTS_FILE="${HIVEMEM_SSH_KNOWN_HOSTS_FILE:-${DEPLOY_SSH_KNOWN_HOSTS_FILE:-$HOME/.ssh/known_hosts}}"

[[ "$AGENT_ID" =~ ^[A-Za-z0-9_.:-]{1,128}$ ]] || { echo "ERROR: --agent-id contains unsupported characters." >&2; exit 1; }
[[ "$MEMORY_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "ERROR: --memory-host contains unsupported characters." >&2; exit 1; }
[[ -z "$HERMES_HOST" || "$HERMES_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "ERROR: --hermes-host contains unsupported characters." >&2; exit 1; }
[[ "$SSH_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || { echo "ERROR: SSH user contains unsupported characters." >&2; exit 1; }
scope_pattern='^[A-Za-z0-9_.*,:/ -]{1,512}$'
[[ "$SCOPES" =~ $scope_pattern ]] || { echo "ERROR: --scopes contains unsupported characters." >&2; exit 1; }
[[ "$API_URL" != *$'\n'* && "$API_URL" != *$'\r'* ]] || { echo "ERROR: --api-url contains a line break." >&2; exit 1; }
if [[ -n "$API_URL" ]]; then
  API_URL="$(PYTHONDONTWRITEBYTECODE=1 python3 - "$REPO_ROOT/services/hive-mem/hermes-plugin/plugins/memory/hivemem/__init__.py" "$API_URL" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location('_hivemem_rotation_validation', sys.argv[1])
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
try:
    print(module.normalize_api_url(sys.argv[2]))
except ValueError as exc:
    raise SystemExit(f'ERROR: {exc}') from exc
PY
)"
fi
[[ -f "$SSH_KEY" && ! -L "$SSH_KEY" ]] || { echo "ERROR: key-only SSH identity is unavailable." >&2; exit 1; }
[[ -f "$SSH_KNOWN_HOSTS_FILE" && ! -L "$SSH_KNOWN_HOSTS_FILE" ]] || { echo "ERROR: pinned SSH known-hosts file is unavailable." >&2; exit 1; }
key_mode="$(stat -c '%a' "$SSH_KEY")"
[[ "$key_mode" == "400" || "$key_mode" == "600" ]] || { echo "ERROR: SSH identity must have mode 0400 or 0600." >&2; exit 1; }
[[ "$(stat -c '%u' "$SSH_KEY")" == "$(id -u)" ]] || { echo "ERROR: SSH identity must be owned by the deploy user." >&2; exit 1; }
known_mode="$(stat -c '%a' "$SSH_KNOWN_HOSTS_FILE")"
(( (8#$known_mode & 8#022) == 0 )) || { echo "ERROR: known-hosts file must not be group/world writable." >&2; exit 1; }
for pinned_host in "$MEMORY_HOST" ${HERMES_HOST:+"$HERMES_HOST"}; do
  ssh-keygen -F "$pinned_host" -f "$SSH_KNOWN_HOSTS_FILE" >/dev/null || {
    echo "ERROR: no pinned SSH host key for $pinned_host." >&2
    exit 1
  }
done

SSH_OPTS=(
  -i "$SSH_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o StrictHostKeyChecking=yes
  -o UpdateHostKeys=no
  -o GlobalKnownHostsFile=/dev/null
  -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS_FILE"
  -o ConnectTimeout=10
  -o LogLevel=ERROR
)

echo ">>> Rotating HiveMem token" >&2
echo "    agent-id:     $AGENT_ID" >&2
echo "    memory-host:  $SSH_USER@$MEMORY_HOST (signs with /opt/hivemem/.env secret)" >&2
echo "    scopes:       $SCOPES" >&2
echo "    expires:      ${EXPIRES_DAYS}d" >&2
if [[ "$PRINT_ONLY" == "true" ]]; then
  echo "    target:       (print only)" >&2
else
  echo "    target:       $SSH_USER@$HERMES_HOST:~/.hermes/.env" >&2
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo ">>> Dry run: would mint a token on $MEMORY_HOST and $([[ "$PRINT_ONLY" == "true" ]] && echo "print it" || echo "install it on $HERMES_HOST")." >&2
  exit 0
fi

# --- Mint the token on the memory host (secret never leaves the host) ---------
# The SSH user owns /opt/hivemem/.env (mode 600); fall back to passwordless sudo
# only if a host keeps it root-owned.
REMOTE_MINT=$(cat <<'MINT'
set -euo pipefail
# systemd EnvironmentFile uses the LAST occurrence of a duplicated key, so match
# that (take the final HIVEMEM_JWT_SECRET line) to sign with the active secret.
if [[ -r /opt/hivemem/.env ]]; then
  SECRET=$(grep '^HIVEMEM_JWT_SECRET=' /opt/hivemem/.env | tail -n1 | cut -d= -f2-)
elif sudo -n test -r /opt/hivemem/.env 2>/dev/null; then
  SECRET=$(sudo -n grep '^HIVEMEM_JWT_SECRET=' /opt/hivemem/.env | tail -n1 | cut -d= -f2-)
fi
if [[ -z "${SECRET:-}" || ${#SECRET} -lt 32 ]]; then
  echo "ERR_NO_SECRET" >&2
  exit 1
fi
HIVEMEM_JWT_SECRET="$SECRET" node -e '
const crypto = require("crypto");
const secret = process.env.HIVEMEM_JWT_SECRET;
const now = Math.floor(Date.now() / 1000);
const scopes = (process.env.ROT_SCOPES || "*").split(/[\s,]+/).filter(Boolean);
const claims = {
  iss: "hivemem",
  aud: "hivemem-api",
  sub: process.env.ROT_AGENT_ID,
  role: "agent",
  token_type: "access",
  scopes,
  jti: crypto.randomUUID(),
  iat: now,
  exp: now + parseInt(process.env.ROT_TTL_DAYS, 10) * 24 * 60 * 60,
};
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64(JSON.stringify(claims));
const sig = crypto.createHmac("sha256", secret).update(header + "." + payload).digest("base64url");
process.stdout.write(header + "." + payload + "." + sig + "\n");
'
MINT
)

TOKEN=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$MEMORY_HOST" \
  "ROT_AGENT_ID='$AGENT_ID' ROT_SCOPES='$SCOPES' ROT_TTL_DAYS='$EXPIRES_DAYS' bash -s" \
  <<< "$REMOTE_MINT" | tail -n1)

if [[ -z "$TOKEN" || "$TOKEN" != *.*.* ]]; then
  echo "ERROR: failed to mint token on $MEMORY_HOST (is HIVEMEM_JWT_SECRET present in /opt/hivemem/.env?)." >&2
  exit 1
fi
echo ">>> Minted token: ${TOKEN:0:6}…${TOKEN: -4}" >&2

if [[ "$PRINT_ONLY" == "true" ]]; then
  printf '%s\n' "$TOKEN"
  exit 0
fi

# --- Install the token without placing it in SSH argv or remote logs ----------
INSTALL_API_URL="$API_URL"
{
  printf '%s\n' "$TOKEN"
  printf '%s\n' "$INSTALL_API_URL"
  cat <<'INSTALL'
set -euo pipefail
F="$HOME/.hermes/.env"
if [[ ! -f "$F" ]]; then
  echo "ERROR: $F not found on $(hostname)." >&2
  exit 1
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
TMP="$F.tmp.$STAMP"
BACKUP="$F.bak.$STAMP"
grep -v '^HERMES_HIVEMEM_TOKEN=' "$F" > "$BACKUP"
chmod 600 "$BACKUP"
cp "$BACKUP" "$TMP"
printf 'HERMES_HIVEMEM_TOKEN=%s\n' "$TOKEN" >> "$TMP"
if [[ -n "$API_URL" ]]; then
  grep -v '^HERMES_HIVEMEM_API_URL=' "$TMP" > "$TMP.2" && mv "$TMP.2" "$TMP"
  printf 'HERMES_HIVEMEM_API_URL=%s\n' "$API_URL" >> "$TMP"
fi
mv "$TMP" "$F"
chmod 600 "$F"
echo "Installed HERMES_HIVEMEM_TOKEN into $F (credential-free backup: $BACKUP)"
INSTALL
} | ssh "${SSH_OPTS[@]}" "$SSH_USER@$HERMES_HOST" \
  'IFS= read -r TOKEN; IFS= read -r API_URL; export TOKEN API_URL; bash -s'

echo ">>> Done. Restart the Hermes gateway/agent on $HERMES_HOST for the new token to take effect."
