#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/result" 2>&1; then fail 'Unsafe preflight was accepted'; fi; [[ ! -e "$temporary/install/installation.json" && ! -e "$temporary/install/transaction.json" ]] || fail 'Preflight created deployment state'; }
mkdir -m 700 "$temporary/bin" "$temporary/install"
mkdir -p "$temporary/install/config/ingress"
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
case "$*" in 'info'|'compose version') exit 0;; *) exit 99;; esac
SH
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/install/config/ingress/console.key" -out "$temporary/install/config/ingress/console.crt" -subj '/CN=hive.example.com' -addext 'subjectAltName=DNS:hive.example.com' -days 2 >/dev/null 2>&1
chmod 600 "$temporary/install/config/ingress/console.key"
cp "$temporary/install/config/ingress/console.crt" "$temporary/install/config/ingress/backend-ca.pem"
cp "$ROOT/deployment/Caddyfile" "$temporary/install/config/ingress/Caddyfile"
printf 'HIVE_CONSOLE_HOST=hive.example.com\n' > "$temporary/install/config/ingress.env"
chmod 600 "$temporary/install/config/ingress.env"
cat > "$temporary/install/config/runtime.json" <<'JSON'
{"schema":1,"products":{"oathweave":"/api/oathweave"},"identity":{"issuer":"https://identity.example.com","apiPrefix":"/api/oathweave","clients":{"oathweave":"hivexui-oathweave"}}}
JSON
jq --arg directory "$temporary/install" '.profile="custom" | .hosts.control.directory=$directory | .components={ingress:{host:"control",envFile:($directory+"/config/ingress.env"),configDirectory:($directory+"/config/ingress")},hivexui:{host:"control"}} | .console={host:"control",bindAddress:"127.0.0.1",httpsPort:65431,runtimeFile:($directory+"/config/runtime.json")}' "$ROOT/examples/installation.json" > "$temporary/config.json"
# Avoid a system-dependent port assumption in this read-only test.
while [[ -n $(ss -H -lnt "sport = :$(jq -r .console.httpsPort "$temporary/config.json")") ]]; do
  jq '.console.httpsPort-=1' "$temporary/config.json" > "$temporary/next.json"
  mv "$temporary/next.json" "$temporary/config.json"
done
"$ROOT/hive.sh" doctor --config "$temporary/config.json" > "$temporary/result"
[[ ! -e "$temporary/install/installation.json" ]] || fail 'Doctor changed installation ownership'
cp "$temporary/install/config/runtime.json" "$temporary/runtime.good"
jq '.identity.password="obviously-fake"' "$temporary/runtime.good" > "$temporary/install/config/runtime.json"
reject "$ROOT/hive.sh" doctor --config "$temporary/config.json"
cp "$temporary/runtime.good" "$temporary/install/config/runtime.json"
chmod 644 "$temporary/install/config/ingress.env"
reject "$ROOT/hive.sh" doctor --config "$temporary/config.json"
chmod 600 "$temporary/install/config/ingress.env"
jq '.hosts.control.minimumFreeMiB=999999999999' "$temporary/config.json" > "$temporary/full.json"
reject "$ROOT/hive.sh" doctor --config "$temporary/full.json"
cp "$temporary/install/config/ingress/console.key" "$temporary/key.good"
openssl genpkey -algorithm ED25519 -out "$temporary/install/config/ingress/console.key" >/dev/null 2>&1
reject "$ROOT/hive.sh" doctor --config "$temporary/config.json"
cp "$temporary/key.good" "$temporary/install/config/ingress/console.key"
ln -s "$temporary/install" "$temporary/linked"
jq --arg directory "$temporary/linked" '.hosts.control.directory=$directory' "$temporary/config.json" > "$temporary/symlink.json"
reject "$ROOT/hive.sh" doctor --config "$temporary/symlink.json"
printf 'Passed: read-only host preflight, secret-file permissions, certificate/key matching, public-runtime rejection, capacity and symlink refusal.\n'
