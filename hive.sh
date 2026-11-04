#!/usr/bin/env bash
# Hive suite controller. No Node or Python runtime is required on this controller.
set -Eeuo pipefail
umask 077
HIVE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$HIVE_ROOT/scripts/suite/controller.sh"
hive_main "$@"
