#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
HIVE_BACKUP_MODE=restore exec node --experimental-strip-types scripts/hive-backup.ts "$@"
