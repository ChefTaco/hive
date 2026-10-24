#!/usr/bin/env bash
# deploy_server.sh — Deploy the HiveMem backend to a remote host via SSH
#
# Usage:
#   ./scripts/deploy_server.sh
#   ./scripts/deploy_server.sh --env-file .env.server2
#   ./scripts/deploy_server.sh --restart-only
#   ./scripts/deploy_server.sh --dry-run
#
# Supports SSH key/agent auth or password bootstrap auth.
# Set SSH_USERNAME/SSH_HOST plus HIVEMEM_SSH_KEY or DEPLOY_SSH_KEY for key auth,
# or SSH_PASSWORD for password bootstrap auth. The target host key must already be trusted in known_hosts.
#
# What it does:
#   1. Generates a TLS certificate for the target host
#   2. Syncs the project code to /opt/hivemem on the target host
#   3. Deploys TLS certs to /opt/hivemem/certs/
#   4. Builds the TypeScript core
#   5. Installs the hivemem.service systemd unit
#   6. Starts/restarts the service
#   7. Runs a health check over HTTPS
#
# Networking:
#   HiveMem serves HTTPS on the internal port 18443 by default. The Hive Router
#   owns public 443 and proxies compatibility paths (/v1/*, dashboard) to this
#   internal listener, so the default must stay 18443 to avoid colliding with
#   the router. Set HIVEMEM_DEPLOY_WEB_PORT only for a standalone, router-less
#   host. In preserve-remote-env mode (HIVEMEM_PRESERVE_REMOTE_ENV=true) the
#   remote HIVEMEM_WEB_PORT / HIVEMEM_API_URL / HIVEMEM_CORS_ORIGINS are left
#   untouched unless a matching explicit HIVEMEM_DEPLOY_* override is provided.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERTS_DIR="$REPO_DIR/certs"
ENV_FILE="${HIVEMEM_ENV_FILE:-$REPO_DIR/.env}"
RESTART_ONLY=false
DRY_RUN=false

# Deployment controls supplied by the caller must win over same-named values
# in a host env file. Capture them before sourcing the file, then restore them.
DEPLOY_PRESERVE_REMOTE_ENV_SET="${HIVEMEM_PRESERVE_REMOTE_ENV+x}"
DEPLOY_PRESERVE_REMOTE_ENV="${HIVEMEM_PRESERVE_REMOTE_ENV:-}"
DEPLOY_REFRESH_ADMIN_TOKEN_SET="${HIVEMEM_REFRESH_ADMIN_TOKEN+x}"
DEPLOY_REFRESH_ADMIN_TOKEN="${HIVEMEM_REFRESH_ADMIN_TOKEN:-}"
DEPLOY_WEB_PORT_SET="${HIVEMEM_DEPLOY_WEB_PORT+x}"
DEPLOY_WEB_PORT="${HIVEMEM_DEPLOY_WEB_PORT:-}"
DEPLOY_API_URL_SET="${HIVEMEM_DEPLOY_API_URL+x}"
DEPLOY_API_URL_OVERRIDE="${HIVEMEM_DEPLOY_API_URL:-}"
DEPLOY_CORS_ORIGINS_SET="${HIVEMEM_DEPLOY_CORS_ORIGINS+x}"
DEPLOY_CORS_ORIGINS_OVERRIDE="${HIVEMEM_DEPLOY_CORS_ORIGINS:-}"

usage() {
  cat <<EOF
Usage:
  $0 [--env-file PATH] [--restart-only] [--dry-run]

Options:
  --env-file PATH   Load deployment credentials/config from PATH (default: .env)
  --restart-only    Restart the remote hivemem service and run the health check
  --dry-run         Validate deploy configuration and auth mode without changing the remote host

Deployment controls:
  HIVEMEM_PRESERVE_REMOTE_ENV=true keeps the target's existing private env.
  HIVEMEM_REFRESH_ADMIN_TOKEN=true explicitly refreshes its admin bearer;
  preserved environments retain the bearer by default.
EOF
}

