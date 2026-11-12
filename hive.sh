#!/usr/bin/env bash
# Hive suite controller. No Node or Python runtime is required on this controller.
set -Eeuo pipefail
umask 077
HIVE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$HIVE_ROOT/scripts/suite/controller.sh"
source "$HIVE_ROOT/scripts/suite/guided-setup.sh"
hive_setup_start "$@"
source "$HIVE_ROOT/scripts/suite/release-launcher.sh"
hive_release_launch "$@"
source "$HIVE_ROOT/scripts/suite/lifecycle.sh"
source "$HIVE_ROOT/scripts/suite/adapters.sh"
source "$HIVE_ROOT/scripts/suite/skills-integration.sh"
source "$HIVE_ROOT/scripts/suite/initialize.sh"
source "$HIVE_ROOT/scripts/suite/registry.sh"
source "$HIVE_ROOT/scripts/suite/memory-credential.sh"
source "$HIVE_ROOT/scripts/suite/magnus-gateway.sh"
source "$HIVE_ROOT/scripts/suite/migrate-native.sh"
source "$HIVE_ROOT/scripts/suite/cindertrace.sh"
source "$HIVE_ROOT/scripts/suite/magnus-agent.sh"
source "$HIVE_ROOT/scripts/suite/console-clients.sh"
source "$HIVE_ROOT/scripts/suite/post-upgrade.sh"
source "$HIVE_ROOT/scripts/suite/setup-checklist.sh"
hive_main "$@"
