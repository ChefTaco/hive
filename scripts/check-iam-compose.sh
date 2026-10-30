#!/usr/bin/env bash
# Runs the Hive IAM Compose example (services/hive-iam/apps/iam-core/docker/compose.yml)
# with throwaway secrets and checks that:
#   1. Compose refuses to start while a required secret is missing;
#   2. IAM and Redis become healthy and IAM reports ready;
#   3. the seeded admin can sign in;
#   4. after `down` and `up`, the data is kept and nothing is seeded again.
# Usage: bash scripts/check-iam-compose.sh [--no-build]
#   --no-build  run the image named by IAM_IMAGE (default hive-iam-server:local) as is
# DOCKER_COMPOSE overrides the Compose command (default "docker compose"), and
# IAM_CHECK_PORT the loopback port (default 4290).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/services/hive-iam/apps/iam-core/docker/compose.yml"
PROJECT="hive-iam-check-$$"
PORT="${IAM_CHECK_PORT:-4290}"
BASE="http://127.0.0.1:$PORT"
read -r -a DC <<< "${DOCKER_COMPOSE:-docker compose}"

case "${1:-}" in
  "") BUILD=--build ;;
  --no-build) BUILD=--no-build ;;
  *) echo "usage: $0 [--no-build]" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
compose() { "${DC[@]}" -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$WORK/check.env" "$@"; }
cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  compose logs --no-color --tail 80 >&2 || true
  exit 1
}

ADMIN_PASSWORD="$(openssl rand -hex 16)"
(
  umask 077
  cat > "$WORK/check.env" <<EOF
COOKIE_SECRET=$(openssl rand -hex 32)
IAM_AGENT_SECRET=$(openssl rand -hex 32)
REDIS_PASSWORD=$(openssl rand -hex 32)
SEED_ADMIN_PASSWORD=$ADMIN_PASSWORD
IAM_PORT=$PORT
EOF
)

login() {
  local body
  body="$(curl -sS --fail-with-body -H 'content-type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" "$BASE/api/v1/auth/login")" ||
    fail "admin login: $body"
  node -e 'const b=JSON.parse(process.argv[1]); const d=b.data??b; if (typeof d.accessToken!=="string") process.exit(1)' "$body" ||
    fail "admin login returned no access token"
}

echo ">>> 1. Compose refuses a missing secret"
if env -u COOKIE_SECRET -u IAM_AGENT_SECRET -u REDIS_PASSWORD -u SEED_ADMIN_PASSWORD \
  "${DC[@]}" -p "$PROJECT" -f "$COMPOSE_FILE" --env-file /dev/null config -q >/dev/null 2>&1; then
  fail "compose config accepted an empty environment"
fi

echo ">>> 2. Start IAM and Redis ($BUILD)"
compose up -d "$BUILD" --wait --wait-timeout 240 || fail "the stack did not become healthy"
curl -sS --fail "$BASE/api/v1/health/ready" >/dev/null || fail "IAM is not ready"

echo ">>> 3. The seeded admin can sign in"
login
[ "$(compose exec -T iam id -u)" = 1000 ] || fail "IAM does not run as uid 1000"

echo ">>> 4. Data survives a restart"
compose down || fail "compose down"
compose up -d --no-build --wait --wait-timeout 240 || fail "the stack did not come back"
if compose logs --no-color iam | grep -q 'Empty database'; then fail "IAM seeded again after a restart"; fi
login

echo "IAM Compose check passed"