# Parse args before loading env so deploy targets can be selected per invocation.
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-file)
      [[ $# -ge 2 ]] || { echo "ERROR: --env-file requires a path"; exit 1; }
      ENV_FILE="$2"
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#*=}"
      shift
      ;;
    --restart-only)
      RESTART_ONLY=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$REPO_DIR/$ENV_FILE"
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

[[ -z "$DEPLOY_PRESERVE_REMOTE_ENV_SET" ]] || HIVEMEM_PRESERVE_REMOTE_ENV="$DEPLOY_PRESERVE_REMOTE_ENV"
[[ -z "$DEPLOY_REFRESH_ADMIN_TOKEN_SET" ]] || HIVEMEM_REFRESH_ADMIN_TOKEN="$DEPLOY_REFRESH_ADMIN_TOKEN"
[[ -z "$DEPLOY_WEB_PORT_SET" ]] || HIVEMEM_DEPLOY_WEB_PORT="$DEPLOY_WEB_PORT"
[[ -z "$DEPLOY_API_URL_SET" ]] || HIVEMEM_DEPLOY_API_URL="$DEPLOY_API_URL_OVERRIDE"
[[ -z "$DEPLOY_CORS_ORIGINS_SET" ]] || HIVEMEM_DEPLOY_CORS_ORIGINS="$DEPLOY_CORS_ORIGINS_OVERRIDE"

PRESERVE_REMOTE_ENV="${HIVEMEM_PRESERVE_REMOTE_ENV:-false}"
if [[ "$PRESERVE_REMOTE_ENV" != "true" && "$PRESERVE_REMOTE_ENV" != "false" ]]; then
  echo "ERROR: HIVEMEM_PRESERVE_REMOTE_ENV must be true or false." >&2
  exit 1
fi
REFRESH_ADMIN_TOKEN="${HIVEMEM_REFRESH_ADMIN_TOKEN:-}"
if [[ -z "$REFRESH_ADMIN_TOKEN" ]]; then
  if [[ "$PRESERVE_REMOTE_ENV" == "true" ]]; then
    REFRESH_ADMIN_TOKEN=false
  else
    REFRESH_ADMIN_TOKEN=true
  fi
fi
if [[ "$REFRESH_ADMIN_TOKEN" != "true" && "$REFRESH_ADMIN_TOKEN" != "false" ]]; then
  echo "ERROR: HIVEMEM_REFRESH_ADMIN_TOKEN must be true or false." >&2
  exit 1
fi

# A copied local env keeps the established refresh behavior by default. A
# preserved remote env retains its existing admin bearer unless the operator
# explicitly opts in with HIVEMEM_REFRESH_ADMIN_TOKEN=true.
if [[ "$PRESERVE_REMOTE_ENV" != "true" && "$REFRESH_ADMIN_TOKEN" == "true" ]]; then
  if [[ "$DRY_RUN" != "true" ]]; then
    node "$REPO_DIR/scripts/refresh_admin_token.mjs" "$ENV_FILE"
  else
    node "$REPO_DIR/scripts/refresh_admin_token.mjs" "$ENV_FILE" --check
  fi
fi

SSH_USER="${SSH_USERNAME:-${DEPLOY_USERNAME:-deploy}}"
SSH_PASS="${SSH_PASSWORD:-${DEPLOY_PASSWORD:-}}"
SSH_KEY="${HIVEMEM_SSH_KEY:-${DEPLOY_SSH_KEY:-}}"
SUDO_PASS="${DEPLOY_SUDO_PASSWORD:-${SSH_PASS:-}}"
SSH_AUTH_PASS="$SSH_PASS"
if [[ -n "$SSH_KEY" ]]; then
  SSH_AUTH_PASS=""
fi
TARGET_HOST="${SSH_HOST:?SSH_HOST not set in $ENV_FILE}"
REMOTE_DIR="${HIVEMEM_DEPLOY_DIR:-/opt/hivemem}"
# HiveMem serves its own HTTPS listener on the internal port 18443; the Hive
# Router owns public 443 and proxies compatibility paths to this internal port.
# Default to 18443 so a standalone deploy never collides with the router or the
# router->memory proxy. HIVEMEM_DEPLOY_WEB_PORT is an explicit deploy-time
# override (used by the orchestrated scripts/deploy-hive.sh).
if [[ -n "${HIVEMEM_DEPLOY_WEB_PORT:-}" ]]; then
  WEB_PORT="$HIVEMEM_DEPLOY_WEB_PORT"
  WEB_PORT_EXPLICIT=true
else
  WEB_PORT="${HIVEMEM_WEB_PORT:-18443}"
  WEB_PORT_EXPLICIT=false
fi
DEPLOY_API_URL="${HIVEMEM_DEPLOY_API_URL:-}"
DEPLOY_CORS_ORIGINS="${HIVEMEM_DEPLOY_CORS_ORIGINS:-}"
RUNTIME="${HIVEMEM_RUNTIME:-typescript}"
if [[ "$RUNTIME" != "typescript" ]]; then
  echo "ERROR: HIVEMEM_RUNTIME must be typescript; got: $RUNTIME" >&2
  exit 1
fi
STORAGE_PATH="${HIVEMEM_STORAGE_PATH:-/var/opt/hivemem}"
BACKUP_PATH="${HIVEMEM_BACKUP_PATH:-${STORAGE_PATH}/backups}"
EMBEDDING_MODEL_PATH="${HIVEMEM_EMBEDDING_MODEL_PATH:-${STORAGE_PATH}/models/nomic-embed-text-v1.5.Q8_0.gguf}"
EMBEDDING_MODEL_DIR="$(dirname "$EMBEDDING_MODEL_PATH")"
CERT_HOST="${HIVEMEM_CERT_HOSTNAME:-$TARGET_HOST}"
CERT_ORG="${HIVEMEM_CERT_ORG:-HiveMem}"
CERT_COUNTRY="${HIVEMEM_CERT_COUNTRY:-US}"
VERIFY_HOST="${HIVEMEM_SERVER_FQDN:-$CERT_HOST}"
if [[ -n "${HIVEMEM_API_URL:-}" ]]; then
  VERIFY_HOST="$(python3 - "${HIVEMEM_API_URL}" <<'PY'
from urllib.parse import urlparse
import sys
print(urlparse(sys.argv[1]).hostname or sys.argv[1])
PY
)"
fi
CERT_EXTRA_SANS="${HIVEMEM_CERT_EXTRA_SANS:-}"

