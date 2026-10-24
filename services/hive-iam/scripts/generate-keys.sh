#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# generate-keys.sh — Generate RS256 key pair for IAM Core
#
# Usage:
#   bash scripts/generate-keys.sh
#
# Output:
#   certs/iam-private.pem   (RS256 private key, keep secret)
#   certs/iam-public.pem    (RS256 public key, safe to distribute)
# ──────────────────────────────────────────────────────────

set -euo pipefail

CERTS_DIR="$(dirname "$0")/../certs"
PRIVATE_KEY="$CERTS_DIR/iam-private.pem"
PUBLIC_KEY="$CERTS_DIR/iam-public.pem"

mkdir -p "$CERTS_DIR"

if [[ -f "$PRIVATE_KEY" ]] && [[ -f "$PUBLIC_KEY" ]]; then
  echo "✓ IAM key pair already exists in $CERTS_DIR/"
  echo "  Delete them and re-run this script to rotate keys."
  exit 0
fi

echo "Generating RS256 key pair..."

openssl genrsa -out "$PRIVATE_KEY" 4096 2>/dev/null
openssl rsa -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" 2>/dev/null

chmod 600 "$PRIVATE_KEY"
chmod 644 "$PUBLIC_KEY"

echo ""
echo "✓ IAM RS256 key pair generated:"
echo "  Private: $PRIVATE_KEY  (chmod 600 — keep secret)"
echo "  Public:  $PUBLIC_KEY"
echo ""
echo "Add to apps/iam-core/.env:"
echo "  JWT_PRIVATE_KEY_PATH=../certs/iam-private.pem"
echo "  JWT_PUBLIC_KEY_PATH=../certs/iam-public.pem"
