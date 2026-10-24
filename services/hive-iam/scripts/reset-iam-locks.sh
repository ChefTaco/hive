#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# reset-iam-locks.sh — Unlock all IAM accounts & clear rate limits
#
# Usage:
#   bash scripts/reset-iam-locks.sh <host>
#   HIVE_IAM_HOST=<host> bash scripts/reset-iam-locks.sh
#
# Environment:
#   HIVE_IAM_HOST      — SSH host running hive-iam (or pass it as the first argument)
#   DEPLOY_USER        — SSH user (default: deploy)
#   DEPLOY_PASSWORD    — optional SSH password; key-based SSH is used when unset
#   IAM_DB_PATH        — remote SQLite path (default: /opt/hive-iam/prisma/iam.db)
#   IAM_REDIS_PREFIX   — Redis key prefix (default: hive-iam)
#
# Requires: ssh access to the target host (sshpass only when DEPLOY_PASSWORD is set)
# ─────────────────────────────────────────────────────────
set -euo pipefail

HOST="${1:-${HIVE_IAM_HOST:-}}"
SSH_USER="${DEPLOY_USER:-deploy}"
PASS="${DEPLOY_PASSWORD:-}"
DB_PATH="${IAM_DB_PATH:-/opt/hive-iam/prisma/iam.db}"
REDIS_PREFIX="${IAM_REDIS_PREFIX:-hive-iam}"

if [[ -z "$HOST" ]]; then
  echo "ERROR: target host not set (pass it as the first argument or export HIVE_IAM_HOST)" >&2
  exit 1
fi

SSH_CMD=(ssh -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR)
if [[ -n "$PASS" ]]; then
  export SSHPASS="$PASS"
  SSH_CMD=(sshpass -e "${SSH_CMD[@]}")
fi

echo "→ Resetting IAM locks on ${HOST}..."

"${SSH_CMD[@]}" "${SSH_USER}@${HOST}" bash -s <<REMOTE
  set -euo pipefail

  # 1. Unlock all user accounts and report how many were actually locked
  LOCKED=\$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM users WHERE lockedUntil IS NOT NULL OR failedAttempts > 0;")
  sqlite3 "${DB_PATH}" "UPDATE users SET failedAttempts=0, lockedUntil=NULL;"
  echo "  ✓ Unlocked \${LOCKED} locked user account(s)"

  # 2. Clear Redis rate-limit keys
  KEYS=\$(redis-cli --scan --pattern "${REDIS_PREFIX}:rl:*" 2>/dev/null | wc -l)
  if [ "\${KEYS}" -gt 0 ]; then
    redis-cli --scan --pattern "${REDIS_PREFIX}:rl:*" | xargs -r redis-cli DEL >/dev/null
  fi
  echo "  ✓ Cleared \${KEYS} rate-limit key(s) from Redis"

  echo "  Done."
REMOTE

echo "✓ IAM locks reset on ${HOST}"