if [[ -n "$SSH_AUTH_PASS" ]] && ! command -v sshpass &>/dev/null; then
  echo "ERROR: sshpass is required for password-based deploy auth. Set HIVEMEM_SSH_KEY or DEPLOY_SSH_KEY to use key auth."
  exit 1
fi

# Password SSH is bootstrap-only. Require an explicit opt-in so key/agent auth is
# the default for routine deploys.
DEPLOY_ALLOW_PASSWORD="${DEPLOY_ALLOW_PASSWORD:-false}"
if [[ -n "$SSH_AUTH_PASS" && "$DEPLOY_ALLOW_PASSWORD" != "true" ]]; then
  echo "ERROR: password-based SSH deploy requires DEPLOY_ALLOW_PASSWORD=true." >&2
  echo "       Prefer key auth: set HIVEMEM_SSH_KEY or DEPLOY_SSH_KEY (or use an SSH agent)." >&2
  echo "       For a one-time bootstrap, re-run with DEPLOY_ALLOW_PASSWORD=true." >&2
  exit 1
fi

if [[ -n "$SSH_AUTH_PASS" ]]; then
  export SSHPASS="$SSH_AUTH_PASS"
fi
KNOWN_HOSTS_FILE="${HIVEMEM_SSH_KNOWN_HOSTS_FILE:-$HOME/.ssh/known_hosts}"
SSH_OPTS=(
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$KNOWN_HOSTS_FILE"
  -o ConnectTimeout=15
  -o NumberOfPasswordPrompts=1
)
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi
if [[ -z "$SSH_AUTH_PASS" ]]; then
  SSH_OPTS+=(-o BatchMode=yes)
