#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

failed=false
if rg -n --glob '*.sh' --glob '*.ts' \
  'curl[[:space:]]+(-[^[:space:]]*k|--insecure)|NODE_TLS_REJECT_UNAUTHORIZED[[:space:]]*=[[:space:]]*0' \
  scripts services/*/scripts; then
  failed=true
fi
if rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' \
  --glob '!docs/*legacy*' 'NODE_TLS_REJECT_UNAUTHORIZED[[:space:]]*=[[:space:]]*0' .; then
  failed=true
fi

if [[ "$failed" == "true" ]]; then
  echo "TLS bypass scan failed." >&2
  exit 1
fi
echo "TLS bypass scan passed."
