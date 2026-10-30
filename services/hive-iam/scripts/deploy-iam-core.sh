#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-iam-core.sh — Build and deploy Hive IAM Core
#
# Builds the Hive IAM Core API, packages it into a tarball, uploads via SCP,
# installs deps, generates Prisma client, builds, migrates, seeds (first run),
# and restarts the systemd service.
#
# Usage:
#   bash scripts/deploy-iam-core.sh              # deploy
#   bash scripts/deploy-iam-core.sh --seed       # deploy + force re-seed
#   bash scripts/deploy-iam-core.sh --dry-run    # build + package only
#
# Required environment (deploy; not needed for --dry-run):
#   HIVE_IAM_DEPLOY_HOST            — SSH host that runs hive-iam
#   HIVE_PUBLIC_URL                 — public Hive URL, e.g. https://hive.example.com
#                                     (CORS_ORIGIN or SEED_HIVE_PUBLIC_URL also accepted)
#
# First-install secrets (generated with openssl when unset; stored only in the
# root-protected target .env; reused from that file on later deploys):
#   COOKIE_SECRET, IAM_AGENT_SECRET, SEED_HIVE_CLIENT_SECRET,
#   SEED_HIVE_ROUTER_CLIENT_SECRET (>= 32 characters), SEED_ADMIN_PASSWORD (>= 16)
#
# Optional environment:
#   DEPLOY_USER (default: deploy), DEPLOY_SSH_KEY / HIVE_IAM_DEPLOY_SSH_KEY,
#   DEPLOY_PASSWORD + DEPLOY_ALLOW_PASSWORD=true (bootstrap only),
#   DEPLOY_SUDO_PASSWORD, HIVE_IAM_PUBLIC_FQDN, HIVE_IAM_DEPLOY_PATH (default: /opt/hive-iam),
#   SEED_ADMIN_EMAIL, SEED_ADMIN_USERNAME, SEED_HIVE_ROUTER_REDIRECT_URI,
#   SEED_SECURITY_EXPORTER_CLIENT_SECRET, SEED_EXAMPLE_PORTAL_CLIENT_SECRET,
#   SEED_EXAMPLE_PORTAL_REDIRECT_URI
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_ROOT="$(cd "$WORKSPACE_ROOT/../.." && pwd)"
REPO_ROOT="$WORKSPACE_ROOT/apps/iam-core"
CERTS_DIR="$WORKSPACE_ROOT/certs"
TARBALL="/tmp/.iam-api-deploy.tar.gz"
REMOTE_HOST="${HIVE_IAM_DEPLOY_HOST:-}"
REMOTE_PATH="${HIVE_IAM_DEPLOY_PATH:-/opt/hive-iam}"
SERVICE_NAME="${HIVE_IAM_SERVICE_NAME:-hive-iam}"
SERVICE_USER="${HIVE_IAM_SERVICE_USER:-hive-iam}"

# ── Parse flags ───────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE_SEED=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --seed)      FORCE_SEED=true ;;
    -h|--help)
      sed -n '2,/^# ──/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Load env ──────────────────────────────────────────────────────────────────
# Source IAM API .env for seed secrets, then workspace-level deploy password
[[ -f "$MONOREPO_ROOT/.env" ]] && { set -a; source "$MONOREPO_ROOT/.env"; set +a; }
[[ -f "$WORKSPACE_ROOT/.env" ]] && { set -a; source "$WORKSPACE_ROOT/.env"; set +a; }
[[ -f "$REPO_ROOT/.env" ]] && { set -a; source "$REPO_ROOT/.env"; set +a; }

PUBLIC_FQDN="${HIVE_IAM_PUBLIC_FQDN:-${REMOTE_HOST}}"
SSH_USER="${DEPLOY_USER:-${DEPLOY_USERNAME:-deploy}}"
SSH_PASS="${DEPLOY_PASSWORD:-}"
SSH_KEY="${HIVE_IAM_DEPLOY_SSH_KEY:-${DEPLOY_SSH_KEY:-}}"
SUDO_PASS="${DEPLOY_SUDO_PASSWORD:-${SSH_PASS:-}}"
SSH_AUTH_PASS="$SSH_PASS"
if [[ -n "$SSH_KEY" ]]; then
  SSH_AUTH_PASS=""
fi

# Password SSH is bootstrap-only. Require an explicit opt-in so key/agent auth is
# the default for routine deploys.
DEPLOY_ALLOW_PASSWORD="${DEPLOY_ALLOW_PASSWORD:-false}"
if [[ -n "$SSH_AUTH_PASS" && "$DEPLOY_ALLOW_PASSWORD" != "true" ]]; then
  echo "ERROR: password-based SSH deploy requires DEPLOY_ALLOW_PASSWORD=true." >&2
  echo "       Prefer key auth: set HIVE_IAM_DEPLOY_SSH_KEY or DEPLOY_SSH_KEY (or use an SSH agent)." >&2
  echo "       For a one-time bootstrap, re-run with DEPLOY_ALLOW_PASSWORD=true." >&2
  exit 1