else
  SSH_OPTS+=(-o BatchMode=no)
fi
SSH_OPTS_STRING="${SSH_OPTS[*]}"

if ! ssh-keygen -F "$TARGET_HOST" -f "$KNOWN_HOSTS_FILE" >/dev/null 2>&1; then
  echo "ERROR: SSH host key for ${TARGET_HOST} is not present in ${KNOWN_HOSTS_FILE}." >&2
  echo "Add and verify the host key before deploying, for example:" >&2
  echo "  ssh-keyscan -H ${TARGET_HOST} >> ${KNOWN_HOSTS_FILE}" >&2
  exit 1
fi

remote_cmd() {
  if [[ -n "$SSH_AUTH_PASS" ]]; then
    SSHPASS="$SSH_AUTH_PASS" sshpass -e ssh "${SSH_OPTS[@]}" "${SSH_USER}@${TARGET_HOST}" "$@"
  else
    ssh "${SSH_OPTS[@]}" "${SSH_USER}@${TARGET_HOST}" "$@"
  fi
}

remote_copy() {
  if [[ -n "$SSH_AUTH_PASS" ]]; then
    SSHPASS="$SSH_AUTH_PASS" sshpass -e scp "${SSH_OPTS[@]}" "$@"
  else
    scp "${SSH_OPTS[@]}" "$@"
  fi
}

remote_rsync() {
  if [[ -n "$SSH_AUTH_PASS" ]]; then
    SSHPASS="$SSH_AUTH_PASS" sshpass -e rsync "$@"
  else
    rsync "$@"
  fi
}

remote_sudo() {
  local script="$*"
  if [[ -n "$SUDO_PASS" ]]; then
    printf '%s
%s
' "$SUDO_PASS" "$script" | remote_cmd "sudo -S -p '' bash -s"
  else
    printf '%s
' "$script" | remote_cmd "sudo -n bash -s"
  fi
}

echo ""
echo "=============================================="
echo "HiveMem Backend Deployment"
echo "Target: ${TARGET_HOST}"
echo "Remote: ${REMOTE_DIR}"
echo "Env:    ${ENV_FILE}"
echo "Port:   ${WEB_PORT} (HTTPS)"
echo "Runtime:$RUNTIME"
echo "Storage:${STORAGE_PATH}"
echo "EnvSync:$(if [[ "$PRESERVE_REMOTE_ENV" == "true" ]]; then echo preserve-remote; else echo copy-local; fi)"
echo "AdminTokenRefresh:${REFRESH_ADMIN_TOKEN}"
echo "Mode:   $(if $DRY_RUN; then echo dry-run; elif $RESTART_ONLY; then echo restart-only; else echo full-deploy; fi)"
if [[ -n "$SSH_AUTH_PASS" ]]; then
  echo "SSH:    password bootstrap mode"
elif [[ -n "$SSH_KEY" ]]; then
  echo "SSH:    key file $SSH_KEY"
else
  echo "SSH:    SSH agent/default key mode"
fi
if [[ -n "$SUDO_PASS" ]]; then
  echo "Sudo:   password supplied"
else
  echo "Sudo:   passwordless sudo (-n)"
fi
echo "=============================================="

if $DRY_RUN; then
  if [[ "$PRESERVE_REMOTE_ENV" == "true" ]]; then
    remote_cmd "test -f '${REMOTE_DIR}/.env' && secret=\$(grep '^HIVEMEM_JWT_SECRET=' '${REMOTE_DIR}/.env' | tail -n 1 | cut -d= -f2-) && test \${#secret} -ge 32"
    echo "Remote HiveMem env exists and its JWT secret passes the minimum length check."
  fi
  echo "Dry-run complete: deploy configuration, SSH auth mode, sudo mode, and known_hosts entry are valid."
  exit 0
