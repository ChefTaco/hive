#!/usr/bin/env bash
# Installs the packed server packages with npm 12, which blocks dependency install
# scripts unless they are allowed, and checks the native add-ons load:
#   1. through the launcher (`hive install`), which allows them in ~/.hive/runtime;
#   2. into a project that allows them in its package.json, as the READMEs describe.
# Build first (`npm run build`). Usage: bash scripts/check-npm12-install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo ">>> Packing the launcher and the servers"
mkdir -p "$WORK/tgz"
for dir in packages/hive services/hive-mem/ts-core services/hive-router services/hive-iam/apps/iam-core; do
  (cd "$ROOT/$dir" && npm pack --ignore-scripts --silent --pack-destination "$WORK/tgz" >/dev/null)
done

echo ">>> Installing npm 12"
npm install --silent --no-fund --no-audit --prefix "$WORK/npm12" npm@12 >/dev/null
export PATH="$WORK/npm12/node_modules/.bin:$PATH"
case "$(npm --version)" in
  12.*) echo "npm $(npm --version)" ;;
  *) echo "expected npm 12, got $(npm --version)" >&2; exit 1 ;;
esac
export npm_config_cache="$WORK/cache"

echo ">>> 1. hive install, with npm 12 on PATH"
mkdir -p "$WORK/app"
(cd "$WORK/app" && npm init -y >/dev/null && npm install --silent --no-fund --no-audit "$WORK"/tgz/hivemagnus-hive-1.*.tgz >/dev/null)
# `hive install` fails if a server's native add-ons do not load after npm finishes.
HIVE_HOME="$WORK/home" "$WORK/app/node_modules/.bin/hive" install memory router iam --from "$WORK/tgz" --yes
node -e 'const m=require(process.argv[1]); if (!m.allowScripts || m.allowScripts["better-sqlite3"] !== true || m.allowScripts.argon2 !== true) { console.error("runtime package.json lacks allowScripts"); process.exit(1) }' "$WORK/home/runtime/package.json"

echo ">>> 2. A project that allows the add-ons in package.json"
mkdir -p "$WORK/project"
cat > "$WORK/project/package.json" <<'EOF'
{ "name": "npm12-check", "private": true, "allowScripts": { "better-sqlite3": true, "argon2": true } }
EOF
(cd "$WORK/project" && npm install --silent --no-fund --no-audit "$WORK"/tgz/hivemagnus-hive-router-1.*.tgz "$WORK"/tgz/hivemagnus-hive-iam-server-1.*.tgz >/dev/null)
(cd "$WORK/project" && node -e '
  new (require("better-sqlite3"))(":memory:").close();
  require("argon2").hash("check").then(() => console.log("better-sqlite3 and argon2 load"));
')

echo "npm 12 install check passed."
