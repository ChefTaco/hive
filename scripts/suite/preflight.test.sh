#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/result" 2>&1; then fail 'Unsafe preflight was accepted'; fi; [[ ! -e "$temporary/install/installation.json" && ! -e "$temporary/install/transaction.json" ]] || fail 'Preflight created deployment state'; }
mkdir -m 700 "$temporary/bin" "$temporary/install"
mkdir -p "$temporary/install/config/ingress" "$temporary/install/config/hive-registry"
for credential in read-token write-token; do printf '%064d\n' 0 > "$temporary/install/config/hive-registry/$credential"; chmod 600 "$temporary/install/config/hive-registry/$credential"; done
printf 'HIVE_REGISTRY_INSTALLATION=example-suite\n' > "$temporary/install/config/hive-registry.env"; chmod 600 "$temporary/install/config/hive-registry.env"
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
jq --arg directory "$temporary/install" '.profile="custom" | .hosts.control.directory=$directory | .components={"hive-registry":{host:"control",envFile:($directory+"/config/hive-registry.env"),configDirectory:($directory+"/config/hive-registry")},ingress:{host:"control",envFile:($directory+"/config/ingress.env"),configDirectory:($directory+"/config/ingress")},hivexui:{host:"control"}} | .console={host:"control",bindAddress:"127.0.0.1",httpsPort:65431,runtimeFile:($directory+"/config/runtime.json")}' "$ROOT/examples/installation.json" > "$temporary/config.json"
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
# A console certificate for another name is refused; x509 -checkhost would exit 0 for it.
cp "$temporary/install/config/ingress/console.crt" "$temporary/certificate.good"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/install/config/ingress/console.key" -out "$temporary/install/config/ingress/console.crt" -subj '/CN=wrong.example.com' -addext 'subjectAltName=DNS:wrong.example.com' -days 2 >/dev/null 2>&1
chmod 600 "$temporary/install/config/ingress/console.key"
reject "$ROOT/hive.sh" doctor --config "$temporary/config.json"
grep -q 'not valid for hive.example.com' "$temporary/result" || fail 'Wrong-name refusal does not name the origin'
cp "$temporary/certificate.good" "$temporary/install/config/ingress/console.crt"; cp "$temporary/key.good" "$temporary/install/config/ingress/console.key"
"$ROOT/hive.sh" doctor --config "$temporary/config.json" > "$temporary/result" || fail 'Restored certificate was refused'
# A missing host tool is named, with the command that installs it.
mkdir "$temporary/no-timeout"
IFS=: read -ra directories <<< "$PATH"
for directory in "${directories[@]}"; do
  for tool in "$directory"/*; do
    name=${tool##*/}
    [[ -x "$tool" && "$name" != timeout && ! -e "$temporary/no-timeout/$name" ]] && ln -s "$tool" "$temporary/no-timeout/$name"
  done
done
PATH=$temporary/no-timeout reject "$ROOT/hive.sh" doctor --config "$temporary/config.json"
grep -q 'Required tool missing on this host: timeout.*install-prerequisites.sh' "$temporary/result" || fail 'A missing host tool was not named'
printf 'Passed: read-only host preflight, secret-file permissions, certificate/key matching, public-runtime rejection, capacity and symlink refusal, wrong-name certificates and named missing tools.\n'