fi

if $RESTART_ONLY; then
  echo ""
  echo "[1/2] Restarting hivemem service ..."
  remote_sudo "systemctl restart hivemem"
  echo "  Service restarted."

  echo "[2/2] Health check ..."
  HEALTH=$(remote_cmd \
    "curl --fail --silent --show-error --cacert '${REMOTE_DIR}/certs/server.crt' --resolve '${VERIFY_HOST}:${WEB_PORT}:127.0.0.1' --retry 20 --retry-delay 1 --retry-connrefused 'https://${VERIFY_HOST}:${WEB_PORT}/v1/health/ready' 2>/dev/null" || echo "FAIL")

  if echo "$HEALTH" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    echo "  Health OK: $HEALTH"
  else
    echo "  ERROR: Health check failed or degraded. Check: journalctl -u hivemem -n 50"
    echo "  Health response: $HEALTH"
    exit 1
  fi
  echo ""
  echo "=== Restart complete ==="
  exit 0
fi

# ── Full deployment ───────────────────────────────────────────────────────────

echo ""
echo "[1/8] Generating TLS certificate ..."
mkdir -p "$CERTS_DIR"

# Get target host's IPs for SANs
REMOTE_IPS=$(remote_cmd "hostname -I" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | sed 's/^/IP:/' | paste -sd, -)
API_HOST=""
# Prefer the deploy-time API URL override (HIVEMEM_DEPLOY_API_URL, passed by
# scripts/deploy-hive.sh) so the public FQDN lands in the cert SANs even when the
# deploy env file omits HIVEMEM_API_URL. Fall back to the env file's value.
CERT_API_URL="${DEPLOY_API_URL:-${HIVEMEM_API_URL:-}}"
if [[ -n "$CERT_API_URL" ]]; then
  API_HOST=$(python3 - "${CERT_API_URL}" <<'PY'
from urllib.parse import urlparse
import sys
parsed = urlparse(sys.argv[1])
print(parsed.hostname or "")
PY
)
fi
SANS="DNS:localhost,DNS:${TARGET_HOST},DNS:${CERT_HOST},IP:127.0.0.1"
if [[ -n "$API_HOST" ]]; then
  SANS="${SANS},DNS:${API_HOST}"
  VERIFY_HOST="$API_HOST"
fi
if [[ -n "$REMOTE_IPS" ]]; then
  SANS="${SANS},${REMOTE_IPS}"
fi
if [[ -n "$CERT_EXTRA_SANS" ]]; then
  SANS="${SANS},${CERT_EXTRA_SANS}"
fi

openssl req -x509 -newkey rsa:2048 \
  -keyout "$CERTS_DIR/server.key" \
  -out "$CERTS_DIR/server.crt" \
  -days 365 -nodes \
  -subj "/CN=${CERT_HOST}/O=${CERT_ORG}/C=${CERT_COUNTRY}" \
  -addext "subjectAltName=${SANS}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  2>/dev/null

chmod 600 "$CERTS_DIR/server.key"
chmod 644 "$CERTS_DIR/server.crt"
echo "  TLS cert generated (SANs: ${SANS})"

echo "[2/8] Preparing remote directory ..."
remote_sudo "mkdir -p ${REMOTE_DIR} && chown ${SSH_USER}:${SSH_USER} ${REMOTE_DIR}"

echo "[3/8] Syncing project files ..."
# Use rsync if available, fall back to tar+scp
if command -v rsync &>/dev/null; then
  remote_rsync -az --delete \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude 'tests' \
    --exclude 'hivemem.egg-info' \
    --exclude 'certs' \
    -e "ssh $SSH_OPTS_STRING" \
    "$REPO_DIR/" "${SSH_USER}@${TARGET_HOST}:${REMOTE_DIR}/"
