#!/usr/bin/env bash
# Apply the production IAM schema and, when explicitly required, the
# idempotent seed. Any failure is fatal so callers cannot activate new code
# against an unverified database state.
set -euo pipefail

mode="${1:---no-seed}"
case "$mode" in
  --seed|--no-seed) ;;
  *)
    echo "usage: $0 [--seed|--no-seed]" >&2
    exit 2
    ;;
esac

echo ">>> Running migrations (fatal on error)..."
npx prisma migrate deploy
echo ">>> Migrations applied"

if [[ "$mode" == "--seed" ]]; then
  echo ">>> Seeding database (fatal on error)..."
  npm run db:seed
  echo ">>> Database seed applied"
fi
