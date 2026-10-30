#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HIVE_SKILLS_PUBLIC_URL="${HIVE_SKILLS_PUBLIC_URL:?Set the target registry URL}"
TARGET_HOST="${HIVE_SKILLS_TARGET_HOST:?Set HIVE_SKILLS_TARGET_HOST to the agent host}"
TARGET_USER="${HIVE_SKILLS_TARGET_USER:?Set HIVE_SKILLS_TARGET_USER to the agent account}"
TARGET=""
while [[ $# -gt 0 ]]; do case "$1" in --target) TARGET="${2:?missing target}"; shift 2;; *) echo "Usage: $0 --target <name>" >&2; exit 64;; esac; done
[[ "$TARGET" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || { echo "Invalid target name" >&2; exit 64; }
[[ "$TARGET_HOST" =~ ^[A-Za-z0-9.-]+$ && "$TARGET_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ && "$HIVE_SKILLS_PUBLIC_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "Unsafe target or registry URL" >&2; exit 64; }
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "${TARGET_USER}@${TARGET_HOST}")
SCP=(scp -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15)
"${SSH[@]}" "sudo -n loginctl enable-linger '$TARGET_USER'"
"${SSH[@]}" 'mkdir -p ~/.local/lib/hive-skills ~/.config/systemd/user'
"${SCP[@]}" "$ROOT/scripts/hermes-sync.mjs" "$ROOT/scripts/archive-utils.mjs" "${TARGET_USER}@${TARGET_HOST}:.local/lib/hive-skills/"
"${SSH[@]}" "chmod 700 ~/.local/lib/hive-skills/hermes-sync.mjs; cat > ~/.config/systemd/user/hive-skills-sync.service <<'UNIT'
[Unit]
Description=Pull verified Skills from hive-skills registry
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=HIVE_SKILLS_URL=${HIVE_SKILLS_PUBLIC_URL}
EnvironmentFile=-%h/.config/hive-skills/bridge.env
ExecStart=/usr/bin/node %h/.local/lib/hive-skills/hermes-sync.mjs
UNIT
cat > ~/.config/systemd/user/hive-skills-sync.timer <<'UNIT'
[Unit]
Description=Refresh Hermes registry skills

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
RandomizedDelaySec=90s
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload && systemctl --user enable --now hive-skills-sync.timer && systemctl --user start hive-skills-sync.service"
echo "Installed hive-skills sync timer on $TARGET ($TARGET_USER@$TARGET_HOST)"