else
  echo "  rsync not found, using tar+scp ..."
  TMPTAR=$(mktemp /tmp/hivemem-deploy-XXXXXX.tar.gz)
  tar czf "$TMPTAR" -C "$REPO_DIR" \
    --exclude='.venv' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='tests' \
    --exclude='hivemem.egg-info' \
    --exclude='certs' \
    .
  remote_copy "$TMPTAR" "${SSH_USER}@${TARGET_HOST}:/tmp/hivemem-deploy.tar.gz"
  remote_cmd "cd ${REMOTE_DIR} && tar xzf /tmp/hivemem-deploy.tar.gz && rm -f /tmp/hivemem-deploy.tar.gz"
  rm -f "$TMPTAR"
fi
echo "  Files synced."

echo "[4/8] Deploying TLS certs ..."
remote_sudo "mkdir -p ${REMOTE_DIR}/certs"
remote_copy "$CERTS_DIR/server.crt" "${SSH_USER}@${TARGET_HOST}:/tmp/hivemem-server.crt"
remote_copy "$CERTS_DIR/server.key" "${SSH_USER}@${TARGET_HOST}:/tmp/hivemem-server.key"
remote_sudo "mv /tmp/hivemem-server.crt ${REMOTE_DIR}/certs/server.crt && \
  mv /tmp/hivemem-server.key ${REMOTE_DIR}/certs/server.key && \
  chown hivemem:hivemem ${REMOTE_DIR}/certs/server.key ${REMOTE_DIR}/certs/server.crt 2>/dev/null || true && \
  chmod 600 ${REMOTE_DIR}/certs/server.key && \
  chmod 644 ${REMOTE_DIR}/certs/server.crt"
echo "  TLS certs deployed."

echo "[5/8] Syncing .env configuration ..."
if [[ "$PRESERVE_REMOTE_ENV" == "true" ]]; then
  remote_cmd "test -f '${REMOTE_DIR}/.env'"
  if [[ "$REFRESH_ADMIN_TOKEN" == "true" ]]; then
    remote_cmd "node '${REMOTE_DIR}/scripts/refresh_admin_token.mjs' '${REMOTE_DIR}/.env'"
  fi
  # Only touch the remote web port when an explicit deploy override was given;
  # otherwise preserve the live value (avoids clobbering e.g. 18443 with a
  # default and breaking the router->memory proxy).
  if [[ "$WEB_PORT_EXPLICIT" == "true" ]]; then
    remote_cmd "if grep -q '^HIVEMEM_WEB_PORT=' ${REMOTE_DIR}/.env; then sed -i 's|^HIVEMEM_WEB_PORT=.*|HIVEMEM_WEB_PORT=${WEB_PORT}|' ${REMOTE_DIR}/.env; else printf '%s\n' 'HIVEMEM_WEB_PORT=${WEB_PORT}' >> ${REMOTE_DIR}/.env; fi"
  fi
  if [[ -n "$DEPLOY_API_URL" ]]; then
    remote_cmd "if grep -q '^HIVEMEM_API_URL=' ${REMOTE_DIR}/.env; then sed -i 's|^HIVEMEM_API_URL=.*|HIVEMEM_API_URL=${DEPLOY_API_URL}|' ${REMOTE_DIR}/.env; else printf '%s\n' 'HIVEMEM_API_URL=${DEPLOY_API_URL}' >> ${REMOTE_DIR}/.env; fi"
  fi
  if [[ -n "$DEPLOY_CORS_ORIGINS" ]]; then
    remote_cmd "if grep -q '^HIVEMEM_CORS_ORIGINS=' ${REMOTE_DIR}/.env; then sed -i 's|^HIVEMEM_CORS_ORIGINS=.*|HIVEMEM_CORS_ORIGINS=${DEPLOY_CORS_ORIGINS}|' ${REMOTE_DIR}/.env; else printf '%s\n' 'HIVEMEM_CORS_ORIGINS=${DEPLOY_CORS_ORIGINS}' >> ${REMOTE_DIR}/.env; fi"
  fi
  remote_cmd "if grep -q '^HIVEMEM_RUNTIME=' ${REMOTE_DIR}/.env; then sed -i 's|^HIVEMEM_RUNTIME=.*|HIVEMEM_RUNTIME=${RUNTIME}|' ${REMOTE_DIR}/.env; else printf '%s\n' 'HIVEMEM_RUNTIME=${RUNTIME}' >> ${REMOTE_DIR}/.env; fi"
  remote_cmd "chmod 600 ${REMOTE_DIR}/.env"
  if [[ "$WEB_PORT_EXPLICIT" == "true" ]]; then
    echo "  Preserved remote .env, retained its admin token, set web port to ${WEB_PORT}, applied endpoint settings, and secured it (chmod 600)."
  else
    echo "  Preserved remote .env (including its web port and admin token), applied endpoint settings, and secured it (chmod 600)."
  fi
  if [[ "$REFRESH_ADMIN_TOKEN" == "true" ]]; then
    echo "  Refreshed the preserved remote admin token by explicit request."
  fi
