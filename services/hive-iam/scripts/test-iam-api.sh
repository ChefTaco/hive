#!/usr/bin/env bash
# test-iam-api.sh — End-to-end IAM API verification via deployed dashboard
#
# Reads DEPLOY_USER / DEPLOY_PASSWORD (dashboard login) from this repo's .env or apps/iam-core/.env
# Uses curl to log in via the dashboard, then tests all IAM endpoints
# through the /api/iam route (same path the browser uses).
#
# Usage:
#   bash scripts/test-iam-api.sh [DASHBOARD_URL]
#
# DASHBOARD_URL defaults to $HIVE_PUBLIC_URL (e.g. https://hive.example.com).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_URL="${1:-${HIVE_PUBLIC_URL:-}}"
COOKIE_FILE="$(mktemp)"
PASS=0
FAIL=0
TOTAL=0

# ─── Read credentials from repo/package .env files ───────────────────
ROOT_ENV="$ROOT_DIR/.env"
API_ENV="$ROOT_DIR/apps/iam-core/.env"
if [[ -f "$ROOT_ENV" ]]; then
  set -a
  source "$ROOT_ENV"
  set +a
fi
if [[ -f "$API_ENV" ]]; then
  set -a
  source "$API_ENV"
  set +a
fi
DEPLOY_USER="${DEPLOY_USER:-${DEPLOY_USERNAME:-}}"
DEPLOY_PASS="${DEPLOY_PASSWORD:-}"

if [[ -z "$DEPLOY_USER" || -z "$DEPLOY_PASS" ]]; then
  echo "ERROR: DEPLOY_USER/DEPLOY_PASSWORD not set in $ROOT_ENV or $API_ENV"
  exit 1
fi
if [[ -z "$DASHBOARD_URL" ]]; then
  echo "ERROR: pass DASHBOARD_URL as the first argument or set HIVE_PUBLIC_URL"
  exit 1
fi

# ─── Helpers ──────────────────────────────────────────────────────────
cleanup() { rm -f "$COOKIE_FILE"; }
trap cleanup EXIT

assert_contains() {
  local label="$1" body="$2" expected="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$body" | grep -qi "$expected"; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label — expected '$expected' not found"
    FAIL=$((FAIL + 1))
  fi
}

assert_status() {
  local label="$1" status="$2" expected="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$status" -eq "$expected" ]]; then
    echo "  ✓ $label (HTTP $status)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label — expected HTTP $expected, got $status"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_field() {
  local label="$1" body="$2" field="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); assert '$field' in d" 2>/dev/null; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label — field '$field' not present in response"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_count() {
  local label="$1" body="$2" field="$3" min="$4"
  TOTAL=$((TOTAL + 1))
  local count
  count=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('$field', [])))" 2>/dev/null || echo "0")
  if [[ "$count" -ge "$min" ]]; then
    echo "  ✓ $label ($count items)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label — expected ≥$min items in '$field', got $count"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_number() {
  local label="$1" body="$2" field="$3" min="$4"
  TOTAL=$((TOTAL + 1))
  local val
  val=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$field', 0))" 2>/dev/null || echo "0")
  if [[ "$val" -ge "$min" ]]; then
    echo "  ✓ $label ($val)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label — expected $field ≥ $min, got $val"
    FAIL=$((FAIL + 1))
  fi
}

proxy_get() {
  local path="$1"
  curl --silent --show-error -b "$COOKIE_FILE" "$DASHBOARD_URL/api/iam/$path" 2>/dev/null
}

proxy_get_status() {
  local path="$1"
  curl --silent --show-error -o /dev/null -w '%{http_code}' -b "$COOKIE_FILE" "$DASHBOARD_URL/api/iam/$path" 2>/dev/null
}

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  IAM API End-to-End Test"
echo "  Dashboard: $DASHBOARD_URL"
echo "  User: $DEPLOY_USER"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── 1. Login ─────────────────────────────────────────────────────────
echo "▸ Login"
LOGIN_STATUS=$(curl --silent --show-error -o /dev/null -w '%{http_code}' -c "$COOKIE_FILE" \
  -X POST "$DASHBOARD_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$DEPLOY_USER\",\"password\":\"$DEPLOY_PASS\"}")
assert_status "Login succeeds" "$LOGIN_STATUS" 200

