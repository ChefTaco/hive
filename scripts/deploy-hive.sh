#!/usr/bin/env bash
# Deploy Hive services to a single host (HIVE_DEPLOY_HOST).
#
# Order matters:
# 1. HiveMem starts on an internal HTTPS port for memory API/dashboard traffic.
# 2. Hive IAM starts on 4200.
# 3. Hive Router serves the official unified Hive UI on public 443 and proxies
#    HiveMem compatibility paths back to the internal HiveMem listener.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Treat the repository .env as deployment defaults. Values supplied by the
# operator in the process environment are authoritative so an explicit
# invocation for a secondary host cannot be redirected to the primary
# installation by a host-specific value in the local .env.
load_env_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -v "$key" ]] && continue
    value="${value%$'\r'}"
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$file"
}

load_env_file "$ROOT_DIR/.env"

MEMORY_ENV_FILE="${HIVEMEM_ENV_FILE:-$ROOT_DIR/services/hive-mem/.env}"
if [[ "$MEMORY_ENV_FILE" != /* ]]; then
  MEMORY_ENV_FILE="$ROOT_DIR/$MEMORY_ENV_FILE"
fi
HIVE_DEPLOY_HOST="${HIVE_DEPLOY_HOST:-}"
HIVE_PUBLIC_FQDN="${HIVE_PUBLIC_FQDN:-}"
HIVEMEM_INTERNAL_WEB_PORT="${HIVEMEM_DEPLOY_WEB_PORT:-18443}"
HIVE_DEPLOY_SKIP_VERIFY="${HIVE_DEPLOY_SKIP_VERIFY:-false}"
HIVE_DEPLOY_VERIFY_PLAYWRIGHT="${HIVE_DEPLOY_VERIFY_PLAYWRIGHT:-false}"
HIVE_DEPLOY_DRY_RUN="${HIVE_DEPLOY_DRY_RUN:-false}"
HIVE_DEPLOY_FORCE_IAM_SEED="${HIVE_DEPLOY_FORCE_IAM_SEED:-false}"
HIVE_DEPLOY_ROUTER_IAM_SECRET="${HIVE_DEPLOY_ROUTER_IAM_SECRET:-}"
if [[ "$HIVE_DEPLOY_FORCE_IAM_SEED" == "true" && -z "$HIVE_DEPLOY_ROUTER_IAM_SECRET" ]]; then
  HIVE_DEPLOY_ROUTER_IAM_SECRET="$(openssl rand -hex 32)"
fi

usage() {
  cat <<EOF
Usage:
  $0 [--dry-run]
  $0 --rollback [release-id]

Options:
  --dry-run             Run each service deploy in dry-run mode and skip live verification
  --rollback [id]       Roll the Hive Router back to the previous (or a specific) release and restart

Environment (process env or repository .env):
  HIVE_DEPLOY_HOST      SSH host to deploy to (required), e.g. hive
  HIVE_PUBLIC_FQDN      Public DNS name served by the Router (required), e.g. hive.example.com
  HIVE_PUBLIC_URL       Public base URL (default: https://\$HIVE_PUBLIC_FQDN)
  HIVE_DEPLOY_SKILLS    Also deploy the optional Hive Skills service (default: false)
EOF
}

HIVE_ROLLBACK=false
HIVE_ROLLBACK_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      HIVE_DEPLOY_DRY_RUN=true
      shift
      ;;
    --rollback)
      HIVE_ROLLBACK=true
      shift
      # An optional non-flag argument is the target release id.
      if [[ $# -gt 0 && "$1" != --* ]]; then
        HIVE_ROLLBACK_ID="$1"
        shift
      fi
      ;;
    --rollback=*)
      HIVE_ROLLBACK=true
      HIVE_ROLLBACK_ID="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$HIVE_DEPLOY_HOST" ]]; then
  echo "ERROR: HIVE_DEPLOY_HOST is required (set it in the environment or the repository .env)." >&2
  exit 1
fi

read_env_key() {
  local file="$1" wanted="$2" line key value found=""
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" == "$wanted" ]] || continue
    value="${value%$'\r'}"
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    found="$value"
  done < "$file"
  printf '%s' "$found"
}

probe_json_url() {
  local label="$1" url="$2"
  shift 2
  printf '>>> Verifying %s...\n' "$label"
  local output
  if ! output=$(curl --fail --silent --show-error --max-time 15 --retry 6 --retry-delay 2 --retry-connrefused "$@" "$url"); then
    printf 'ERROR: %s probe failed: %s\n' "$label" "$url" >&2
    return 1
  fi
  if [[ "$output" != *'"status"'* && "$output" != *'"ok"'* ]]; then
    printf 'ERROR: %s probe returned an unexpected payload.\n' "$label" >&2
    return 1
  fi
}

verify_hive_deploy() {
  if [[ "$HIVE_DEPLOY_SKIP_VERIFY" == "true" ]]; then
    echo ">>> Skipping post-deploy verification because HIVE_DEPLOY_SKIP_VERIFY=true."
    return 0
  fi

  probe_json_url "Hive UI/admin readiness" "${HIVE_PUBLIC_URL}/health/ready"
  probe_json_url "HiveMem public readiness" "${HIVE_PUBLIC_URL}/v1/health/ready"
  probe_json_url "Hive IAM readiness" "https://${HIVE_PUBLIC_FQDN}:4200/api/v1/health/ready" \
    --cacert "$ROOT_DIR/services/hive-iam/certs/iam-ca.crt"
  probe_json_url "Hive Router API readiness" "https://${HIVE_PUBLIC_FQDN}:4020/health/ready"

  local verify_auth_mode="${HIVE_DEPLOY_VERIFY_AUTH_MODE:-${HIVE_ROUTER_AUTH_MODE:-iam-oidc}}"
  local verify_user="${HIVE_DEPLOY_VERIFY_USERNAME:-${HIVE_ROUTER_E2E_USERNAME:-admin}}"
  local verify_pass="${HIVE_DEPLOY_VERIFY_PASSWORD:-${HIVE_ROUTER_E2E_PASSWORD:-}}"
  if [[ -z "$verify_pass" && "$verify_auth_mode" == "os" ]]; then
    verify_user="${HIVE_DEPLOY_VERIFY_USERNAME:-${HIVE_ROUTER_E2E_USERNAME:-${DEPLOY_USERNAME:-deploy}}}"
    verify_pass="${DEPLOY_PASSWORD:-}"
  fi
  if [[ -n "$verify_pass" ]]; then
    local cookie_jar
    cookie_jar=$(mktemp /tmp/hive-deploy-cookies-XXXXXX)
    trap 'rm -f "$cookie_jar"' RETURN
    printf '>>> Verifying authenticated Hive status...\n'
    local login_payload
    login_payload=$(HIVE_VERIFY_USER="$verify_user" HIVE_VERIFY_PASS="$verify_pass" node -e 'console.log(JSON.stringify({username: process.env.HIVE_VERIFY_USER, password: process.env.HIVE_VERIFY_PASS}))')
    curl --fail --silent --show-error --max-time 15 -c "$cookie_jar" \
      -H 'content-type: application/json' \
      --data "$login_payload" \
      "${HIVE_PUBLIC_URL}/api/auth/login" >/dev/null
    local status_payload
    status_payload=$(curl --fail --silent --show-error --max-time 15 -b "$cookie_jar" "${HIVE_PUBLIC_URL}/api/hive/status")
    if [[ "$status_payload" != *'"apps"'* || "$status_payload" != *'"iam"'* || "$status_payload" != *'"memory"'* || "$status_payload" != *'"router"'* ]]; then
      echo "ERROR: authenticated Hive status did not include IAM, Memory, and Router apps." >&2
      return 1
    fi
    printf '>>> Verifying authenticated IAM proxy...\n'
    local iam_proxy_payload
    iam_proxy_payload=$(curl --fail --silent --show-error --max-time 15 -b "$cookie_jar" "${HIVE_PUBLIC_URL}/api/iam/users?limit=1")
    if [[ "$iam_proxy_payload" == *"IAM proxy token unavailable"* || "$iam_proxy_payload" == *"IAM Proxy token unavailable"* ]]; then
      echo "ERROR: authenticated IAM proxy could not obtain its server-side token." >&2
      return 1
    fi
    printf '>>> Verifying authenticated Memory proxy...\n'
    local memory_proxy_payload
    memory_proxy_payload=$(curl --fail --silent --show-error --max-time 15 -b "$cookie_jar" "${HIVE_PUBLIC_URL}/api/memory/dashboard-data")
    if [[ "$memory_proxy_payload" == *"HIVE_ROUTER_MEMORY_PROXY_TOKEN is not configured"* || "$memory_proxy_payload" == *'"configured":false'* ]]; then
      echo "ERROR: authenticated Memory proxy is missing HIVE_ROUTER_MEMORY_PROXY_TOKEN." >&2
      return 1
    fi
    rm -f "$cookie_jar"
    trap - RETURN
  else
    echo ">>> Skipping authenticated /api/hive/status verification because no deploy verification password is available."
  fi

  if [[ "$HIVE_DEPLOY_VERIFY_PLAYWRIGHT" == "true" ]]; then
    if [[ -z "$verify_pass" ]]; then
      echo "ERROR: HIVE_DEPLOY_VERIFY_PLAYWRIGHT=true requires HIVE_DEPLOY_VERIFY_PASSWORD or HIVE_ROUTER_E2E_PASSWORD. Set HIVE_DEPLOY_VERIFY_AUTH_MODE=os only for PAM-mode verification." >&2
      return 1
    fi
    echo ">>> Running live Hive UI Playwright verification..."
    (
      cd services/hive-router
      HIVE_ROUTER_E2E_BASE_URL="$HIVE_PUBLIC_URL" \
      HIVE_ROUTER_E2E_USERNAME="$verify_user" \
      HIVE_ROUTER_E2E_PASSWORD="$verify_pass" \
      HIVE_ROUTER_E2E_DENIED_USERNAME="${HIVE_ROUTER_E2E_DENIED_USERNAME:-nobodyxyz}" \
        npx playwright test
    )
  fi
}

cd "$ROOT_DIR"

if [[ -n "${HIVEMEM_ENV_FILE:-}" ]]; then
  MEMORY_ENV_FILE="$HIVEMEM_ENV_FILE"
  if [[ "$MEMORY_ENV_FILE" != /* ]]; then
    MEMORY_ENV_FILE="$ROOT_DIR/$MEMORY_ENV_FILE"
  fi
fi
export HIVE_ROUTER_AUTH_MODE="${HIVE_ROUTER_AUTH_MODE:-os}"
export HIVE_DEPLOY_VERIFY_AUTH_MODE="${HIVE_DEPLOY_VERIFY_AUTH_MODE:-$HIVE_ROUTER_AUTH_MODE}"

# Rollback delegates to the Hive Router atomic-release rollback (the router is the
# public-facing service with staged releases). It flips `current` to a prior
# release and restarts, no rebuild required.
if [[ "$HIVE_ROLLBACK" == "true" ]]; then
  ROLLBACK_ARGS=(--rollback)
  [[ -n "$HIVE_ROLLBACK_ID" ]] && ROLLBACK_ARGS=("--rollback=$HIVE_ROLLBACK_ID")
  [[ "$HIVE_DEPLOY_DRY_RUN" == "true" ]] && ROLLBACK_ARGS+=(--dry-run)
  echo ">>> Rolling back Hive Router on ${HIVE_DEPLOY_HOST} to ${HIVE_ROLLBACK_ID:-the previous release}..."
  HIVE_ROUTER_DEPLOY_HOST="$HIVE_DEPLOY_HOST" \
    bash services/hive-router/scripts/deploy-hive-router.sh "${ROLLBACK_ARGS[@]}"
  echo ">>> Hive Router rollback complete."
  exit 0
fi

if [[ -z "$HIVE_PUBLIC_FQDN" ]]; then
  echo "ERROR: HIVE_PUBLIC_FQDN is required, e.g. HIVE_PUBLIC_FQDN=hive.example.com." >&2
  exit 1
fi
HIVE_PUBLIC_URL="${HIVE_PUBLIC_URL:-https://${HIVE_PUBLIC_FQDN}}"

if [[ ! -f "$MEMORY_ENV_FILE" ]]; then
  echo "ERROR: HiveMem env file not found: $MEMORY_ENV_FILE" >&2
  echo "Set HIVEMEM_ENV_FILE to the private HiveMem deploy env for $HIVE_DEPLOY_HOST." >&2
  exit 1
fi

# Keep the server-to-server admin credential valid under the strict JWT policy.
# The helper updates only the private env file and never prints the token.
if [[ "${HIVEMEM_PRESERVE_REMOTE_ENV:-false}" != "true" ]]; then
  if [[ "$HIVE_DEPLOY_DRY_RUN" != "true" ]]; then
    node services/hive-mem/scripts/refresh_admin_token.mjs "$MEMORY_ENV_FILE"
  else
    node services/hive-mem/scripts/refresh_admin_token.mjs "$MEMORY_ENV_FILE" --check
  fi
fi

if [[ -z "${HIVE_ROUTER_MEMORY_PROXY_TOKEN:-}" ]]; then
  HIVE_ROUTER_MEMORY_PROXY_TOKEN="$(read_env_key "$MEMORY_ENV_FILE" HIVEMEM_ADMIN_TOKEN)"
  if [[ -z "$HIVE_ROUTER_MEMORY_PROXY_TOKEN" ]]; then
    HIVE_ROUTER_MEMORY_PROXY_TOKEN="$(read_env_key "$MEMORY_ENV_FILE" HERMES_HIVEMEM_TOKEN)"
  fi
  if [[ -z "$HIVE_ROUTER_MEMORY_PROXY_TOKEN" ]]; then
    HIVE_ROUTER_MEMORY_PROXY_TOKEN="$(read_env_key "$MEMORY_ENV_FILE" HIVEMEM_MCP_TOKEN)"
  fi
  export HIVE_ROUTER_MEMORY_PROXY_TOKEN
fi

DRY_RUN_ARGS=()
if [[ "$HIVE_DEPLOY_DRY_RUN" == "true" ]]; then
  DRY_RUN_ARGS+=(--dry-run)
fi
IAM_DEPLOY_ARGS=("${DRY_RUN_ARGS[@]}")
if [[ "$HIVE_DEPLOY_FORCE_IAM_SEED" == "true" ]]; then
  IAM_DEPLOY_ARGS+=(--seed)
fi

echo ">>> Deploying Hive Memory..."
HIVEMEM_DEPLOY_WEB_PORT="$HIVEMEM_INTERNAL_WEB_PORT" \
HIVEMEM_DEPLOY_API_URL="$HIVE_PUBLIC_URL" \
HIVEMEM_DEPLOY_CORS_ORIGINS="$HIVE_PUBLIC_URL" \
  bash services/hive-mem/scripts/deploy_server.sh --env-file "$MEMORY_ENV_FILE" "${DRY_RUN_ARGS[@]}"

echo ">>> Deploying Hive IAM..."
HIVE_IAM_DEPLOY_HOST="$HIVE_DEPLOY_HOST" \
HIVE_IAM_PUBLIC_FQDN="$HIVE_PUBLIC_FQDN" \
CORS_ORIGIN="$HIVE_PUBLIC_URL" \
SEED_HIVE_ROUTER_CLIENT_SECRET="$HIVE_DEPLOY_ROUTER_IAM_SECRET" \
  bash services/hive-iam/scripts/deploy-iam-core.sh "${IAM_DEPLOY_ARGS[@]}"

# The HiveMem listener is intentionally not exposed on the public address. The short deployment host resolves locally on each installation and
# remains covered by the generated HiveMem certificate SANs.
echo ">>> Deploying Hive Router / UI..."
HIVE_ROUTER_DEPLOY_HOST="$HIVE_DEPLOY_HOST" \
HIVE_ROUTER_CERT_DOMAIN="$HIVE_PUBLIC_FQDN" \
HIVE_ROUTER_PUBLIC_ADMIN_URL="$HIVE_PUBLIC_URL" \
HIVE_UI_PUBLIC_URL="$HIVE_PUBLIC_URL" \
HIVE_ROUTER_AUTH_MODE="$HIVE_ROUTER_AUTH_MODE" \
HIVEMEM_INTERNAL_URL="https://${HIVE_DEPLOY_HOST}:${HIVEMEM_INTERNAL_WEB_PORT}" \
HIVEMEM_PUBLIC_URL="$HIVE_PUBLIC_URL" \
HIVE_IAM_INTERNAL_URL="https://${HIVE_PUBLIC_FQDN}:4200" \
HIVE_ROUTER_IAM_CLIENT_SECRET="$HIVE_DEPLOY_ROUTER_IAM_SECRET" \
  bash services/hive-router/scripts/deploy-hive-router.sh "${DRY_RUN_ARGS[@]}"

if [[ "${HIVE_DEPLOY_SKILLS:-false}" == true ]]; then
  if [[ "$HIVE_DEPLOY_DRY_RUN" == true ]]; then echo ">>> Skills release would deploy on $HIVE_DEPLOY_HOST after Router certificates.";
  else HIVE_SKILLS_DEPLOY_HOST="$HIVE_DEPLOY_HOST" HIVE_SKILLS_DEPLOY_USER="${DEPLOY_USERNAME:-deploy}" HIVE_SKILLS_DEPLOY_SUDO_PASSWORD="${DEPLOY_SUDO_PASSWORD:-}" bash services/hive-skills/scripts/deploy-hive-skills.sh; fi
fi
echo ">>> Hive deploy complete."
if [[ "$HIVE_DEPLOY_DRY_RUN" == "true" ]]; then
  echo ">>> Dry-run complete; skipped live verification."
else
  verify_hive_deploy
  echo ">>> Unified UI verified: ${HIVE_PUBLIC_URL}"
fi