elif [[ -f "$ENV_FILE" ]]; then
  remote_copy "$ENV_FILE" "${SSH_USER}@${TARGET_HOST}:${REMOTE_DIR}/.env"
  remote_cmd "if grep -q '^HIVEMEM_WEB_PORT=' ${REMOTE_DIR}/.env; then sed -i 's|^HIVEMEM_WEB_PORT=.*|HIVEMEM_WEB_PORT=${WEB_PORT}|' ${REMOTE_DIR}/.env; else printf '%s\n' 'HIVEMEM_WEB_PORT=${WEB_PORT}' >> ${REMOTE_DIR}/.env; fi"
  if [[ -n "$DEPLOY_API_URL" ]]; then
    remote_cmd "if grep -q '^HIVEMEM_API_URL=' ${REMOTE_DIR}/.env; then sed -i 's|^HIVEMEM_API_URL=.*|HIVEMEM_API_URL=${DEPLOY_API_URL}|' ${REMOTE_DIR}/.env; else printf '%s\n' 'HIVEMEM_API_URL=${DEPLOY_API_URL}' >> ${REMOTE_DIR}/.env; fi"
  fi
  if [[ -n "$DEPLOY_CORS_ORIGINS" ]]; then
    remote_cmd "if grep -q '^HIVEMEM_CORS_ORIGINS=' ${REMOTE_DIR}/.env; then sed -i 's|^HIVEMEM_CORS_ORIGINS=.*|HIVEMEM_CORS_ORIGINS=${DEPLOY_CORS_ORIGINS}|' ${REMOTE_DIR}/.env; else printf '%s\n' 'HIVEMEM_CORS_ORIGINS=${DEPLOY_CORS_ORIGINS}' >> ${REMOTE_DIR}/.env; fi"
  fi
  remote_cmd "if grep -q '^HIVEMEM_RUNTIME=' ${REMOTE_DIR}/.env; then sed -i 's|^HIVEMEM_RUNTIME=.*|HIVEMEM_RUNTIME=${RUNTIME}|' ${REMOTE_DIR}/.env; else printf '%s\n' 'HIVEMEM_RUNTIME=${RUNTIME}' >> ${REMOTE_DIR}/.env; fi"
  remote_cmd "chmod 600 ${REMOTE_DIR}/.env"
  echo "  $(basename "$ENV_FILE") copied to remote .env, web port set to ${WEB_PORT}, runtime set to ${RUNTIME}, and secured (chmod 600)."
else
  echo "  WARNING: No env file found. Make sure ${REMOTE_DIR}/.env exists on the target."
fi

