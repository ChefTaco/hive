#!/usr/bin/env bash
# The HiveMem identity relink through the real host program: a crash after an environment file
# moved but before its pin, then the ordinary retry of the same upgrade step. The retry must
# finish exactly the journaled change before any deployment-input guard compares digests, and
# still refuse any other edit. No containers are started; docker is a fixture.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
directory="$temporary/install"
export RETRY_FIXTURE="$temporary"
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
# Plays Compose and HiveMem: the rename verifier passes, issue-token echoes its claims.
set -Eeuo pipefail
[[ $1 != ps ]] || exit 0
[[ $1 == compose && $2 == -f ]] || exit 9
shift 3
case $1 in
  config|up|stop|down|logs|ps) exit 0;;
  run)
    [[ "$1 $2 $3 $4 $5" == 'run --no-deps --rm -T hivemem' ]] || exit 9
    shift 5
    (($#)) || exit 0 # the signed completion verifier: the live rename is complete
    [[ $1 == issue-token ]] || exit 9
    shift
    subject='' role='' scope='' ttl=''
    while (($#)); do case "$1" in --subject) subject=$2;; --role) role=$2;; --scope) scope=$2;; --ttl) ttl=$2;; esac; shift 2; done
    b64url() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
    printf '%s.%s.fake-signature\n' "$(b64url '{"alg":"HS256"}')" "$(b64url "$(jq -nc --arg s "$subject" --arg r "$role" --arg c "$scope" --argjson t "$ttl" '{sub:$s,role:$r,scope:$c,exp:(now+$t|floor)}')")";;
  *) exit 9;;
esac
DOCKER
# Crash injection: once hivemem.env has been replaced, the host program dies without cleanup.
cat > "$temporary/bin/mv" <<'MV'
#!/usr/bin/env bash
/bin/mv "$@" || exit
if [[ -e "$RETRY_FIXTURE/crash" && "${!#}" == */config/hivemem.env ]]; then
  rm -f -- "$RETRY_FIXTURE/crash"; kill -KILL "$PPID"
fi
MV
chmod 700 "$temporary/bin/docker" "$temporary/bin/mv"
export PATH="$temporary/bin:$PATH"
script=''
for file in ownership-host.sh public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh inference-registration.sh initialize-migrations-host.sh rehearsal-copy-host.sh host-runtime.sh; do
  script+=$(cat "$ROOT/scripts/suite/$file")$'\n'
done
plan=$(printf '%064d' 7)
host() {
  jq -nc --arg directory "$directory" --arg action "$1" --arg plan "$plan" --arg digest "$(printf '%064d' 2)" \
    '{directory:$directory,installation:"example-suite",host:"control",action:$action,plan:$plan,version:"0.2.0",digest:$digest,archive:"archive",operation:"upgrade",allowMigrations:true,integrityScript:"ZXhwb3J0IHt9",agents:[],inference:[],placements:{hivemem:{},emberpath:{}}}' |
    bash <(printf '%s\n' "$script") > "$temporary/host.log" 2>&1
}
value() { sed -n "s/^$2=//p" "$1" | tail -1 | sed "s/^'\(.*\)'$/\1/"; }
claims() { cut -d . -f2 <<< "$1" | tr '_-' '/+' | { read -r part; printf '%s%s' "$part" "$(printf '=%.0s' $(seq 1 $(( (4 - ${#part} % 4) % 4 ))))"; } | base64 -d; }
b64url() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
pinned() { ( die() { exit 1; }; source "$ROOT/scripts/suite/input-artifacts-host.sh"; assert_deployment_inputs "$directory/candidate.$plan.json" ) 2>/dev/null; }

spec='{"image":"example.com/hivemem@sha256:'"$(printf 'a%.0s' {1..64})"'","command":["rename-agent","--from","hive-router","--to","emberpath"],"verificationCommand":["rename-agent","--from","hive-router","--to","emberpath","--verify"]}'
reset() {
  rm -rf -- "$directory"
  mkdir -p "$directory/data/hivemem" "$directory/config/.credentials" "$directory/releases"
  config=$directory/config
  printf '{"installation":"example-suite","host":"control","uuid":"fixture"}' > "$directory/installation.json"
  printf '{"version":"0.1.0","digest":"%064d","plan":"%064d"}' 1 1 > "$directory/receipt.json"
  legacy="$(b64url '{"alg":"HS256"}').$(b64url '{"sub":"hive-router","role":"admin","scope":"admin:all","exp":'"$(( $(date +%s) + 86400 ))"'}').fake-signature"
  printf "HIVEMEM_OATHWEAVE_SERVICES_JSON='[{\"issuer\":\"hive-iam\",\"clientId\":\"emberpath-hivemem\",\"localId\":\"hive-router\",\"scopes\":[\"admin:all\"]}]'\n" > "$config/hivemem.env"
  printf "HIVE_ROUTER_MEMORY_PROXY_TOKEN='%s'\nHIVE_ROUTER_SECRET='fake-router-secret-0123456789abcdef0123'\n" "$legacy" > "$config/emberpath.env"
  chmod 600 "$config/"*.env
  printf '{"schema":1,"clientId":"emberpath-hivemem","localId":"hive-router"}\n' > "$config/.credentials/emberpath-hivemem.json"
  jq -n --arg base "$directory" --arg user "$(id -u):$(id -g)" '
    {name:"example-suite-control",services:{
      hivemem:{image:("example.com/hivemem@sha256:"+("a"*64)),user:$user,env_file:[($base+"/config/hivemem.env")],volumes:[{type:"bind",source:($base+"/data/hivemem"),target:"/data"}]},
      emberpath:{image:("example.com/emberpath@sha256:"+("b"*64)),user:$user,env_file:[($base+"/config/emberpath.env")]}}}' > "$directory/compose.json"
  cp "$directory/compose.json" "$directory/candidate.$plan.json"
  jq -n --argjson spec "$spec" '{schema:1,version:"0.2.0",components:{hivemem:{kind:"application",initialization:$spec},emberpath:{kind:"application"}}}' > "$directory/manifest.$plan.json"
  printf '{}' > "$directory/data-formats.json"
  for file in signature."$plan" trust."$plan".pub controller."$plan".tar.gz; do : > "$directory/$file"; done
  ( directory=$directory plan=$plan; die() { exit 1; }; atomic_json() { jq . > "$1"; }; source "$ROOT/scripts/suite/input-artifacts-host.sh"; pin_deployment_inputs "$directory/candidate.$plan.json" )
  host prepare || { cat "$temporary/host.log" >&2; fail 'Prepare failed'; }
}

# ---- Crash between the move and the pin; the ordinary retry of the step finishes it. ----
reset
touch "$temporary/crash"
if host migrate; then cat "$temporary/host.log" >&2; fail 'The crash was not simulated'; fi
[[ -f "$directory/memory-identity.$plan.json" ]] || { cat "$temporary/host.log" >&2; fail 'No journal survived the crash'; }
if pinned; then fail 'The fixture did not stop between the move and the pin'; fi
host migrate || { cat "$temporary/host.log" >&2; fail 'The retried migrate step did not finish the journaled change'; }
[[ $(jq -r '.[0].localId' <<< "$(value "$config/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON)") == emberpath ]] || fail 'HiveMem links still name the old principal'
claims "$(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN)" | jq -e '.sub=="emberpath"' >/dev/null || fail 'The static token was not re-issued'
pinned || fail 'The finished change is not pinned'
[[ ! -e "$directory/memory-identity.$plan.json" && -z $(find "$config" -name '*.memory-identity-staged') ]] || fail 'The journal or a staged file was left behind'
# The next step of the upgrade passes its guard as well.
( die() { exit 1; }; source "$ROOT/scripts/suite/input-artifacts-host.sh"; plan=$plan directory=$directory; assert_deployment_inputs "$directory/candidate.$plan.json" ) || fail 'A later guard refused the finished change'

# ---- The same crash followed by an unrelated edit: the retry still refuses. ----
reset
touch "$temporary/crash"
if host migrate; then fail 'The crash was not simulated'; fi
printf 'EXTRA=1\n' >> "$config/emberpath.env"
if host migrate; then fail 'An unrelated edit was accepted by the retry'; fi
grep -q -E 'changed outside this controller|Pinned deployment inputs changed' "$temporary/host.log" || { cat "$temporary/host.log" >&2; fail 'The refusal did not name the edit'; }
[[ -f "$directory/memory-identity.$plan.json" ]] || fail 'A refused recovery discarded its journal'

# ---- A journal that does not belong to this plan's pin is refused, not adopted. ----
reset
touch "$temporary/crash"
if host migrate; then fail 'The crash was not simulated'; fi
jq '.before=("0"*64)' "$directory/memory-identity.$plan.json" > "$temporary/edit"; /bin/mv "$temporary/edit" "$directory/memory-identity.$plan.json"
if host migrate; then fail 'A journal for another pin was adopted'; fi
grep -q 'does not match the pinned deployment inputs' "$temporary/host.log" || { cat "$temporary/host.log" >&2; fail 'The foreign journal was not named'; }

printf 'memory identity retry tests passed\n'
