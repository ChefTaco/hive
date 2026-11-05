#!/usr/bin/env bash
# Hive suite controller. No Node or Python runtime is required on this controller.
set -Eeuo pipefail
umask 077
HIVE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$HIVE_ROOT/scripts/suite/controller.sh"
source "$HIVE_ROOT/scripts/suite/lifecycle.sh"
source "$HIVE_ROOT/scripts/suite/adapters.sh"
source "$HIVE_ROOT/scripts/suite/skills-integration.sh"
source "$HIVE_ROOT/scripts/suite/initialize.sh"
hive_main "$@"
