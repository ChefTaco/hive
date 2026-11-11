#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$temporary/bin"
printf '#!/bin/sh\nexit 0\n' > "$temporary/bin/compose"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
case $1 in
  info) printf '%s\n' "$HIVE_MOCK_COMPOSE";;
  image) exit 1;;
  build) cat > "$HIVE_CAPTURE_DOCKERFILE"; exit 97;;
  *) exit 98;;
esac
DOCKER
chmod +x "$temporary/bin/docker" "$temporary/bin/compose"
status=0
PATH="$temporary/bin:$PATH" HIVE_MOCK_COMPOSE="$temporary/bin/compose" HIVE_CAPTURE_DOCKERFILE="$temporary/Dockerfile" \
  bash "$root/scripts/suite/sudo-host.sh" --scratch "$temporary/scratch" -- true > "$temporary/output" 2>&1 || status=$?
[[ $status == 97 && -s "$temporary/Dockerfile" ]] || fail 'The disposable host build was not captured before execution'
# Extract and exercise the real generated mirror configuration, including APT's required tab delimiter.
line=$(sed -n "/printf 'https:\/\/mirrors.kernel.org\/ubuntu/p" "$temporary/Dockerfile")
printf_command=${line#*&& }; printf_command=${printf_command% > *}
[[ $printf_command == "printf 'https://mirrors.kernel.org/ubuntu"* ]] || fail 'Expected the reviewed mirror command'
bash -c "$printf_command" > "$temporary/mirrors"
grep -qxF $'https://mirrors.kernel.org/ubuntu\tpriority:0' "$temporary/mirrors" || fail 'The independent mirror metadata is malformed'
grep -qxF $'https://archive.ubuntu.com/ubuntu\tpriority:1' "$temporary/mirrors" || fail 'The original archive fallback was removed'
grep -qxF $'https://security.ubuntu.com/ubuntu\tpriority:2' "$temporary/mirrors" || fail 'The security archive fallback was removed'
line=$(sed -n "/printf 'https:\/\/mirrors.mit.edu\/ubuntu-ports/p" "$temporary/Dockerfile")
printf_command=${line#*&& }; printf_command=${printf_command% > *}
[[ $printf_command == "printf 'https://mirrors.mit.edu/ubuntu-ports"* ]] || fail 'Expected the reviewed ports mirror command'
bash -c "$printf_command" > "$temporary/ports"
grep -qxF $'https://mirrors.mit.edu/ubuntu-ports\tpriority:0' "$temporary/ports" || fail 'The ports mirror metadata is malformed'
grep -qxF $'https://ports.ubuntu.com/ubuntu-ports\tpriority:1' "$temporary/ports" || fail 'The original ports fallback was removed'
grep -qF 'COPY --from=node /node-roots.pem /etc/ssl/certs/ca-certificates.crt' "$temporary/Dockerfile" || fail 'The pinned TLS bootstrap was removed'
! grep -Ei 'AllowInsecure|Verify-Peer|Verify-Host|trusted=yes|AllowUnauthenticated' "$temporary/Dockerfile" || fail 'Package or TLS authentication was weakened'
printf 'Passed: disposable recovery host uses tab-delimited HTTPS mirrors, retained upstream fallbacks and the pinned CA bootstrap before running any command.\n'
