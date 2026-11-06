#!/usr/bin/env bash
# Tests scripts/console-certificate.sh with a stubbed tailscale and Docker and generated test certificates.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/console-certificate.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'console-certificate test: %s\n' "$*" >&2; exit 1; }
user=$(id -un)
pair() {
  mkdir -p "$temporary/$1"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days "${3:-90}" -subj "/CN=$2" \
    -addext "subjectAltName=DNS:$2" -keyout "$temporary/$1/key.pem" -out "$temporary/$1/cert.pem" 2>/dev/null
  chmod 600 "$temporary/$1/key.pem"
}
pair first hive.example.com
pair second hive.example.com
pair other other.example.com

bin="$temporary/bin"; mkdir -p "$bin"
printf 'first\n' > "$temporary/issue"
cat > "$bin/tailscale" <<EOF
#!/usr/bin/env bash
case "\$1" in
  status) [[ -f "$temporary/https-off" ]] && { echo '{"Self":{"DNSName":"hive.example.com."},"CertDomains":null}'; exit; }
          echo '{"Self":{"DNSName":"hive.example.com."},"CertDomains":["hive.example.com"]}';;
  cert) shift; while (( \$# > 1 )); do case "\$1" in --cert-file) c=\$2; shift;; --key-file) k=\$2; shift;; esac; shift; done
        [[ "\$1" == hive.example.com ]] || exit 1
        source=$temporary/\$(cat "$temporary/issue"); cp "\$source/cert.pem" "\$c"; cp "\$source/key.pem" "\$k"; chmod 600 "\$k";;
esac
EOF
cat > "$bin/docker" <<EOF
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >> "$temporary/docker.log"
EOF
cat > "$bin/id" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == -u ]]; then echo 0; exit; fi
exec $(command -v id) "\$@"
EOF
chmod +x "$bin"/*
run() { env PATH="$bin:$PATH" SUDO_USER="$user" bash "$SCRIPT" "$@" > "$temporary/out" 2>&1; }
expect() { grep -qF -- "$1" "$temporary/out" || { cat "$temporary/out" >&2; fail "expected output: $1"; }; }

# check: the installer's rules, including the name, which openssl's -checkhost exit status ignores.
run check --cert "$temporary/first/cert.pem" --key "$temporary/first/key.pem" --name hive.example.com || fail 'valid pair refused'
expect 'is valid for hive.example.com'
run check --cert "$temporary/other/cert.pem" --key "$temporary/other/key.pem" --name hive.example.com && fail 'wrong name accepted'
expect 'not valid for hive.example.com'
run check --cert "$temporary/first/cert.pem" --key "$temporary/second/key.pem" && fail 'mismatched key accepted'
expect 'are not a key pair'
chmod 640 "$temporary/second/key.pem"
run check --cert "$temporary/second/cert.pem" --key "$temporary/second/key.pem" && fail 'group-readable key accepted'
expect 'owner-only'
chmod 600 "$temporary/second/key.pem"
ln -s "$temporary/first/cert.pem" "$temporary/link.pem"
run check --cert "$temporary/link.pem" --key "$temporary/first/key.pem" && fail 'symlink accepted'
pair short hive.example.com 1
run check --cert "$temporary/short/cert.pem" --key "$temporary/short/key.pem" && fail 'expiring certificate accepted'
expect 'expires within one day'

# tailscale: issues into the directory with the right owner and modes; a repeat changes nothing.
tls="$temporary/etc/hive/tls"
touch "$temporary/https-off"
run tailscale --dir "$tls" && fail 'issued with HTTPS certificates off'
expect 'HTTPS certificates are off'
rm "$temporary/https-off"
run tailscale --dir "$tls" || { cat "$temporary/out" >&2; fail 'tailscale issue failed'; }
expect 'Certificate for hive.example.com (new)'
expect "certificate: $tls/console.crt"
[[ $(stat -c '%a %U' "$tls/console.key") == "600 $user" && $(stat -c '%a %U' "$tls/console.crt") == "644 $user" ]] || fail 'file modes or owner'
[[ $(stat -c %a "$tls") == 750 ]] || fail 'directory mode'
run tailscale --dir "$tls" || fail 'repeat failed'
grep -q '(new)' "$temporary/out" && fail 'a repeat reported a new certificate'

# renew: refreshes the Tailscale certificate, then hands it to hive.sh tls-refresh as the owner.
checkout="$temporary/hive"
mkdir -p "$checkout/scripts/suite"
cp "$SCRIPT" "$checkout/scripts/console-certificate.sh"
printf '# hive.sh tls-refresh\n' > "$checkout/scripts/suite/controller.sh"
cat > "$checkout/hive.sh" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "\$(id -un)" "\$*" >> "$temporary/hive.log"
EOF
chmod +x "$checkout/hive.sh"
cat > "$bin/runuser" <<EOF
#!/usr/bin/env bash
printf 'runuser %s\n' "\$2" >> "$temporary/hive.log"; shift 3; exec "\$@"
EOF
chmod +x "$bin/runuser"
config="$temporary/installation.json"
jq -n --arg c "$tls/console.crt" --arg k "$tls/console.key" \
  '{origin:"https://hive.example.com",hosts:{control:{target:"local",directory:"/opt/hive"}},console:{host:"control"},
    components:{ingress:{host:"control",configDirectory:"/opt/hive/config/ingress"}},bootstrap:{certificateFile:$c,privateKeyFile:$k}}' > "$config"
printf 'second\n' > "$temporary/issue"
run renew --config "$config" --hive "$checkout" || { cat "$temporary/out" >&2; fail 'renew failed'; }
cmp -s "$temporary/second/cert.pem" "$tls/console.crt" || fail 'renew did not refresh the Tailscale certificate'
grep -qx "runuser $user" "$temporary/hive.log" || fail 'tls-refresh did not run as the owner of the configuration'
grep -qx "$user tls-refresh --config $config" "$temporary/hive.log" || fail 'renew did not run hive.sh tls-refresh'
# A certificate for another name never reaches hive.sh.
: > "$temporary/hive.log"
cp "$temporary/other/cert.pem" "$tls/console.crt"; cp "$temporary/other/key.pem" "$tls/console.key"
run renew --config "$config" --hive "$checkout" --no-tailscale && fail 'renewed with a certificate for another name'
[[ ! -s "$temporary/hive.log" ]] || fail 'a wrong-name certificate reached hive.sh'
jq '.hosts.control.target="deploy@hive.example.com"' "$config" > "$config.remote"
run renew --config "$config.remote" --hive "$checkout" && fail 'renewed a remote console host'
expect 'run this script on the console host'
printf '# no refresh here\n' > "$checkout/scripts/suite/controller.sh"
run renew --config "$config" --hive "$checkout" --no-tailscale && fail 'used a checkout without tls-refresh'
expect 'release 2.0.2 or later'
run bogus && fail 'accepted an unknown command'
printf 'console-certificate tests passed\n'
