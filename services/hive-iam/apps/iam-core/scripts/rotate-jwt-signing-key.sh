#!/usr/bin/env bash
# Rotate Hive IAM's root-owned RS256 keyring as a durable transaction. Every
# activation and rollback is proven against the managed CA and exact RSA key
# material before an old release is destroyed or restoration is reported.
set -euo pipefail

IAM_ROOT="${HIVE_IAM_ROOT:-/opt/hive-iam}"
ENV_FILE="$IAM_ROOT/.env"
DEFAULT_CA_CERT="$IAM_ROOT/certs/ca-bundle.crt"
[[ -f "$DEFAULT_CA_CERT" ]] || DEFAULT_CA_CERT="$IAM_ROOT/certs/ca.crt"
CA_CERT="${HIVE_IAM_CA_CERT:-$DEFAULT_CA_CERT}"
KEYRING_ROOT="${HIVE_IAM_KEYRING_ROOT:-/var/lib/hive-iam-keyring}"
RELEASES_DIR="$KEYRING_ROOT/releases"
CURRENT_LINK="$KEYRING_ROOT/current"
JOURNAL="${HIVE_IAM_KEYRING_JOURNAL:-$KEYRING_ROOT/rotation-journal.jsonl}"
HELPER_DIR="${HIVE_IAM_HELPER_DIR:-/usr/local/libexec/hive-iam}"
VALIDATOR="$HELPER_DIR/validate-jwt-keyring.mjs"
DESTRUCTION_LOG="${HIVE_IAM_KEY_DESTRUCTION_LOG:-/var/log/hive-iam-key-destruction.log}"
SERVICE_NAME="${HIVE_IAM_SERVICE_NAME:-hive-iam.service}"
SERVICE_GROUP="${HIVE_IAM_SERVICE_GROUP:-hive-iam}"
HEALTH_URL="${HIVE_IAM_HEALTH_URL:-https://127.0.0.1:4200/api/v1/health/ready}"
JWKS_URL="${HIVE_IAM_JWKS_URL:-https://127.0.0.1:4200/api/v1/oauth/jwks}"
REQUESTED_ACTION="${1:-rotate}"
SYSTEMCTL="${HIVE_IAM_SYSTEMCTL:-systemctl}"
CURL="${HIVE_IAM_CURL:-curl}"
NODE="${HIVE_IAM_NODE:-node}"

operation_id=""
operation_action=""
old_release=""
new_release=""
staged_release=""
old_kid=""
new_kid=""
STATE=""

set_service_owner() {
  if [[ "$(id -u)" -eq 0 ]]; then
    chown root:"$SERVICE_GROUP" "$@"
  else
    chgrp "$SERVICE_GROUP" "$@"
  fi
}

critical() { echo "CRITICAL: $*" >&2; }