echo "[6/8] Building TypeScript core ..."
remote_cmd "command -v node >/dev/null && command -v npm >/dev/null"
remote_cmd bash <<TS_SCRIPT
  set -e
  cd ${REMOTE_DIR}/ts-core
  npm ci --silent
  npm run build --silent
  npm prune --omit=dev --silent || true
  echo "  TypeScript core built."
TS_SCRIPT

echo "[7/8] Creating service user + installing systemd service ..."
remote_sudo "id -u hivemem &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin hivemem"
# Ensure hivemem user can read the project (but .env stays owned by deployer)
remote_sudo "chown -R ${SSH_USER}:hivemem ${REMOTE_DIR} && chmod -R g+rX ${REMOTE_DIR}"
# The recursive group-read normalization above is for code/runtime assets only.
# Reassert strict modes on secrets and private keys after it completes.
remote_sudo "chmod 600 ${REMOTE_DIR}/.env && chmod 640 ${REMOTE_DIR}/certs/server.key"
# Ensure standalone storage, backup, model, and audit log directories exist
remote_sudo "mkdir -p ${STORAGE_PATH} ${BACKUP_PATH} ${EMBEDDING_MODEL_DIR} ${STORAGE_PATH}/lib /var/log/hivemem && \
  if [[ ! -f ${EMBEDDING_MODEL_PATH} && -f /mnt/swarm/hivemem/models/nomic-embed-text-v1.5.Q8_0.gguf ]]; then \
    cp -n /mnt/swarm/hivemem/models/nomic-embed-text-v1.5.Q8_0.gguf ${EMBEDDING_MODEL_PATH}; \
  fi && \
  chown -R hivemem:hivemem ${STORAGE_PATH} /var/log/hivemem"

SERVICE_UNIT="$REPO_DIR/docker/hivemem-ts.service"
remote_copy "$SERVICE_UNIT" "${SSH_USER}@${TARGET_HOST}:/tmp/hivemem.service"
remote_sudo "mv /tmp/hivemem.service /etc/systemd/system/hivemem.service && \
  chmod 644 /etc/systemd/system/hivemem.service && \
  systemctl daemon-reload && \
  systemctl enable hivemem"
echo "  Service installed and enabled."

echo "[8/8] Starting service + health check ..."
remote_sudo "systemctl restart hivemem"

HEALTH=$(remote_cmd \
  "curl --fail --silent --show-error --cacert '${REMOTE_DIR}/certs/server.crt' --resolve '${VERIFY_HOST}:${WEB_PORT}:127.0.0.1' --retry 20 --retry-delay 1 --retry-connrefused 'https://${VERIFY_HOST}:${WEB_PORT}/v1/health/ready' 2>/dev/null" || echo "FAIL")

if echo "$HEALTH" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  echo "  Health OK: $HEALTH"
else
  echo "  ERROR: Health check failed or degraded after start."
  echo "  Health response: $HEALTH"
  echo "  Check logs: ssh ${TARGET_HOST} journalctl -u hivemem -n 50"
  exit 1
fi

# Router pins this backend's self-signed certificate. A full deployment
# generates a new certificate, so refresh the pin and Router's TLS context.
ROUTER_CA='/opt/hive-router/shared/certs/hivemem-ca.crt'
if remote_cmd "test -f '$ROUTER_CA'"; then
  remote_sudo "install -m 0644 '${REMOTE_DIR}/certs/server.crt' '$ROUTER_CA' && systemctl restart hive-router"
  echo "  Hive Router pinned certificate refreshed."
fi

# Show service status
echo ""
echo "Service status:"
remote_sudo "systemctl status hivemem --no-pager -l" 2>/dev/null | head -15 || true

echo ""
echo "=============================================="
echo "Deployment complete: ${TARGET_HOST}"
echo "  URL:      https://${TARGET_HOST}:${WEB_PORT}/v1/health/ready"
echo "  Service:  systemctl {start|stop|restart|status} hivemem"
echo "  Logs:     journalctl -u hivemem -f"
echo "=============================================="
