#!/usr/bin/env bash
# Offline bootstrap contracts with real Git checkouts and Ed25519 signatures.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() {
  rm -f "$TEST_RESULT"
  if "$@" > "$temporary/output" 2> "$temporary/error"; then fail 'Unsafe launch was accepted'; fi
  [[ ! -e "$TEST_RESULT" ]] || fail 'Rejected launch executed the controller'
}
export REAL_GIT TEST_REMOTE TEST_RESULT TEST_API TEST_LOG XDG_DATA_HOME TEST_ROOT
REAL_GIT=$(command -v git)
TEST_REMOTE=$temporary/remote TEST_ROOT=$temporary/launcher
TEST_RESULT=$temporary/result TEST_API=$temporary/api TEST_LOG=$temporary/log
XDG_DATA_HOME=$temporary/data
mkdir -p "$TEST_REMOTE/releases" "$TEST_REMOTE/trust" "$TEST_REMOTE/scripts/suite" "$TEST_ROOT/scripts/suite" "$TEST_ROOT/trust" "$temporary/bin" "$temporary/work dir"
openssl genpkey -algorithm ED25519 -out "$temporary/key" >/dev/null 2>&1
openssl pkey -in "$temporary/key" -pubout -out "$TEST_REMOTE/trust/publisher.pub" >/dev/null 2>&1
cp "$TEST_REMOTE/trust/publisher.pub" "$TEST_ROOT/trust/publisher.pub"
cp "$ROOT/scripts/suite/release-launcher.sh" "$TEST_ROOT/scripts/suite/"
cat > "$TEST_ROOT/hive.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
HIVE_ROOT=$TEST_ROOT
hive_die() { printf '%s\n' "$*" >&2; exit 1; }
hive_need() { command -v "$1" >/dev/null || hive_die "Missing $1"; }
hive_controller_digest() { printf '%064d\n' 1; }
source "$HIVE_ROOT/scripts/suite/release-launcher.sh"
hive_release_launch "$@"
printf 'local\n' > "$TEST_RESULT"
SH
cat > "$TEST_REMOTE/hive.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
jq -n --arg cwd "$PWD" --args '{cwd:$cwd,args:$ARGS.positional}' -- "$@" > "$TEST_RESULT"
if [[ ${TEST_READ_STDIN:-false} == true ]]; then IFS= read -r answer; printf '%s\n' "$answer" > "$TEST_RESULT.stdin"; fi
exit "${TEST_EXIT:-0}"
SH
cat > "$TEST_REMOTE/scripts/suite/controller.sh" <<'SH'
hive_runtime_files() {
  printf '%s\n' hive.sh \
    scripts/suite/controller.sh
}
SH
digest=$( (cd "$TEST_REMOTE"; sha256sum --zero hive.sh scripts/suite/controller.sh) | sha256sum | cut -d ' ' -f1)
"$REAL_GIT" -C "$TEST_REMOTE" init -q
"$REAL_GIT" -C "$TEST_REMOTE" config user.name 'Synthetic Test'
"$REAL_GIT" -C "$TEST_REMOTE" config user.email 'test@example.com'
for version in 2.0.4 2.0.5; do
  jq -n --arg version "$version" --arg digest "$digest" '{schema:1,version:$version,controllerSHA256:$digest}' > "$TEST_REMOTE/releases/$version.json"
  openssl pkeyutl -sign -inkey "$temporary/key" -rawin -in "$TEST_REMOTE/releases/$version.json" -out "$TEST_REMOTE/releases/$version.json.sig"
  "$REAL_GIT" -C "$TEST_REMOTE" add .
  "$REAL_GIT" -C "$TEST_REMOTE" commit -qm "Synthetic $version"
  "$REAL_GIT" -C "$TEST_REMOTE" tag "v$version"
