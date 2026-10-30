#!/usr/bin/env bash
# Rotate Hive deployment/runtime secrets. Dry-run is the default; use --apply
# only during a planned maintenance window after reviewing the printed plan.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST=""
KIND="all"
APPLY=false
VERIFY=true

usage() {
  cat <<'EOF'
Usage:
  scripts/rotate-secrets.sh [--host HOST] [--kind KIND] [--apply] [--no-verify]

Kinds:
  all       Rotate router, IAM, and memory runtime secrets that can be safely
            rotated without printing values.
  router    Rotate /opt/hive-router/.env HIVE_ROUTER_SECRET.
  iam       Rotate /opt/hive-iam/.env COOKIE_SECRET and IAM_AGENT_SECRET.
  memory    Rotate /opt/hivemem/.env HIVEMEM_JWT_SECRET.
  deploy    Print manual DEPLOY_PASSWORD rotation guidance. This is an account
            password and is intentionally not changed by this script.

HOST defaults to HIVE_DEPLOY_HOST from the environment or the repository .env.
HIVE_PUBLIC_FQDN defaults to HOST when HOST is a fully qualified name.

Dry-run is the default. The script never prints generated secret values.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      [[ $# -ge 2 ]] || { echo "ERROR: --host requires a value" >&2; exit 2; }
      HOST="$2"
      shift 2
      ;;
    --host=*) HOST="${1#*=}"; shift ;;
    --kind)
      [[ $# -ge 2 ]] || { echo "ERROR: --kind requires a value" >&2; exit 2; }
      KIND="$2"
      shift 2
      ;;
    --kind=*) KIND="${1#*=}"; shift ;;
    --apply) APPLY=true; shift ;;
    --dry-run) APPLY=false; shift ;;
    --no-verify) VERIFY=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

case "$KIND" in
  all|router|iam|memory|deploy) ;;
  *) echo "ERROR: unsupported --kind: $KIND" >&2; usage; exit 2 ;;
esac
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
    value="${value%$'\r'}"
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$file"
}

load_env_file "$ROOT_DIR/.env"

HOST="${HOST:-${HIVE_DEPLOY_HOST:-}}"
if [[ -z "$HOST" ]]; then
  echo "ERROR: pass --host or set HIVE_DEPLOY_HOST in env/root .env" >&2
  exit 2
fi
if [[ "$HOST" == *.* ]]; then
  PUBLIC_FQDN="${HIVE_PUBLIC_FQDN:-$HOST}"
elif [[ -n "${HIVE_PUBLIC_FQDN:-}" ]]; then
  PUBLIC_FQDN="$HIVE_PUBLIC_FQDN"
else
  echo "ERROR: HIVE_PUBLIC_FQDN is required when --host is a short host name" >&2
  exit 2
fi

SSH_USER="${DEPLOY_USERNAME:-deploy}"
SSH_PASS="${DEPLOY_PASSWORD:-}"

if [[ "$APPLY" == "true" && -z "$SSH_PASS" ]]; then
  echo "ERROR: --apply requires DEPLOY_PASSWORD in env/root .env" >&2
  exit 1
fi

SSH_OPTIONS=(-o StrictHostKeyChecking=accept-new -o UpdateHostKeys=yes -o LogLevel=ERROR)

remote_exec() {
  SSHPASS="$SSH_PASS" sshpass -e ssh "${SSH_OPTIONS[@]}" "$SSH_USER@$HOST" "$@"
}

print_plan() {
  echo ">>> Hive secret rotation plan"
  echo "    host: $HOST"
  echo "    kind: $KIND"
  echo "    mode: $(if [[ "$APPLY" == "true" ]]; then echo apply; else echo dry-run; fi)"
  echo "    values: generated on target and never printed"
}

rotate_remote_env_key() {
  local file="$1" key="$2" service="$3"
  if [[ "$APPLY" != "true" ]]; then
    echo "DRY-RUN: would rotate $key in $file and restart $service on $HOST."
    return 0
  fi

  remote_exec bash -s -- "$file" "$key" "$service" <<'REMOTE'
set -euo pipefail
file="$1"
key="$2"
service="$3"
backup="${file}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
sudo test -f "$file"
sudo cp "$file" "$backup"
secret=$(openssl rand -hex 32)
if sudo grep -q "^${key}=" "$file"; then
  sudo sed -i "s|^${key}=.*|${key}=${secret}|" "$file"
else
  printf '%s=%s\n' "$key" "$secret" | sudo tee -a "$file" >/dev/null
fi
sudo chmod 600 "$file"
sudo systemctl restart "$service"
sudo systemctl is-active --quiet "$service"
printf 'rotated %s in %s; backup=%s; service=%s active\n' "$key" "$file" "$backup" "$service"
REMOTE
}

verify_url() {
  local label="$1" url="$2"
  shift 2
  [[ "$VERIFY" == "true" ]] || return 0
  if [[ "$APPLY" != "true" ]]; then
    echo "DRY-RUN: would verify $label at $url."
    return 0
  fi
  curl --fail --silent --show-error --max-time 15 --retry 6 --retry-delay 2 --retry-connrefused "$@" "$url" >/dev/null
  echo ">>> Verified $label."
}

rotate_router() {
  rotate_remote_env_key /opt/hive-router/.env HIVE_ROUTER_SECRET hive-router.service
  verify_url "router admin readiness" "https://${PUBLIC_FQDN}/health/ready"
  verify_url "router API readiness" "https://${PUBLIC_FQDN}:4020/health/ready"
}

rotate_iam() {
  rotate_remote_env_key /opt/hive-iam/.env COOKIE_SECRET hive-iam.service
  rotate_remote_env_key /opt/hive-iam/.env IAM_AGENT_SECRET hive-iam.service
  verify_url "IAM readiness" "https://${PUBLIC_FQDN}:4200/api/v1/health/ready" \
    --cacert "$ROOT_DIR/services/hive-iam/certs/iam-ca.crt"
}

rotate_memory() {
  rotate_remote_env_key /opt/hivemem/.env HIVEMEM_JWT_SECRET hivemem.service
  verify_url "HiveMem readiness" "https://${PUBLIC_FQDN}/v1/health/ready"
}

rotate_deploy_password_guidance() {
  cat <<EOF
DEPLOY_PASSWORD is the deploy account password, so this script does not change it automatically.

Recommended manual flow:
  1. Rotate the OS password for ${SSH_USER}@${HOST} using an interactive sudo/passwd session or your host password manager.
  2. Update the ignored local .env entry used for DEPLOY_PASSWORD.
  3. Run: HIVE_DEPLOY_SKIP_VERIFY=false npm run deploy -- --help  # or a non-mutating SSH/auth smoke if available.
  4. Run: npm run scan:secrets
  5. Confirm old password no longer works and key-based deploy auth is preferred.
EOF
}

print_plan

case "$KIND" in
  router) rotate_router ;;
  iam) rotate_iam ;;
  memory) rotate_memory ;;
  deploy) rotate_deploy_password_guidance ;;
  all)
    rotate_router
    rotate_iam
    rotate_memory
    rotate_deploy_password_guidance
    ;;
esac

echo ">>> Rotation workflow complete."