fi

if [[ -n "$SSH_AUTH_PASS" ]] && ! command -v sshpass >/dev/null 2>&1; then
  echo "ERROR: sshpass is required for password-based deploy auth. Set HIVE_IAM_DEPLOY_SSH_KEY or DEPLOY_SSH_KEY to use key auth."
  exit 1
fi

[[ "$REMOTE_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "ERROR: unsafe HIVE_IAM_DEPLOY_PATH: $REMOTE_PATH" >&2; exit 1; }
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo "ERROR: unsafe HIVE_IAM_SERVICE_NAME: $SERVICE_NAME" >&2; exit 1; }
[[ "$SERVICE_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*[$]?$ ]] || { echo "ERROR: unsafe HIVE_IAM_SERVICE_USER: $SERVICE_USER" >&2; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo -e "\033[1;34m>>>\033[0m $*"; }
ok()    { echo -e "\033[1;32m>>>\033[0m $*"; }
err()   { echo -e "\033[1;31m>>>\033[0m $*" >&2; }

SSH_OPTIONS=(-o StrictHostKeyChecking=accept-new -o UpdateHostKeys=yes -o LogLevel=ERROR)
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTIONS+=(-i "$SSH_KEY")
fi
if [[ -z "$SSH_AUTH_PASS" ]]; then
  SSH_OPTIONS+=(-o BatchMode=yes)
fi

if [[ -n "$SSH_AUTH_PASS" ]]; then
  info "Deploy SSH auth: password bootstrap mode"
elif [[ -n "$SSH_KEY" ]]; then
  info "Deploy SSH auth: key file $SSH_KEY"
else
  info "Deploy SSH auth: SSH agent/default key mode"
fi
if [[ -z "$SUDO_PASS" ]]; then
  info "Remote sudo auth: passwordless sudo (-n)"
else
  info "Remote sudo auth: password supplied via DEPLOY_SUDO_PASSWORD/deploy password"
fi

remote_exec() {
  if [[ -n "$SSH_AUTH_PASS" ]]; then
    SSHPASS="$SSH_AUTH_PASS" sshpass -e ssh "${SSH_OPTIONS[@]}" "$SSH_USER@$REMOTE_HOST" "$@"
  else
    ssh "${SSH_OPTIONS[@]}" "$SSH_USER@$REMOTE_HOST" "$@"
  fi
}

remote_scp() {
  if [[ -n "$SSH_AUTH_PASS" ]]; then
    SSHPASS="$SSH_AUTH_PASS" sshpass -e scp "${SSH_OPTIONS[@]}" "$@"
  else
    scp "${SSH_OPTIONS[@]}" "$@"
  fi
}

# ── Pre-flight checks ────────────────────────────────────────────────────────
if [[ ! -f "$CERTS_DIR/iam-private.pem" ]] || [[ ! -f "$CERTS_DIR/iam-public.pem" ]]; then
  err "Missing IAM RS256 keys in $CERTS_DIR/. Run: bash scripts/generate-keys.sh"
  exit 1
fi

# ── Production env values ─────────────────────────────────────────────────────
# Secrets are taken from the environment when provided, otherwise generated
# with openssl. There are no literal secret defaults. These values are written
# only to the root-protected target .env on a first install and are never
# printed; routine redeploys reuse the values already in the target .env unless
# a replacement is explicitly provisioned below.
require_secret() {
  local name="$1" min="$2" value="${3:-}"
  if [[ ${#value} -lt $min ]]; then
    err "$name must contain at least $min characters"
    exit 1
  fi
}

if [[ "$DRY_RUN" != "true" ]]; then
  [[ -n "$REMOTE_HOST" ]] || { err "HIVE_IAM_DEPLOY_HOST is required"; exit 1; }
  [[ "$REMOTE_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { err "unsafe HIVE_IAM_DEPLOY_HOST: $REMOTE_HOST"; exit 1; }
  [[ "$PUBLIC_FQDN" =~ ^[A-Za-z0-9.-]+$ ]] || { err "unsafe HIVE_IAM_PUBLIC_FQDN: $PUBLIC_FQDN"; exit 1; }

  PROD_HIVE_PUBLIC_URL="${SEED_HIVE_PUBLIC_URL:-${HIVE_PUBLIC_URL:-${CORS_ORIGIN:-}}}"
  PROD_HIVE_PUBLIC_URL="${PROD_HIVE_PUBLIC_URL%/}"
  [[ "$PROD_HIVE_PUBLIC_URL" =~ ^https://[A-Za-z0-9.:-]+$ ]] || {
    err "HIVE_PUBLIC_URL (or CORS_ORIGIN) is required and must be an https:// origin"
    exit 1
  }

  PROD_COOKIE_SECRET="${COOKIE_SECRET:-$(openssl rand -hex 32)}"
  PROD_IAM_AGENT_SECRET="${IAM_AGENT_SECRET:-$(openssl rand -hex 32)}"
  PROD_SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-admin@iam.local}"
  PROD_SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-$(openssl rand -hex 16)}"
  PROD_SEED_ADMIN_USERNAME="${SEED_ADMIN_USERNAME:-admin}"
  PROD_SEED_HIVE_CLIENT_SECRET="${SEED_HIVE_CLIENT_SECRET:-$(openssl rand -hex 32)}"
  PROD_SEED_HIVE_ROUTER_CLIENT_SECRET="${SEED_HIVE_ROUTER_CLIENT_SECRET:-${HIVE_ROUTER_IAM_CLIENT_SECRET:-$(openssl rand -hex 32)}}"
  PROD_SEED_HIVE_ROUTER_REDIRECT_URI="${SEED_HIVE_ROUTER_REDIRECT_URI:-${HIVE_ROUTER_IAM_REDIRECT_URI:-${PROD_HIVE_PUBLIC_URL}/api/auth/oidc/callback}}"
  PROD_SEED_SECURITY_EXPORTER_CLIENT_SECRET="${SEED_SECURITY_EXPORTER_CLIENT_SECRET:-}"
  PROD_SEED_EXAMPLE_PORTAL_CLIENT_SECRET_WAS_PROVIDED=false
  if [[ -n "${SEED_EXAMPLE_PORTAL_CLIENT_SECRET:-}" ]]; then
    PROD_SEED_EXAMPLE_PORTAL_CLIENT_SECRET_WAS_PROVIDED=true
  fi
  PROD_SEED_EXAMPLE_PORTAL_CLIENT_SECRET="${SEED_EXAMPLE_PORTAL_CLIENT_SECRET:-}"
  PROD_SEED_EXAMPLE_PORTAL_REDIRECT_URI="${SEED_EXAMPLE_PORTAL_REDIRECT_URI:-https://client.example.com/api/auth/callback/hive-iam}"
  PROD_CORS_ORIGIN="${CORS_ORIGIN:-$PROD_HIVE_PUBLIC_URL}"

  require_secret COOKIE_SECRET 32 "$PROD_COOKIE_SECRET"
  require_secret IAM_AGENT_SECRET 32 "$PROD_IAM_AGENT_SECRET"
  require_secret SEED_ADMIN_PASSWORD 16 "$PROD_SEED_ADMIN_PASSWORD"
  require_secret SEED_HIVE_CLIENT_SECRET 32 "$PROD_SEED_HIVE_CLIENT_SECRET"
  require_secret SEED_HIVE_ROUTER_CLIENT_SECRET 32 "$PROD_SEED_HIVE_ROUTER_CLIENT_SECRET"
  if [[ -n "$PROD_SEED_SECURITY_EXPORTER_CLIENT_SECRET" ]]; then
    require_secret SEED_SECURITY_EXPORTER_CLIENT_SECRET 32 "$PROD_SEED_SECURITY_EXPORTER_CLIENT_SECRET"
  fi
  if [[ -n "$PROD_SEED_EXAMPLE_PORTAL_CLIENT_SECRET" ]]; then
    require_secret SEED_EXAMPLE_PORTAL_CLIENT_SECRET 32 "$PROD_SEED_EXAMPLE_PORTAL_CLIENT_SECRET"
  fi
fi

# ── Build ─────────────────────────────────────────────────────────────────────

cd "$REPO_ROOT"
info "Generating Prisma client..."
npx prisma generate
ok "Prisma client generated"

info "Building hive-iam-core..."
npm run build
ok "Build complete"

# ── Package tarball ───────────────────────────────────────────────────────────
info "Packaging deployment tarball..."
tar czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.db' \
  --exclude='*.db-journal' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  --exclude='audit-logs' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*.tsbuildinfo' \
  --exclude='docker' \
  -C "$REPO_ROOT" .

SIZE_MB=$(du -m "$TARBALL" | cut -f1)
ok "Tarball created: ${SIZE_MB}MB"

if [[ "$DRY_RUN" == "true" ]]; then
  ok "Dry run — tarball at $TARBALL. Skipping upload."
  exit 0
fi

# ── Upload tarball + bootstrap signing keys ───────────────────────────────────
info "Uploading to $REMOTE_HOST..."
remote_scp "$TARBALL" "$SSH_USER@$REMOTE_HOST:/tmp/iam-api-deploy.tar.gz"
remote_scp "$CERTS_DIR/iam-private.pem" "$SSH_USER@$REMOTE_HOST:/tmp/iam-private.pem"
remote_scp "$CERTS_DIR/iam-public.pem" "$SSH_USER@$REMOTE_HOST:/tmp/iam-public.pem"
rm -f "$TARBALL"
ok "Upload complete"

# ── Deploy on target ─────────────────────────────────────────────────────────
info "Deploying on $REMOTE_HOST..."

ESCAPED_PASS=$(printf '%s' "$SUDO_PASS" | sed "s/'/'\\\\''/g")

remote_exec bash -s -- "$FORCE_SEED" <<DEPLOY_SCRIPT
set -e
SUDO_PASS='${ESCAPED_PASS}'
FORCE_SEED="\$1"
do_sudo() {
  local output rc
  output=\$(mktemp)
  rc=0
  if [[ -n "\$SUDO_PASS" ]]; then
    printf '%s\n' "\$SUDO_PASS" | sudo -S -p '' "\$@" > "\$output" 2>&1 || rc=\$?
  else
    sudo -n "\$@" > "\$output" 2>&1 || rc=\$?
  fi
  grep -v '\[sudo\]' "\$output" || true
  rm -f "\$output"
  return "\$rc"
}
upsert_env() {
  local file="\$1" key="\$2" value="\$3"
  if grep -q "^\${key}=" "\$file" 2>/dev/null; then
    sed -i "s|^\${key}=.*|\${key}=\${value}|" "\$file"
  else
    printf '%s=%s\n' "\$key" "\$value" >> "\$file"
  fi
}

do_sudo mkdir -p ${REMOTE_PATH}
do_sudo chown \$USER:\$USER ${REMOTE_PATH}
if ! id -u '${SERVICE_USER}' >/dev/null 2>&1; then
  echo ">>> Creating ${SERVICE_USER} runtime user..."
  do_sudo useradd --system --home-dir ${REMOTE_PATH} --shell /usr/sbin/nologin '${SERVICE_USER}'
fi

if ! command -v redis-server >/dev/null 2>&1; then
  echo ">>> Installing Redis for IAM queues..."
  do_sudo apt-get update
  do_sudo apt-get install -y redis-server
fi
do_sudo systemctl enable --now redis-server

cd ${REMOTE_PATH}

# Check if first install
FIRST_INSTALL=false
[[ ! -f package.json ]] && FIRST_INSTALL=true

echo ">>> Preparing writable deployment tree..."
HELPER_STAGE=\$(mktemp -d /tmp/hive-iam-helper-stage.XXXXXX)
chmod 700 "\$HELPER_STAGE"
tar xzf /tmp/iam-api-deploy.tar.gz -C "\$HELPER_STAGE" \
  ./scripts/rotate-jwt-signing-key.sh \
  ./scripts/validate-jwt-keyring.mjs
do_sudo chown -R \$USER:\$USER ${REMOTE_PATH}

echo ">>> Extracting update..."
tar xzf /tmp/iam-api-deploy.tar.gz --overwrite
rm -f /tmp/iam-api-deploy.tar.gz
# In-place upgrades retain files absent from the new archive. Remove the retired
# password-escrow module explicitly so old deployments cannot compile or expose it.
rm -f src/services/crypto-service.ts dist/services/crypto-service.js dist/services/crypto-service.js.map

# Preserve the host's active signing keyring across routine code deployments.
# The checked-out keys are bootstrap material only; rotation is host-managed.
mkdir -p keys certs
if [[ ! -f keys/iam-private.pem || ! -f keys/iam-public.pem ]]; then
  echo ">>> Installing bootstrap JWT signing keypair..."
  mv /tmp/iam-private.pem keys/iam-private.pem
  mv /tmp/iam-public.pem keys/iam-public.pem
else
  echo ">>> Preserving host-managed JWT signing keyring"
  rm -f /tmp/iam-private.pem /tmp/iam-public.pem
fi
chmod 600 keys/iam-private.pem
chmod 644 keys/iam-public.pem

# Keep the private CA outside the service's writable/readable sandbox. Routine
# deployments issue a fresh 30-day IAM leaf while Router trusts only this
# long-lived CA certificate.
PKI_DIR=/var/lib/hive-iam-pki
do_sudo mkdir -p "\$PKI_DIR"
do_sudo chmod 700 "\$PKI_DIR"
if ! do_sudo test -f "\$PKI_DIR/ca.key" && ! do_sudo test -f "\$PKI_DIR/ca.crt"; then
  echo ">>> Generating host-persistent Hive IAM private CA..."
  do_sudo openssl genrsa -out "\$PKI_DIR/ca.key" 4096
  do_sudo openssl req -x509 -new -sha256 -key "\$PKI_DIR/ca.key" \
    -out "\$PKI_DIR/ca.crt" -days 3650 \
    -subj "/CN=Hive IAM Private CA/O=Hive/C=US" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  do_sudo chmod 600 "\$PKI_DIR/ca.key"
  do_sudo chmod 644 "\$PKI_DIR/ca.crt"
elif ! do_sudo test -f "\$PKI_DIR/ca.key" || ! do_sudo test -f "\$PKI_DIR/ca.crt"; then
  echo "ERROR: Hive IAM private CA is incomplete; refusing to replace the trust anchor" >&2
  exit 1
fi
openssl req -new -newkey rsa:3072 -nodes \
  -keyout /tmp/iam-server.key -out /tmp/iam-server.csr \
  -subj "/CN=${REMOTE_HOST}/O=Hive/C=US" \
  -addext "subjectAltName=DNS:${REMOTE_HOST},DNS:${PUBLIC_FQDN},DNS:localhost,IP:127.0.0.1"
cat > /tmp/iam-server.ext <<'EXTEOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:${REMOTE_HOST},DNS:${PUBLIC_FQDN},DNS:localhost,IP:127.0.0.1
EXTEOF
do_sudo openssl x509 -req -sha256 -in /tmp/iam-server.csr \
  -CA "\$PKI_DIR/ca.crt" -CAkey "\$PKI_DIR/ca.key" -CAcreateserial \
  -out /tmp/iam-server.crt -days 30 -extfile /tmp/iam-server.ext
do_sudo chown "\$USER:\$USER" /tmp/iam-server.crt
mv /tmp/iam-server.key certs/server.key
mv /tmp/iam-server.crt certs/server.crt
do_sudo cat "\$PKI_DIR/ca.crt" > certs/ca-bundle.crt
if do_sudo test -f "\$PKI_DIR/next-ca.crt"; then
  echo ">>> Adding staged next IAM CA to the consumer trust bundle..."
  do_sudo openssl x509 -in "\$PKI_DIR/next-ca.crt" -noout >/dev/null
  if ! do_sudo openssl x509 -in "\$PKI_DIR/next-ca.crt" -noout -text | grep -q 'CA:TRUE'; then
    echo "ERROR: staged next IAM certificate is not a CA" >&2
    exit 1
  fi
  CURRENT_CA_FINGERPRINT=\$(do_sudo openssl x509 -in "\$PKI_DIR/ca.crt" -noout -fingerprint -sha256)
  NEXT_CA_FINGERPRINT=\$(do_sudo openssl x509 -in "\$PKI_DIR/next-ca.crt" -noout -fingerprint -sha256)
  if [[ "\$CURRENT_CA_FINGERPRINT" == "\$NEXT_CA_FINGERPRINT" ]]; then
    echo "ERROR: staged next IAM CA duplicates the current CA" >&2
    exit 1
  fi
  do_sudo cat "\$PKI_DIR/next-ca.crt" >> certs/ca-bundle.crt
fi
# ca.crt remains as a compatibility alias containing the same PEM bundle.
cp certs/ca-bundle.crt certs/ca.crt
rm -f /tmp/iam-server.csr /tmp/iam-server.ext
chmod 600 certs/server.key
chmod 644 certs/server.crt certs/ca.crt certs/ca-bundle.crt

# Write .env if missing
if [[ ! -f .env ]]; then
  echo ">>> Writing .env..."
  cat > .env << 'ENVEOF'
NODE_ENV=production

# SQLite
DATABASE_URL=file:./prisma/iam.db

# Redis
REDIS_URL=redis://localhost:6379
REDIS_PREFIX=hive-iam

# RS256 keys
JWT_PRIVATE_KEY_PATH=keys/iam-private.pem
JWT_PUBLIC_KEY_PATH=keys/iam-public.pem
JWT_PREVIOUS_PUBLIC_KEY_PATHS=
JWT_ISSUER=hive-iam
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=604800

# Session cookie
COOKIE_SECRET=${PROD_COOKIE_SECRET}

# Agent secret
IAM_AGENT_SECRET=${PROD_IAM_AGENT_SECRET}

# TLS
TLS_CERT_PATH=certs/server.crt
TLS_KEY_PATH=certs/server.key
PORT=4200
MAX_REQUEST_BODY_BYTES=1048576
TRUSTED_PROXY_IPS=127.0.0.1,::1,::ffff:127.0.0.1

# Audit logs
AUDIT_LOG_DIR=./audit-logs
AUDIT_MAX_AGE_DAYS=365

# CORS
CORS_ORIGIN=${PROD_CORS_ORIGIN}

# Rate limiting
RATE_LIMIT_MAX_ATTEMPTS=5
RATE_LIMIT_WINDOW_MS=900000

# Seed values
SEED_ADMIN_EMAIL=${PROD_SEED_ADMIN_EMAIL}
SEED_ADMIN_PASSWORD=${PROD_SEED_ADMIN_PASSWORD}
SEED_ADMIN_USERNAME=${PROD_SEED_ADMIN_USERNAME}
SEED_HIVE_CLIENT_SECRET=${PROD_SEED_HIVE_CLIENT_SECRET}
SEED_HIVE_ROUTER_CLIENT_SECRET=${PROD_SEED_HIVE_ROUTER_CLIENT_SECRET}
SEED_HIVE_PUBLIC_URL=${PROD_HIVE_PUBLIC_URL}
SEED_HIVE_ROUTER_REDIRECT_URI=${PROD_SEED_HIVE_ROUTER_REDIRECT_URI}
SEED_SECURITY_EXPORTER_CLIENT_SECRET=${PROD_SEED_SECURITY_EXPORTER_CLIENT_SECRET}
SEED_EXAMPLE_PORTAL_CLIENT_SECRET=${PROD_SEED_EXAMPLE_PORTAL_CLIENT_SECRET}
SEED_EXAMPLE_PORTAL_REDIRECT_URI=${PROD_SEED_EXAMPLE_PORTAL_REDIRECT_URI}
ENVEOF
  chmod 600 .env
  echo ">>> .env written"
else
  echo ">>> .env already exists — keeping"
fi

sed -i '/^PASSWORD_ENCRYPTION_KEY=/d' .env
upsert_env .env MAX_REQUEST_BODY_BYTES '1048576'
upsert_env .env TRUSTED_PROXY_IPS '127.0.0.1,::1,::ffff:127.0.0.1'
EXISTING_ROUTER_CLIENT_SECRET=\$(grep "^SEED_HIVE_ROUTER_CLIENT_SECRET=" .env 2>/dev/null | cut -d= -f2- || true)
BOOTSTRAPPED_ROUTER_CLIENT_SECRET=false
if [[ \${#EXISTING_ROUTER_CLIENT_SECRET} -lt 32 ]]; then
  if [[ "\$FIRST_INSTALL" != "true" ]]; then
    echo "ERROR: existing IAM install has no recoverable Router client secret; refusing silent credential replacement" >&2
    echo "       Provision or rotate the client through the audited IAM client lifecycle before redeploying." >&2
    exit 1
  fi
  BOOTSTRAPPED_ROUTER_CLIENT_SECRET=true
  upsert_env .env SEED_HIVE_ROUTER_CLIENT_SECRET '${PROD_SEED_HIVE_ROUTER_CLIENT_SECRET}'
fi
upsert_env .env SEED_HIVE_PUBLIC_URL '${PROD_HIVE_PUBLIC_URL}'
upsert_env .env SEED_HIVE_ROUTER_REDIRECT_URI '${PROD_SEED_HIVE_ROUTER_REDIRECT_URI}'
if [[ -n '${PROD_SEED_SECURITY_EXPORTER_CLIENT_SECRET}' ]]; then
  upsert_env .env SEED_SECURITY_EXPORTER_CLIENT_SECRET '${PROD_SEED_SECURITY_EXPORTER_CLIENT_SECRET}'
fi
EXISTING_EXAMPLE_PORTAL_CLIENT_SECRET=\$(grep '^SEED_EXAMPLE_PORTAL_CLIENT_SECRET=' .env 2>/dev/null | cut -d= -f2- || true)
BOOTSTRAPPED_EXAMPLE_PORTAL_CLIENT_SECRET=false
if [[ '${PROD_SEED_EXAMPLE_PORTAL_CLIENT_SECRET_WAS_PROVIDED}' == 'true' ]]; then
  if [[ \${#EXISTING_EXAMPLE_PORTAL_CLIENT_SECRET} -lt 32 ]]; then
    BOOTSTRAPPED_EXAMPLE_PORTAL_CLIENT_SECRET=true
  fi
  upsert_env .env SEED_EXAMPLE_PORTAL_CLIENT_SECRET '${PROD_SEED_EXAMPLE_PORTAL_CLIENT_SECRET}'
fi
upsert_env .env SEED_EXAMPLE_PORTAL_REDIRECT_URI '${PROD_SEED_EXAMPLE_PORTAL_REDIRECT_URI}'

# Create audit-logs directory
mkdir -p audit-logs

echo ">>> Installing dependencies..."
npm ci

echo ">>> Generating Prisma client..."
npm run db:generate

echo ">>> Rebuilding on target..."
# Never let host-local incremental compiler state influence release artifacts.
# The uploaded source and lockfile must produce the same dist tree everywhere.
npm run clean
npm run build

# Seed on first install, if forced, or when an older host just received a
# first-party client secret needed by Router or the example portal.
if [[ "\$FIRST_INSTALL" == "true" || "\$FORCE_SEED" == "true" || "\$BOOTSTRAPPED_ROUTER_CLIENT_SECRET" == "true" || "\$BOOTSTRAPPED_EXAMPLE_PORTAL_CLIENT_SECRET" == "true" ]]; then
  bash scripts/run-db-release-gate.sh --seed
  if [[ "\$FIRST_INSTALL" == "true" ]]; then
    SEEDED_USER=\$(grep '^SEED_ADMIN_USERNAME=' .env | cut -d= -f2-)
    SEEDED_PASS=\$(grep '^SEED_ADMIN_PASSWORD=' .env | cut -d= -f2-)
    SECRETS_FILE="/root/hive-iam-first-install-secrets-\$(date -u +%Y%m%dT%H%M%SZ).env"
    ESCAPED_SEEDED_USER=\$(printf '%s' "\$SEEDED_USER" | sed "s/'/'\\''/g")
    ESCAPED_SEEDED_PASS=\$(printf '%s' "\$SEEDED_PASS" | sed "s/'/'\\''/g")
    do_sudo bash -c "umask 077; printf '%s\n' 'SEED_ADMIN_USERNAME=\${ESCAPED_SEEDED_USER}' 'SEED_ADMIN_PASSWORD=\${ESCAPED_SEEDED_PASS}' > '\${SECRETS_FILE}'"
    echo ">>> Seeded IAM admin account. Initial credentials were stored on the target at \${SECRETS_FILE} (root-only)."
    echo ">>> Retrieve them with sudo, store them securely, then rotate the password after first login."
  else
    echo ">>> Routine IAM seed applied; no credential handoff file was created."
  fi
else
  bash scripts/run-db-release-gate.sh --no-seed
fi

echo ">>> Pruning dev dependencies from runtime install..."
npm prune --omit=dev

echo ">>> Installing root-owned JWT rotation helpers..."
HELPER_DIR=/usr/local/libexec/hive-iam
KEYRING_ROOT=/var/lib/hive-iam-keyring
DESTRUCTION_LOG=/var/log/hive-iam-key-destruction.log

# Deployment artifacts are attacker-controlled if the runtime account can
# replace them with links or special files. Inspect the exact helper tree before
# privileged installation, then install only the allowlisted helpers.
if find "\$HELPER_STAGE" -type l -print -quit | grep -q . ||
   find "\$HELPER_STAGE" ! -type d ! -type f -print -quit | grep -q .; then
  echo "ERROR: IAM helper source contains a symlink or unexpected file type" >&2
  exit 1
fi
do_sudo install -d -o root -g root -m 755 /usr/local/libexec "\$HELPER_DIR"
do_sudo install -o root -g root -m 755 \
  "\$HELPER_STAGE/scripts/rotate-jwt-signing-key.sh" \
  "\$HELPER_DIR/rotate-jwt-signing-key.sh"
do_sudo install -o root -g root -m 644 \
  "\$HELPER_STAGE/scripts/validate-jwt-keyring.mjs" \
  "\$HELPER_DIR/validate-jwt-keyring.mjs"
rm -rf -- "\$HELPER_STAGE"

echo ">>> Preparing root-only atomic JWT keyring..."
do_sudo install -d -o root -g '${SERVICE_USER}' -m 750 "\$KEYRING_ROOT" "\$KEYRING_ROOT/releases"
if do_sudo test -e "\$KEYRING_ROOT/current" && ! do_sudo test -L "\$KEYRING_ROOT/current"; then
  echo "ERROR: JWT keyring current path exists but is not a symlink" >&2
  exit 1
fi
if ! do_sudo test -L "\$KEYRING_ROOT/current"; then
  BOOTSTRAP_RELEASE="bootstrap-\$(date -u +%Y%m%dT%H%M%SZ)-\$\$"
  BOOTSTRAP_DIR="\$KEYRING_ROOT/releases/\$BOOTSTRAP_RELEASE"
  do_sudo install -d -o root -g '${SERVICE_USER}' -m 750 "\$BOOTSTRAP_DIR" "\$BOOTSTRAP_DIR/previous"
  do_sudo install -o root -g '${SERVICE_USER}' -m 640 ${REMOTE_PATH}/keys/iam-private.pem "\$BOOTSTRAP_DIR/active-private.pem"
  do_sudo install -o root -g '${SERVICE_USER}' -m 644 ${REMOTE_PATH}/keys/iam-public.pem "\$BOOTSTRAP_DIR/active-public.pem"
  PREVIOUS_PATHS=\$(grep '^JWT_PREVIOUS_PUBLIC_KEY_PATHS=' ${REMOTE_PATH}/.env 2>/dev/null | cut -d= -f2- || true)
  BOOTSTRAP_PREVIOUS=""
  IFS=',' read -r -a PREVIOUS_KEYS <<< "\$PREVIOUS_PATHS"
  for relative_path in "\${PREVIOUS_KEYS[@]}"; do
    [[ -n "\$relative_path" ]] || continue
    if [[ ! "\$relative_path" =~ ^keys/previous/[A-Za-z0-9._-]+\\.pem$ ]] ||
       [[ -L "${REMOTE_PATH}/\$relative_path" ]] ||
       [[ ! -f "${REMOTE_PATH}/\$relative_path" ]]; then
      echo "ERROR: refusing unsafe legacy previous-key path: \$relative_path" >&2
      exit 1
    fi
    filename="\${relative_path##*/}"
    do_sudo install -o root -g '${SERVICE_USER}' -m 644 "${REMOTE_PATH}/\$relative_path" "\$BOOTSTRAP_DIR/previous/\$filename"
    BOOTSTRAP_PREVIOUS="\${BOOTSTRAP_PREVIOUS:+\$BOOTSTRAP_PREVIOUS,}\$KEYRING_ROOT/current/previous/\$filename"
  done
  do_sudo bash -c "umask 077; cat > '\$BOOTSTRAP_DIR/keyring.env' <<EOF
JWT_PRIVATE_KEY_PATH=\$KEYRING_ROOT/current/active-private.pem
JWT_PUBLIC_KEY_PATH=\$KEYRING_ROOT/current/active-public.pem
JWT_PREVIOUS_PUBLIC_KEY_PATHS=\$BOOTSTRAP_PREVIOUS
EOF"
  do_sudo chown root:'${SERVICE_USER}' "\$BOOTSTRAP_DIR/keyring.env"
  do_sudo chmod 640 "\$BOOTSTRAP_DIR/keyring.env"
  do_sudo node "\$HELPER_DIR/validate-jwt-keyring.mjs" "\$BOOTSTRAP_DIR" >/dev/null
  do_sudo ln -s "releases/\$BOOTSTRAP_RELEASE" "\$KEYRING_ROOT/current"
fi
CURRENT_KEYRING=\$(do_sudo readlink -f "\$KEYRING_ROOT/current")
case "\$CURRENT_KEYRING" in
  "\$KEYRING_ROOT/releases/"*) ;;
  *) echo "ERROR: JWT keyring current link escapes the release root" >&2; exit 1 ;;
esac
do_sudo node "\$HELPER_DIR/validate-jwt-keyring.mjs" "\$CURRENT_KEYRING" >/dev/null
upsert_env ${REMOTE_PATH}/.env JWT_PRIVATE_KEY_PATH "\$KEYRING_ROOT/current/active-private.pem"
upsert_env ${REMOTE_PATH}/.env JWT_PUBLIC_KEY_PATH "\$KEYRING_ROOT/current/active-public.pem"

# The root-only keyring is now authoritative. Do not retain plaintext private
# key copies in the service tree.
rm -rf ${REMOTE_PATH}/keys
do_sudo touch "\$DESTRUCTION_LOG"
do_sudo chown root:root "\$DESTRUCTION_LOG"
do_sudo chmod 600 "\$DESTRUCTION_LOG"

echo ">>> Setting least-privilege runtime ownership..."
do_sudo chown -R root:'${SERVICE_USER}' ${REMOTE_PATH}
do_sudo find ${REMOTE_PATH} -type d -exec chmod 750 {} +
do_sudo find ${REMOTE_PATH} -type f -exec chmod 640 {} +
do_sudo chmod 750 ${REMOTE_PATH}
do_sudo chmod 750 ${REMOTE_PATH}/certs
do_sudo chmod 640 ${REMOTE_PATH}/.env ${REMOTE_PATH}/certs/server.key
do_sudo chmod 644 ${REMOTE_PATH}/certs/server.crt ${REMOTE_PATH}/certs/ca.crt ${REMOTE_PATH}/certs/ca-bundle.crt
do_sudo chown -R '${SERVICE_USER}:${SERVICE_USER}' ${REMOTE_PATH}/prisma ${REMOTE_PATH}/audit-logs
do_sudo chmod 750 ${REMOTE_PATH}/prisma ${REMOTE_PATH}/audit-logs
do_sudo find ${REMOTE_PATH}/prisma ${REMOTE_PATH}/audit-logs -type f -exec chmod 640 {} +

# Write systemd service
echo ">>> Writing systemd service..."
do_sudo bash -c "cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SVCEOF'
[Unit]
Description=Hive IAM Core API
After=network.target redis-server.service

[Service]
Type=simple
WorkingDirectory=${REMOTE_PATH}
EnvironmentFile=${REMOTE_PATH}/.env
EnvironmentFile=\$KEYRING_ROOT/current/keyring.env
ExecStart=/usr/bin/node ${REMOTE_PATH}/dist/index.js
Restart=always
RestartSec=5
User=${SERVICE_USER}
Group=${SERVICE_USER}
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectClock=true
ProtectHostname=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=${REMOTE_PATH}/prisma ${REMOTE_PATH}/audit-logs
TimeoutStopSec=20
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF"

do_sudo systemctl daemon-reload
do_sudo systemctl enable ${SERVICE_NAME}
do_sudo systemctl restart ${SERVICE_NAME}

sleep 3

if do_sudo systemctl is-active --quiet ${SERVICE_NAME}; then
  echo ">>> Service is running"
else
  echo ">>> WARNING: Service may still be starting"
  do_sudo journalctl -u ${SERVICE_NAME} --no-pager -n 20 || true
fi

unset SUDO_PASS
DEPLOY_SCRIPT

ok "Deployment complete!"
if [[ -n "$SUDO_PASS" ]]; then
  printf '%s\n' "$SUDO_PASS" | remote_exec "sudo -S -p '' cat '$REMOTE_PATH/certs/ca-bundle.crt'" > "$CERTS_DIR/iam-ca.crt"
else
  remote_exec "sudo -n cat '$REMOTE_PATH/certs/ca-bundle.crt'" > "$CERTS_DIR/iam-ca.crt"
fi
chmod 644 "$CERTS_DIR/iam-ca.crt"
curl --fail --silent --show-error --cacert "$CERTS_DIR/iam-ca.crt" \
  "https://$PUBLIC_FQDN:4200/api/v1/health/ready" >/dev/null
ok "Hostname-verified private-CA readiness passed for $PUBLIC_FQDN"
