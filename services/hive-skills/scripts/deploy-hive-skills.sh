#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT/services/hive-skills"
# Deployment target is explicit and never sourced from another host's env.
TARGET_HOST="${HIVE_SKILLS_DEPLOY_HOST:?Set HIVE_SKILLS_DEPLOY_HOST to the registry host}"
TARGET_USER="${HIVE_SKILLS_DEPLOY_USER:-deploy}"
[[ "$TARGET_HOST" =~ ^[A-Za-z0-9.-]+$ && "$TARGET_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || exit 64
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "$TARGET_USER@$TARGET_HOST")
SCP=(scp -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15)
source "$ROOT/scripts/lib/release-manager.sh"
RELEASE_ID="$(release_manager_new_id)"
REVISION="$(git -C "$ROOT" rev-parse HEAD)"
REMOTE=/opt/hive-skills
SUDO_SECRET="${HIVE_SKILLS_DEPLOY_SUDO_PASSWORD:-}"
remote_root() {
  if [[ -n "$SUDO_SECRET" ]]; then printf '%s\n%s\n' "$SUDO_SECRET" "$1" | "${SSH[@]}" "sudo -S -p '' bash -se";
  else printf '%s\n' "$1" | "${SSH[@]}" 'sudo -n bash -se'; fi
}
remote_root "mkdir -p '$REMOTE/releases/$RELEASE_ID' '$REMOTE/shared/data'; chown '$TARGET_USER:$TARGET_USER' '$REMOTE' '$REMOTE/releases' '$REMOTE/releases/$RELEASE_ID' '$REMOTE/shared' '$REMOTE/shared/data'"
# Existing credentials and host-specific registry content are always retained.
if ! "${SSH[@]}" "test -f '$REMOTE/shared/.env'"; then
  : "${HIVE_SKILLS_ENV_FILE:?New install requires its own HIVE_SKILLS_ENV_FILE}"
  "${SCP[@]}" "$HIVE_SKILLS_ENV_FILE" "$TARGET_USER@$TARGET_HOST:$REMOTE/shared/.env"
fi
"${SSH[@]}" "chmod 600 '$REMOTE/shared/.env'"
rsync -az --delete --exclude node_modules --exclude dist --exclude '.env*' --exclude data -e 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' "$SERVICE_DIR/" "$TARGET_USER@$TARGET_HOST:$REMOTE/releases/$RELEASE_ID/"
"${SCP[@]}" "$ROOT/scripts/lib/release-manager.sh" "$TARGET_USER@$TARGET_HOST:$REMOTE/releases/$RELEASE_ID/scripts/release-manager.sh"
"${SSH[@]}" "cd '$REMOTE/releases/$RELEASE_ID'; npm ci; npm run build; printf '%s\n' '$REVISION' > REVISION"
remote_root "
set -euo pipefail
source '$REMOTE/releases/$RELEASE_ID/scripts/release-manager.sh'
command -v pamtester >/dev/null || { apt-get update; apt-get install -y pamtester; }
if [[ ! -f /etc/pam.d/hive-skills ]]; then printf '%s\n' 'auth required pam_unix.so' 'account required pam_unix.so' > /etc/pam.d/hive-skills; chmod 644 /etc/pam.d/hive-skills; fi
if [[ -d '$REMOTE/current' && ! -L '$REMOTE/current' ]]; then mv '$REMOTE/current' '$REMOTE/releases/legacy-$RELEASE_ID'; ln -s 'releases/legacy-$RELEASE_ID' '$REMOTE/current'; fi
previous=\$(release_manager_current_id '$REMOTE')
cat > /etc/systemd/system/hive-skills.service <<'UNIT'
[Unit]
Description=Hive Skills registry
After=network-online.target hive-router.service
Wants=network-online.target
[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_USER
WorkingDirectory=$REMOTE/current
EnvironmentFile=$REMOTE/shared/.env
ExecStart=/usr/bin/node $REMOTE/current/dist/server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$REMOTE/shared
ReadOnlyPaths=/opt/hive-router/shared/certs
[Install]
WantedBy=multi-user.target
UNIT
release_manager_activate '$REMOTE' '$RELEASE_ID'
systemctl daemon-reload
systemctl enable hive-skills.service
set -a; source '$REMOTE/shared/.env'; set +a
ok=false
if systemctl restart hive-skills.service; then
  for attempt in {1..15}; do
    if curl --fail --silent --show-error --max-time 3 \"\${HIVE_SKILLS_PUBLIC_URL%/}/healthz\" >/dev/null; then ok=true; break; fi
    sleep 1
  done
fi
if [[ \$ok != true ]]; then
  if [[ -n \$previous ]]; then release_manager_activate '$REMOTE' \"\$previous\"; systemctl restart hive-skills.service; fi
  echo 'Skills health gate failed; previous release restored when available' >&2; exit 1
fi
release_manager_prune '$REMOTE' 5
"
echo "Skills deployed: $TARGET_HOST $REVISION ($RELEASE_ID)"