validate_release_path() {
  case "$1" in
    "$RELEASES_DIR"/*) ;;
    *) echo "ERROR: keyring release escapes $RELEASES_DIR: $1" >&2; return 1 ;;
  esac
}

fsync_directory() {
  "$NODE" - "$1" <<'NODE'
import { closeSync, fsyncSync, openSync } from 'node:fs';
const descriptor = openSync(process.argv[2], 'r');
try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
NODE
}

write_journal() {
  local state="$1" recovery_error="${2:-}"
  JOURNAL_OPERATION_ID="$operation_id" \
  JOURNAL_ACTION="$operation_action" \
  JOURNAL_STATE="$state" \
  JOURNAL_OLD_RELEASE="$old_release" \
  JOURNAL_NEW_RELEASE="$new_release" \
  JOURNAL_STAGED_RELEASE="$staged_release" \
  JOURNAL_OLD_KID="$old_kid" \
  JOURNAL_NEW_KID="$new_kid" \
  JOURNAL_RECOVERY_ERROR="$recovery_error" \
    "$NODE" - "$JOURNAL" <<'NODE'
import { chmodSync, closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
const record = {
  version: 1,
  operationId: process.env.JOURNAL_OPERATION_ID,
  action: process.env.JOURNAL_ACTION,
  state: process.env.JOURNAL_STATE,
  oldRelease: process.env.JOURNAL_OLD_RELEASE,
  newRelease: process.env.JOURNAL_NEW_RELEASE,
  stagedRelease: process.env.JOURNAL_STAGED_RELEASE,
  oldKid: process.env.JOURNAL_OLD_KID,
  newKid: process.env.JOURNAL_NEW_KID,
  recoveryError: process.env.JOURNAL_RECOVERY_ERROR || undefined,
  recordedAt: new Date().toISOString(),
};
const path = process.argv[2];
const descriptor = openSync(path, 'a', 0o600);
try {
  chmodSync(path, 0o600);
  writeSync(descriptor, `${JSON.stringify(record)}\n`);
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
NODE
  fsync_directory "$KEYRING_ROOT"
  STATE="$state"
}

journal_field() {
  "$NODE" - "$JOURNAL" "$1" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
const [path, field] = process.argv.slice(2);
if (!existsSync(path)) process.exit(0);
const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
if (lines.length === 0) process.exit(0);
let record;
try { record = JSON.parse(lines.at(-1)); } catch { process.exit(2); }
const value = record[field];
if (typeof value === 'string') process.stdout.write(value);
NODE
}

activate_release() {
  local release_name_to_activate="$1" link_temp
  link_temp="$KEYRING_ROOT/.current-${operation_id:-recovery}-$$"
  ln -s "releases/$release_name_to_activate" "$link_temp"
  mv -Tf "$link_temp" "$CURRENT_LINK"
  fsync_directory "$KEYRING_ROOT"
}

delete_release() {
  local release="$1"
  validate_release_path "$release"
  [[ "$(readlink -f "$CURRENT_LINK")" != "$release" ]] || {
    echo "ERROR: refusing to delete the active keyring release" >&2
    return 1
  }
  rm -rf -- "$release"
  [[ ! -e "$release" && ! -L "$release" ]] || {
    echo "ERROR: keyring release deletion was not confirmed: $release" >&2
    return 1
  }
  fsync_directory "$RELEASES_DIR"
}

record_destruction() {
  local kid="$1" reason="$2" destroyed_release="$3"
  [[ ! -e "$destroyed_release" && ! -L "$destroyed_release" ]] || {
    echo "ERROR: refusing a destruction receipt while the release still exists" >&2
    return 1
  }
  RECEIPT_OPERATION_ID="$operation_id" RECEIPT_KID="$kid" \
  RECEIPT_REASON="$reason" RECEIPT_RELEASE="$(basename "$destroyed_release")" \
    "$NODE" - "$DESTRUCTION_LOG" <<'NODE'
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
const path = process.argv[2];
const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
const lines = existing.split('\n').filter(Boolean);
let chainAnchor = null;
let duplicateReceipt = false;
for (const line of lines) {
  try {
    const receipt = JSON.parse(line);
    const { receiptSha256, ...base } = receipt;
    const expectedSha256 = createHash('sha256').update(JSON.stringify(base)).digest('hex');
    if (receiptSha256 !== expectedSha256 || base.previousReceiptSha256 !== chainAnchor) {
      console.error('ERROR: destruction receipt chain verification failed');
      process.exit(1);
    }
    chainAnchor = receiptSha256;
    if (receipt.operationId === process.env.RECEIPT_OPERATION_ID && receipt.destroyedRelease === process.env.RECEIPT_RELEASE) duplicateReceipt = true;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Legacy text receipts are retained as the initial chain anchor.
      chainAnchor = createHash('sha256').update(line).digest('hex');
    } else {
      throw error;
    }
  }
}
if (duplicateReceipt) process.exit(0);
const previousReceiptSha256 = chainAnchor;
const base = {
  version: 1,
  operationId: process.env.RECEIPT_OPERATION_ID,
  destroyedKid: process.env.RECEIPT_KID,
  destroyedRelease: process.env.RECEIPT_RELEASE,
  reason: process.env.RECEIPT_REASON,
  retention: 'none',
  destroyedAt: new Date().toISOString(),
  previousReceiptSha256,
};
const receiptSha256 = createHash('sha256').update(JSON.stringify(base)).digest('hex');
const descriptor = openSync(path, 'a', 0o600);
try {
  chmodSync(path, 0o600);
  writeSync(descriptor, `${JSON.stringify({ ...base, receiptSha256 })}\n`);
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
const directoryDescriptor = openSync(dirname(path), 'r');
try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
NODE
}

verify_live_release() {
  local expected_release="$1" jwks_file
  validate_release_path "$expected_release"
  [[ -f "$CA_CERT" && ! -L "$CA_CERT" ]] || {
    echo "ERROR: managed IAM CA must be a regular, non-symlink file: $CA_CERT" >&2
    return 1
  }
  "$CURL" --fail --silent --show-error --cacert "$CA_CERT" --max-time 10 "$HEALTH_URL" >/dev/null
  jwks_file="$(mktemp "$KEYRING_ROOT/.jwks.XXXXXX")"
  if ! "$CURL" --fail --silent --show-error --cacert "$CA_CERT" --max-time 10 "$JWKS_URL" > "$jwks_file"; then
    rm -f -- "$jwks_file"
    return 1
  fi
  if ! "$NODE" "$VALIDATOR" "$expected_release" "$jwks_file" >/dev/null; then
    rm -f -- "$jwks_file"
    return 1
  fi
  rm -f -- "$jwks_file"
}

load_journal() {
  operation_id="$(journal_field operationId)"
  operation_action="$(journal_field action)"
  STATE="$(journal_field state)"
  old_release="$(journal_field oldRelease)"
  new_release="$(journal_field newRelease)"
  staged_release="$(journal_field stagedRelease)"
  old_kid="$(journal_field oldKid)"
  new_kid="$(journal_field newKid)"
}

mark_recovery_failed() {
  local message="$1" retention_message="${2:-available releases were retained}"
  write_journal recovery_failed "$message" || true
  critical "$message; $retention_message and operator recovery is required"
  return 1
}

rollback_to_old() {
  local reason="$1"
  validate_release_path "$old_release"
  validate_release_path "$new_release"
  [[ -d "$old_release" ]] || { mark_recovery_failed "prior release is unavailable"; return 1; }
  if [[ "$(readlink -f "$CURRENT_LINK")" != "$old_release" ]]; then
    activate_release "$(basename "$old_release")" || { mark_recovery_failed "could not reactivate prior release"; return 1; }
  fi
  if ! "$SYSTEMCTL" restart "$SERVICE_NAME"; then
    mark_recovery_failed "IAM restart failed during rollback" "both releases were retained"
    return 1
  fi
  if ! verify_live_release "$old_release"; then
    mark_recovery_failed "prior release failed readiness or cryptographic JWKS validation" "both releases were retained"
    return 1
  fi
  if [[ -e "$new_release" || -L "$new_release" ]]; then
    delete_release "$new_release" || { mark_recovery_failed "new release deletion failed after verified rollback"; return 1; }
  fi
  if [[ -n "$new_kid" ]]; then
    record_destruction "$new_kid" "$reason" "$new_release" || {
      mark_recovery_failed "new-key destruction receipt could not be persisted"
      return 1
    }
  fi
  if [[ -n "$staged_release" && ( -e "$staged_release" || -L "$staged_release" ) ]]; then
    delete_release "$staged_release" || { mark_recovery_failed "staging release deletion failed"; return 1; }
  fi
  write_journal rolled_back
}

reconcile_incomplete() {
  [[ -f "$JOURNAL" ]] || return 0
  load_journal
  case "$STATE" in
    ""|finalized|rolled_back) return 0 ;;
    prepared)
      validate_release_path "$old_release"
      validate_release_path "$new_release"
      validate_release_path "$staged_release"
      if [[ "$(readlink -f "$CURRENT_LINK")" == "$new_release" ]]; then
        write_journal activated
        rollback_to_old "prepared-operation-recovery"
        return
      fi
      [[ "$(readlink -f "$CURRENT_LINK")" == "$old_release" ]] || {
        mark_recovery_failed "prepared operation found an unexpected active release"
        return 1
      }
      if [[ -e "$new_release" || -L "$new_release" ]]; then delete_release "$new_release"; fi
      if [[ -e "$staged_release" || -L "$staged_release" ]]; then
        delete_release "$staged_release"
        [[ -n "$new_kid" ]] && record_destruction "$new_kid" "prepared-operation-recovery" "$staged_release"
      elif [[ -n "$new_kid" ]]; then
        record_destruction "$new_kid" "prepared-operation-recovery" "$new_release"
      fi
      write_journal rolled_back
      ;;
    activated|recovery_failed)
      rollback_to_old "failed-activation-rollback"
      ;;
    verified)
      validate_release_path "$old_release"
      validate_release_path "$new_release"
      if [[ "$(readlink -f "$CURRENT_LINK")" != "$new_release" ]] || ! verify_live_release "$new_release"; then
        rollback_to_old "verified-operation-recovery"
        return
      fi
      if [[ -e "$old_release" || -L "$old_release" ]]; then delete_release "$old_release"; fi
      if [[ "$operation_action" == "rotate" && -n "$old_kid" ]]; then
        record_destruction "$old_kid" "retired-after-verified-cutover" "$old_release" || {
          critical "retired key was deleted but its destruction receipt could not be persisted; finalization remains incomplete for retry"
          return 1
        }
      fi
      write_journal finalized
      ;;
    *)
      critical "unrecognized keyring journal state '$STATE'; refusing another operation"
      return 1
      ;;
  esac
}

rollback_on_error() {
  local rc=$?
  trap - EXIT
  set +e
  case "$STATE" in
    prepared)
      if [[ -n "$new_release" && "$(readlink -f "$CURRENT_LINK")" == "$new_release" ]]; then
        write_journal activated
        rollback_to_old "failed-activation-rollback"
        if [[ $? -eq 0 ]]; then
          echo "ERROR: JWT keyring activation failed; the prior release was cryptographically verified after rollback" >&2
        fi
      elif [[ -n "$new_release" && ( -e "$new_release" || -L "$new_release" ) ]]; then
        delete_release "$new_release"
        if [[ $? -eq 0 && -n "$new_kid" ]]; then record_destruction "$new_kid" "failed-prepared-operation" "$new_release"; fi
        write_journal rolled_back
      elif [[ -n "$staged_release" && ( -e "$staged_release" || -L "$staged_release" ) ]]; then
        delete_release "$staged_release"
        if [[ $? -eq 0 && -n "$new_kid" ]]; then record_destruction "$new_kid" "failed-prepared-operation" "$staged_release"; fi
        write_journal rolled_back
      else
        write_journal rolled_back
      fi
      ;;
    activated|recovery_failed)
      rollback_to_old "failed-activation-rollback"
      if [[ $? -eq 0 ]]; then
        echo "ERROR: JWT keyring activation failed; the prior release was cryptographically verified after rollback" >&2
      fi
      ;;
    verified)
      critical "keyring activation was verified but finalization is incomplete; current and journal state were preserved for reconciliation"
      ;;
  esac
  exit "$rc"
}

if [[ "$(id -u)" -ne 0 && "${HIVE_IAM_ALLOW_NON_ROOT_TEST:-false}" != "true" ]]; then
  echo "ERROR: run this rotation workflow through sudo" >&2
  exit 1
fi
if [[ "$REQUESTED_ACTION" != "rotate" && "$REQUESTED_ACTION" != "--prune-expired" ]]; then
  echo "Usage: $0 [rotate|--prune-expired]" >&2
  exit 1
fi
for path in "$ENV_FILE" "$CURRENT_LINK" "$VALIDATOR" "$CA_CERT"; do
  [[ -e "$path" ]] || { echo "ERROR: missing required rotation path: $path" >&2; exit 1; }
done
[[ ! -L "$VALIDATOR" && -f "$VALIDATOR" ]] || {
  echo "ERROR: keyring validator must be a regular, non-symlink file" >&2
  exit 1
}

umask 077
mkdir -p "$RELEASES_DIR"
set_service_owner "$KEYRING_ROOT" "$RELEASES_DIR"
chmod 750 "$KEYRING_ROOT" "$RELEASES_DIR"
exec 9>"$KEYRING_ROOT/rotation.lock"
flock -n 9 || { echo "ERROR: another JWT keyring operation is in progress" >&2; exit 1; }

reconcile_incomplete

read_env() { grep "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true; }
ACCESS_TTL="$(read_env JWT_ACCESS_TTL)"
[[ "$ACCESS_TTL" =~ ^[0-9]+$ ]] || ACCESS_TTL=900

old_release="$(readlink -f "$CURRENT_LINK")"
validate_release_path "$old_release"
old_kid="$("$NODE" "$VALIDATOR" "$old_release")"

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
operation_id="$stamp"
operation_action="$REQUESTED_ACTION"
release_name="keyring-$stamp"
staged_release="$RELEASES_DIR/.staging-$stamp"
new_release="$RELEASES_DIR/$release_name"
mkdir -m 750 "$staged_release" "$staged_release/previous"
set_service_owner "$staged_release" "$staged_release/previous"

cp -p "$old_release/active-private.pem" "$staged_release/active-private.pem"
cp -p "$old_release/active-public.pem" "$staged_release/active-public.pem"
find "$old_release/previous" -mindepth 1 -maxdepth 1 -type f -name 'iam-public-*.pem' \
  -exec cp -p -- {} "$staged_release/previous/" \;

if [[ "$REQUESTED_ACTION" == "rotate" ]]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
    -out "$staged_release/active-private.pem" 2>/dev/null
  openssl pkey -in "$staged_release/active-private.pem" -pubout \
    -out "$staged_release/active-public.pem" 2>/dev/null
  cp -p "$old_release/active-public.pem" "$staged_release/previous/iam-public-$stamp.pem"
  touch "$staged_release/previous/iam-public-$stamp.pem"
else
  now="$(date +%s)"
  while IFS= read -r -d '' public_key; do
    modified="$(stat -c %Y "$public_key")"
    if (( now - modified >= ACCESS_TTL )); then rm -f -- "$public_key"; fi
  done < <(find "$staged_release/previous" -mindepth 1 -maxdepth 1 -type f -name 'iam-public-*.pem' -print0)
fi

chmod 600 "$staged_release/active-private.pem"
chmod 644 "$staged_release/active-public.pem"
find "$staged_release/previous" -type f -exec chmod 644 {} +
set_service_owner "$staged_release/active-private.pem" "$staged_release/active-public.pem"
while IFS= read -r -d '' public_key; do set_service_owner "$public_key"; done \
  < <(find "$staged_release/previous" -type f -print0)
chmod 640 "$staged_release/active-private.pem"
previous_paths=""
while IFS= read -r public_key; do
  relative_name="${public_key#"$staged_release/"}"
  previous_paths="${previous_paths:+$previous_paths,}$CURRENT_LINK/$relative_name"
done < <(find "$staged_release/previous" -mindepth 1 -maxdepth 1 -type f -name 'iam-public-*.pem' | sort)
cat > "$staged_release/keyring.env" <<EOF
JWT_PRIVATE_KEY_PATH=$CURRENT_LINK/active-private.pem
JWT_PUBLIC_KEY_PATH=$CURRENT_LINK/active-public.pem
JWT_PREVIOUS_PUBLIC_KEY_PATHS=$previous_paths
EOF
set_service_owner "$staged_release/keyring.env"
chmod 640 "$staged_release/keyring.env"

new_kid="$("$NODE" "$VALIDATOR" "$staged_release")"
write_journal prepared
trap rollback_on_error EXIT

mv "$staged_release" "$new_release"
fsync_directory "$RELEASES_DIR"
activate_release "$release_name"
write_journal activated
"$SYSTEMCTL" restart "$SERVICE_NAME"
verify_live_release "$new_release"
write_journal verified

delete_release "$old_release"
if [[ "$REQUESTED_ACTION" == "rotate" ]]; then
  record_destruction "$old_kid" "retired-after-verified-cutover" "$old_release"
fi
write_journal finalized
trap - EXIT

if [[ "$REQUESTED_ACTION" == "rotate" ]]; then
  echo "JWT signing key rotated and cryptographically verified. Retired private-key retention: none."
  echo "Keep previous public keys for at least ${ACCESS_TTL}s, then run:"
  echo "  sudo $HELPER_DIR/rotate-jwt-signing-key.sh --prune-expired"
else
  echo "Expired JWT verification keys pruned; IAM and live JWKS cryptographically verified."
fi