COOKIE_LEN=$(wc -c < "$COOKIE_FILE")
TOTAL=$((TOTAL + 1))
if [[ "$COOKIE_LEN" -gt 100 ]]; then
  echo "  ✓ Session cookie set ($COOKIE_LEN bytes)"
  PASS=$((PASS + 1))
else
  echo "  ✗ Session cookie missing or too small"
  FAIL=$((FAIL + 1))
fi
echo ""

# ─── 2. Health ────────────────────────────────────────────────────────
echo "▸ Health"
HEALTH=$(proxy_get "health")
assert_json_field "Returns status field" "$HEALTH" "status"
assert_contains "Status is healthy" "$HEALTH" "healthy"
assert_json_field "Returns version" "$HEALTH" "version"
assert_json_field "Returns uptime" "$HEALTH" "uptime"
echo ""

# ─── 3. Users ─────────────────────────────────────────────────────────
echo "▸ Users"
USERS_STATUS=$(proxy_get_status "users")
assert_status "Users endpoint accessible" "$USERS_STATUS" 200
USERS=$(proxy_get "users")
assert_json_count "Has seeded users" "$USERS" "users" 1
assert_contains "Contains admin user" "$USERS" "admin"
echo ""

# ─── 4. Roles ─────────────────────────────────────────────────────────
echo "▸ Roles"
ROLES_STATUS=$(proxy_get_status "roles")
assert_status "Roles endpoint accessible" "$ROLES_STATUS" 200
ROLES=$(proxy_get "roles")
assert_json_count "Has system roles" "$ROLES" "roles" 5
assert_contains "Has SUPER_ADMIN role" "$ROLES" "SUPER_ADMIN"
assert_contains "Has IAM_ADMIN role" "$ROLES" "IAM_ADMIN"
assert_contains "Has OPERATOR role" "$ROLES" "OPERATOR"
echo ""

# ─── 5. Service Accounts ─────────────────────────────────────────────
echo "▸ Service Accounts"
SA_STATUS=$(proxy_get_status "service-accounts")
assert_status "Service Accounts endpoint accessible" "$SA_STATUS" 200
echo ""

# ─── 6. Clients ──────────────────────────────────────────────────────
echo "▸ Clients"
CLIENTS_STATUS=$(proxy_get_status "clients")
assert_status "Clients endpoint accessible" "$CLIENTS_STATUS" 200
CLIENTS=$(proxy_get "clients")
assert_json_count "Has seeded clients" "$CLIENTS" "clients" 1
assert_contains "Has hive client" "$CLIENTS" "hive"
echo ""

# ─── 7. Sessions ─────────────────────────────────────────────────────
echo "▸ Sessions"
SESSIONS_STATUS=$(proxy_get_status "sessions")
assert_status "Sessions endpoint accessible" "$SESSIONS_STATUS" 200
SESSIONS=$(proxy_get "sessions")
assert_json_count "Has active sessions" "$SESSIONS" "sessions" 1
echo ""

# ─── 8. Audit Stats ──────────────────────────────────────────────────
echo "▸ Audit Stats"
STATS_STATUS=$(proxy_get_status "audit/stats")
assert_status "Audit stats accessible" "$STATS_STATUS" 200
STATS=$(proxy_get "audit/stats")
assert_json_field "Has totalEvents" "$STATS" "totalEvents"
assert_json_field "Has successCount" "$STATS" "successCount"
assert_json_field "Has failureCount" "$STATS" "failureCount"
assert_json_number "Total events > 0" "$STATS" "totalEvents" 1
echo ""

# ─── 9. Audit Events ─────────────────────────────────────────────────
echo "▸ Audit Events"
AUDIT_STATUS=$(proxy_get_status "audit?page=1&limit=5")
assert_status "Audit events accessible" "$AUDIT_STATUS" 200
AUDIT=$(proxy_get "audit?page=1&limit=5")
assert_json_count "Has audit events" "$AUDIT" "events" 1
echo ""

# ─── 10. System Users ────────────────────────────────────────────────
echo "▸ System Users"
SYSUSERS_STATUS=$(proxy_get_status "system-users")
assert_status "System users accessible" "$SYSUSERS_STATUS" 200
echo ""

# ─── Summary ──────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════"
if [[ "$FAIL" -eq 0 ]]; then
  echo "  ✅ ALL $TOTAL TESTS PASSED"
else
  echo "  ❌ $FAIL/$TOTAL FAILED ($PASS passed)"
fi
echo "═══════════════════════════════════════════════════════════"
echo ""

exit "$FAIL"