done
cat > "$temporary/bin/curl" <<'SH'
#!/usr/bin/env bash
printf 'api\n' >> "$TEST_LOG"
[[ ${*: -1} == https://api.github.com/repos/ChefTaco/hive/releases/latest ]] || exit 91
[[ ${TEST_API_FAIL:-false} != true ]] || exit 22
cat "$TEST_API"
SH
cat > "$temporary/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" clone "* ]]; then
  printf 'clone\n' >> "$TEST_LOG"
  [[ ${TEST_CLONE_FAIL:-false} != true ]] || exit 1
  target=${*: -1}
  tag=''
  while (($#)); do if [[ $1 == --branch ]]; then tag=$2; fi; shift; done
  "$REAL_GIT" -c core.hooksPath=/dev/null clone -q --no-hardlinks --branch "$tag" "$TEST_REMOTE" "$target" 2>/dev/null
  "$REAL_GIT" -C "$target" remote set-url origin https://github.com/ChefTaco/hive.git
else exec "$REAL_GIT" "$@"; fi
SH
chmod +x "$temporary/bin/"*
export PATH=$temporary/bin:$PATH
cd "$temporary/work dir"
printf '%s\n' '{"draft":false,"prerelease":false,"tag_name":"v2.0.5"}' > "$TEST_API"
bash "$TEST_ROOT/hive.sh" plan --config 'relative config.json' --release latest --non-interactive > "$temporary/output" 2> "$temporary/error"
jq -e '.cwd|endswith("work dir")' "$TEST_RESULT" >/dev/null || fail 'Working directory changed'
jq -e '.args==["plan","--config","relative config.json","--release","2.0.5","--non-interactive"]' "$TEST_RESULT" >/dev/null || fail 'Arguments were not preserved'
grep -q 'latest resolved to 2.0.5' "$temporary/error" || fail 'Resolved version was not reported'
[[ ! -s "$temporary/output" ]] || fail 'Launcher polluted controller stdout'
[[ $(stat -c %a "$XDG_DATA_HOME/hive/releases") == 700 ]] || fail 'Release directory is not private'
# Exact versions work offline and reuse the release controller.
TEST_API_FAIL=true bash "$TEST_ROOT/hive.sh" --release 2.0.5 2>/dev/null
[[ $(grep -c clone "$TEST_LOG") == 1 ]] || fail 'A cached version was downloaded again'
[[ $(grep -c api "$TEST_LOG") == 1 ]] || fail 'An exact version contacted the API'
bash "$TEST_ROOT/hive.sh" --release 2.0.4 2>/dev/null
jq -e '.args==["--release","2.0.4"]' "$TEST_RESULT" >/dev/null || fail 'Explicit older release was ignored'
# stdin remains the terminal/input stream; exit status belongs to the selected controller.
printf 'synthetic answer\n' | TEST_READ_STDIN=true bash "$TEST_ROOT/hive.sh" --release 2.0.5 2>/dev/null
[[ $(cat "$TEST_RESULT.stdin") == 'synthetic answer' ]] || fail 'Controller lost stdin'
if TEST_EXIT=23 bash "$TEST_ROOT/hive.sh" --release 2.0.5 2>/dev/null; then fail 'Controller failure was swallowed'; else [[ $? == 23 ]] || fail 'Controller exit code changed'; fi
# No implicit online selection; custom signed files and help retain local behavior.
for arguments in '' '--help --release latest' '--release 0.1.0 --manifest synthetic.json' '--config --release'; do
  read -r -a values <<< "$arguments"
  bash "$TEST_ROOT/hive.sh" "${values[@]}"
  [[ $(cat "$TEST_RESULT") == local ]] || fail 'Existing local path changed'
done
reject bash "$TEST_ROOT/hive.sh" --release latest --manifest synthetic.json
reject bash "$TEST_ROOT/hive.sh" backup --release latest
reject bash "$TEST_ROOT/hive.sh" --release latest --release 2.0.5
reject bash "$TEST_ROOT/hive.sh" --release ../bad
reject env TEST_API_FAIL=true bash "$TEST_ROOT/hive.sh" --release latest
for json in '{}' 'not json' '{"draft":true,"prerelease":false,"tag_name":"v2.0.5"}' '{"draft":false,"prerelease":true,"tag_name":"v2.0.6-rc.1"}' '{"draft":false,"prerelease":false,"tag_name":"v1.2.2"}' '{"draft":false,"prerelease":false,"tag_name":"v../../bad"}'; do
  printf '%s\n' "$json" > "$TEST_API"
  reject bash "$TEST_ROOT/hive.sh" --release latest
done
printf '%s\n' '{"draft":false,"prerelease":false,"tag_name":"v2.0.4"}' > "$TEST_API"
bash "$TEST_ROOT/hive.sh" --release latest 2>/dev/null
jq -e '.args==["--release","2.0.4"]' "$TEST_RESULT" >/dev/null || fail 'latest was not resolved anew'
# Changes, wrong tags, missing files and publisher/signature tampering fail before execution.
checkout=$XDG_DATA_HOME/hive/releases/2.0.5
printf '\n' >> "$checkout/hive.sh"
reject bash "$TEST_ROOT/hive.sh" --release 2.0.5
"$REAL_GIT" -C "$checkout" checkout -- hive.sh
"$REAL_GIT" -C "$checkout" checkout -q v2.0.4
reject bash "$TEST_ROOT/hive.sh" --release 2.0.5
"$REAL_GIT" -C "$checkout" checkout -q v2.0.5
cp "$TEST_ROOT/trust/publisher.pub" "$temporary/original.pub"
openssl genpkey -algorithm ED25519 -out "$temporary/other.key" >/dev/null 2>&1
openssl pkey -in "$temporary/other.key" -pubout -out "$TEST_ROOT/trust/publisher.pub" >/dev/null 2>&1
reject bash "$TEST_ROOT/hive.sh" --release 2.0.5
grep -q "publisher key differs" "$temporary/error" || fail "Publisher key change was not checked"
cp "$temporary/original.pub" "$TEST_ROOT/trust/publisher.pub"
# A clean, re-tagged checkout still cannot execute source absent from the signed digest.
original=$("$REAL_GIT" -C "$checkout" rev-parse HEAD)
printf '\n' >> "$checkout/hive.sh"
"$REAL_GIT" -C "$checkout" -c user.name='Synthetic Test' -c user.email=test@example.com commit -qam 'Synthetic source tamper'
"$REAL_GIT" -C "$checkout" tag -f v2.0.5 >/dev/null
reject bash "$TEST_ROOT/hive.sh" --release 2.0.5
grep -q 'source digest does not match' "$temporary/error" || fail 'Controller digest was not checked before execution'
"$REAL_GIT" -C "$checkout" reset --hard -q "$original"
"$REAL_GIT" -C "$checkout" tag -f v2.0.5 >/dev/null
# Commit a corrupt signature so the Git cleanliness check alone cannot reject it.
printf 'invalid' > "$checkout/releases/2.0.5.json.sig"
"$REAL_GIT" -C "$checkout" -c user.name='Synthetic Test' -c user.email=test@example.com commit -qam 'Synthetic tamper'
"$REAL_GIT" -C "$checkout" tag -f v2.0.5 >/dev/null
reject bash "$TEST_ROOT/hive.sh" --release 2.0.5
grep -q 'signature verification failed' "$temporary/error" || fail 'Corrupt signature was not checked'
reject env TEST_CLONE_FAIL=true bash "$TEST_ROOT/hive.sh" --release 2.0.6
[[ -z $(find "$XDG_DATA_HOME/hive/releases" -maxdepth 1 -name '.download-*' -print) ]] || fail 'Failed download left staging files'
# A controller already matching the exact manifest remains local and offline.
mkdir -p "$TEST_ROOT/releases"
jq -n '{controllerSHA256:("0"*63+"1")}' > "$TEST_ROOT/releases/2.0.7.json"
TEST_API_FAIL=true bash "$TEST_ROOT/hive.sh" --release 2.0.7
[[ $(cat "$TEST_RESULT") == local ]] || fail 'Matching local release was replaced'
printf 'Passed: latest and explicit versions, exact forwarding, offline reuse, stdin, exit status, signed checkouts and fail-closed resolution.\n'
