#!/usr/bin/env bash
# Optional native client preparation. Source with host-runtime helpers; no code
# or environment file is evaluated, no account is created and no agent is run.
skills_integration_error() { printf 'Hive Skills: %s\n' "$*" >&2; }
skills_integration_artifact() {
  local manifest="$directory/manifest.$plan.json" signature="$directory/signature.$plan" trust="$directory/trust.$plan.pub" expected
  [[ -f "$manifest" && ! -L "$manifest" && -f "$signature" && ! -L "$signature" && -f "$trust" && ! -L "$trust" ]] || { skills_integration_error 'Publisher-verified release files are required'; return 1; }
  expected=$(jq -er '.digest' <<< "$input") || return 1
  [[ $(sha256sum "$manifest" | cut -d ' ' -f1) == "$expected" ]] || { skills_integration_error 'Release digest differs'; return 1; }
  openssl pkeyutl -verify -pubin -inkey "$trust" -rawin -in "$manifest" -sigfile "$signature" >/dev/null 2>&1 || { skills_integration_error 'Publisher signature differs'; return 1; }
  jq -ce --arg version "$(jq -er .skillsDeployment.clientVersion <<< "$input")" '
    .nativeClients.hiveskills | select(.version==$version) |
    select((keys-["version","url","sha256","nodeVersion","files"]|length)==0) |
    select(.url|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._/-]+$") and (split("/")|all(.!=".."))) |
    select(.sha256|test("^[a-f0-9]{64}$")) |
    select(.nodeVersion|IN("v24.22.3","v26.13.1")) |
    select(.files|type=="object" and (keys-["LICENSE","NOTICE","archive-utils.mjs","hermes-sync.mjs"]|length)==0 and has("LICENSE") and has("NOTICE") and has("archive-utils.mjs") and has("hermes-sync.mjs") and all(.[];type=="string" and test("^[a-f0-9]{64}$")))
  ' "$manifest" || { skills_integration_error 'Selected exact native client is absent from the signed release'; return 1; }
}
skills_integration_regular() {
  local path=$1 permissions
  [[ -f "$path" && ! -L "$path" && -r "$path" && "$path" == "$(realpath -m -- "$path")" ]] || { skills_integration_error 'A declared protected file reference is invalid'; return 1; }
  permissions=$(stat -c %a -- "$path")
  (( (8#$permissions & 077)==0 )) || { skills_integration_error 'Credential and trust references must be owner-only'; return 1; }
}
skills_integration_root_path() {
  local path=$1 existing=$1 permissions
  [[ "$path" =~ ^/[A-Za-z0-9_./-]+$ && "$path" != *'/../'* && "$path" != */.. && "$path" != *'//'* ]] || { skills_integration_error 'Native client paths must be explicit canonical absolute paths'; return 1; }
  while [[ ! -e "$existing" && ! -L "$existing" ]]; do existing=$(dirname -- "$existing"); done
  [[ "$existing" == "$(realpath -e -- "$existing")" ]] || { skills_integration_error 'Root client paths cannot contain links'; return 1; }
  while :; do
    [[ ! -L "$existing" && $(stat -c %u -- "$existing") == 0 ]] || { skills_integration_error 'Native client and executable parents must be root-owned'; return 1; }
    permissions=$(stat -c %a -- "$existing"); (( (8#$permissions & 022)==0 )) || { skills_integration_error 'Native client and executable parents cannot be writable by other accounts'; return 1; }
    [[ "$existing" != / ]] || break; existing=$(dirname -- "$existing")
  done
}
skills_integration_verify_client() {
  local item=$1 artifact=$2 target name expected actual permissions
  target="$(jq -er .clientDirectory <<< "$item")/$(jq -er .sha256 <<< "$artifact")"
  if [[ ! -e "$target" && ! -L "$target" ]]; then return 2; fi
  [[ -d "$target" && ! -L "$target" ]] || { skills_integration_error 'Existing client path is not an immutable directory'; return 1; }
  skills_integration_root_path "$target" || return 1
  [[ -f "$target/.hive-client.json" && ! -L "$target/.hive-client.json" ]] || { skills_integration_error 'Existing native client has no provenance receipt; retain it for reviewed recovery'; return 1; }
  [[ $(stat -c %u -- "$target/.hive-client.json") == 0 ]] || { skills_integration_error 'Native client receipt ownership changed'; return 1; }
  permissions=$(stat -c %a -- "$target/.hive-client.json"); (( (8#$permissions & 022)==0 )) || { skills_integration_error 'Native client receipt is writable by another account'; return 1; }
  jq -e --arg sha "$(jq -er .sha256 <<< "$artifact")" --arg version "$(jq -er .version <<< "$artifact")" '.schema==1 and .artifactSHA256==$sha and .version==$version' "$target/.hive-client.json" >/dev/null || { skills_integration_error 'Existing native client provenance differs'; return 1; }
  [[ -z $(find "$target" ! -type f ! -type d -print -quit) && -z $(find "$target" -mindepth 1 -type d -print -quit) ]] || { skills_integration_error 'Native client contains unsupported file types'; return 1; }
  [[ $(find "$target" -mindepth 1 -maxdepth 1 -type f | wc -l) == "$(jq '.files|length+1' <<< "$artifact")" ]] || { skills_integration_error 'Native client inventory changed'; return 1; }
  while read -r name expected; do
    [[ -f "$target/$name" && ! -L "$target/$name" && $(stat -c %u -- "$target/$name") == 0 ]] || { skills_integration_error 'Native client file ownership changed'; return 1; }
    permissions=$(stat -c %a -- "$target/$name"); (( (8#$permissions & 022)==0 )) || { skills_integration_error 'Native client file permissions changed'; return 1; }
    actual=$(sha256sum "$target/$name" | cut -d ' ' -f1); [[ "$actual" == "$expected" ]] || { skills_integration_error 'Native client bytes differ from the signed release; no existing file will be overwritten'; return 1; }
  done < <(jq -r '.files|to_entries[]|[.key,.value]|@tsv' <<< "$artifact")
}
skills_integration_preflight() {
  [[ $(jq -r '.skillsDeployment!=null' <<< "$input") == true ]] || return 0
  local artifact item path owner uid permissions missing=false status
  artifact=$(skills_integration_artifact) || return 1
  jq -e '
    def id: type=="string" and test("^[a-z0-9][a-z0-9-]{1,62}$");
    def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
    .skillsDeployment as $s | ($s.registryId|id) and ($s.clientVersion|type=="string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    ($s.executor.origin|test("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$")) and ($s.executor.credentialFile|path) and
    all($s.targets[];(.target|id) and (.host|id) and (.agentTarget|id) and (.nodeId|type=="string" and test("^[A-Za-z0-9_-]{1,128}$")) and
      (.owner|test("^[a-z_][a-z0-9_-]{0,31}$")) and all([.home,.hermesHome,.environmentFile,.clientDirectory,.nodeBinary][];path) and ((.caFile // "/dev/null")|path)) and
    ([$s.targets[]|[.nodeId,.agentTarget]]|length==(unique|length)) and ([$s.targets[].target]|length==(unique|length))
  ' <<< "$input" >/dev/null || { skills_integration_error 'Explicit native Skills grants, existing node IDs and protected target references are required'; return 1; }
  # Only the registry-owning host reads the raw backend grant. Other hosts may
  # receive its SHA-256 through protected installation coordination.
  if jq -e '.placements.hiveskills!=null or .skillsVerifyExecutor==true' <<< "$input" >/dev/null; then
    path=$(jq -er .skillsDeployment.executor.credentialFile <<< "$input"); skills_integration_regular "$path" || return 1
    skills_integration_token_digest >/dev/null || return 1
    if jq -e '.skillsDeployment.executor.caFile!=null' <<< "$input" >/dev/null; then skills_integration_regular "$(jq -er .skillsDeployment.executor.caFile <<< "$input")" || return 1; fi
  fi
  while IFS= read -r item; do
    owner=$(jq -er .owner <<< "$item"); uid=$(id -u "$owner") || { skills_integration_error 'The explicit target account does not exist; accounts are never guessed or created'; return 1; }
    [[ "$uid" != 0 ]] || { skills_integration_error 'Native Skills profiles must use an explicit unprivileged account'; return 1; }
    for path in "$(jq -er .home <<< "$item")" "$(jq -er .hermesHome <<< "$item")"; do
      [[ -d "$path" && ! -L "$path" && "$path" == "$(realpath -e -- "$path")" && $(stat -c %u -- "$path") == "$uid" ]] || { skills_integration_error 'Existing explicit owner/profile directory is required'; return 1; }
    done
    path=$(jq -er .environmentFile <<< "$item"); skills_integration_regular "$path" || return 1
    [[ $(stat -c %u -- "$path") == "$uid" ]] || { skills_integration_error 'Native target credential file belongs to another account'; return 1; }
    skills_integration_root_path "$(jq -er .clientDirectory <<< "$item")" || return 1
    path=$(jq -er .nodeBinary <<< "$item"); skills_integration_root_path "$path" || return 1
    [[ -f "$path" && -x "$path" ]] || { skills_integration_error 'Explicit existing root-owned Node executable is required'; return 1; }
    [[ $(env -i PATH=/usr/bin:/bin "$path" --version) == "$(jq -er .nodeVersion <<< "$artifact")" ]] || { skills_integration_error 'Native Node version differs from the signed client runtime'; return 1; }
    if jq -e '.caFile!=null' <<< "$item" >/dev/null; then skills_integration_regular "$(jq -er .caFile <<< "$item")" || return 1; fi
    # Parse dotenv as data using the explicitly pinned native Node runtime.
    env -i PATH=/usr/bin:/bin "$path" --input-type=module -e '
      import {readFileSync} from "node:fs"; import {parseEnv} from "node:util";
      try { const bytes=readFileSync(process.argv[1],"utf8"); if(Buffer.byteLength(bytes)>65536)process.exit(1);
      const value=parseEnv(bytes),allowed=new Set(["HIVE_SKILLS_URL","HIVE_SKILLS_TARGET_TOKEN","HIVE_SKILLS_HERMES_VERSION","HIVE_SKILLS_TARGET","HERMES_HOME","HERMES_BIN","NODE_EXTRA_CA_CERTS"]);
      if(Object.keys(value).some(key=>!allowed.has(key)))process.exit(1);
      const url=new URL(value.HIVE_SKILLS_URL),token=value.HIVE_SKILLS_TARGET_TOKEN;
      if(url.protocol!=="https:"||url.username||url.password||url.hash||url.search||!token||token.length<32||token.length>4096||/[\r\n]/.test(token)||(value.NODE_EXTRA_CA_CERTS&&value.NODE_EXTRA_CA_CERTS!==process.argv[2]))process.exit(1);
      } catch { process.exit(1) }
    ' "$(jq -er .environmentFile <<< "$item")" "$(jq -r '.caFile // empty' <<< "$item")" || { skills_integration_error 'Native credential environment must contain dedicated Skills client values and matching explicit HTTPS trust only'; return 1; }
    status=0; skills_integration_verify_client "$item" "$artifact" || status=$?
    if (( status==2 )); then missing=true; elif (( status!=0 )); then return 1; fi
  done < <(jq -c --arg host "$host" '.skillsDeployment.targets[]|select(.host==$host)' <<< "$input")
  if [[ "$missing" == true && $(id -u) != 0 ]]; then
    skills_integration_error 'Native Skills client staging is held: prepare the exact signed client as root on this selected host, then rerun preflight. Hive never escalates or changes existing profiles/credentials.'; return 2
  fi
}
skills_integration_token_digest() {
  local path token
  path=$(jq -er .skillsDeployment.executor.credentialFile <<< "$input") || return 1
  skills_integration_regular "$path" || return 1; token=$(cat -- "$path")
  [[ ${#token} -ge 32 && ${#token} -le 4096 && "$token" != *$'\n'* && "$token" != *$'\r'* && "$token" != 'Bearer '* && "$token" =~ ^[A-Za-z0-9._~-]+$ ]] || { skills_integration_error 'Executor credential must be one protected raw token, never an Authorization header or environment file'; return 1; }
  printf '%s' "$token" | sha256sum | cut -d ' ' -f1
}
skills_integration_stage() {
  [[ $(jq -r '.skillsDeployment!=null' <<< "$input") == true ]] || return 0
  skills_integration_preflight || return $?
  local artifact item base target temporary archive source name expected status
  artifact=$(skills_integration_artifact) || return 1
  while IFS= read -r item; do
    status=0; skills_integration_verify_client "$item" "$artifact" || status=$?
    if (( status==0 )); then continue; elif (( status!=2 )); then return 1; fi
    [[ $(id -u) == 0 ]] || { skills_integration_error 'Explicit root operator staging is required'; return 2; }
    base=$(jq -er .clientDirectory <<< "$item"); target="$base/$(jq -er .sha256 <<< "$artifact")"
    install -d -m 755 -- "$base"; skills_integration_root_path "$base" || return 1
    temporary=$(mktemp -d "$base/.client-stage.XXXXXXXX"); chmod 700 "$temporary"
    archive="$temporary/client.tar.gz"; source=$(jq -r '.skillsClientArchive // empty' <<< "$input")
    if [[ -n "$source" ]]; then [[ -f "$source" && ! -L "$source" ]] || { skills_integration_error 'Selected cached client archive is invalid'; return 1; }; cp -- "$source" "$archive"
    else curl --disable --silent --show-error --fail --proto '=https' --tlsv1.2 --max-time 60 --max-filesize 2097152 --output "$archive" "$(jq -er .url <<< "$artifact")" || { skills_integration_error 'Client download did not complete; its private partial stage was retained'; return 1; }; fi
    [[ $(sha256sum "$archive" | cut -d ' ' -f1) == "$(jq -er .sha256 <<< "$artifact")" ]] || { skills_integration_error 'Native client archive digest differs; partial evidence retained'; return 1; }
    tar -tvzf "$archive" | awk 'substr($0,1,1)!="-" {bad=1} END {exit bad}' || { skills_integration_error 'Native client archive must contain only flat regular files'; return 1; }
    [[ $(tar -tzf "$archive" | LC_ALL=C sort | uniq -d | wc -l) == 0 ]] || { skills_integration_error 'Duplicate native client archive entries'; return 1; }
    [[ $(tar -tzf "$archive" | LC_ALL=C sort) == "$(jq -r '.files|keys[]' <<< "$artifact" | LC_ALL=C sort)" ]] || { skills_integration_error 'Native client archive inventory differs from its signed allowlist'; return 1; }
    install -d -m 755 "$temporary/client"
    tar -xzf "$archive" -C "$temporary/client" --no-same-owner --no-same-permissions
    while read -r name expected; do [[ $(sha256sum "$temporary/client/$name" | cut -d ' ' -f1) == "$expected" ]] || { skills_integration_error 'Extracted client file differs'; return 1; }; chmod 444 "$temporary/client/$name"; done < <(jq -r '.files|to_entries[]|[.key,.value]|@tsv' <<< "$artifact")
    jq -n --arg sha "$(jq -er .sha256 <<< "$artifact")" --arg version "$(jq -er .version <<< "$artifact")" --arg manifest "$(jq -er .digest <<< "$input")" '{schema:1,artifactSHA256:$sha,version:$version,releaseSHA256:$manifest}' > "$temporary/client/.hive-client.json"; chmod 444 "$temporary/client/.hive-client.json"
    # Activate only a new immutable digest directory. Existing files are never
    # overwritten, deleted, chowned, adopted or used as extraction destinations.
    [[ ! -e "$target" && ! -L "$target" ]] || { skills_integration_error 'Client destination appeared concurrently; inspect then rerun exact verification'; return 1; }
    mv -T -- "$temporary/client" "$target"
    skills_integration_verify_client "$item" "$artifact" || return 1
  done < <(jq -c --arg host "$host" '.skillsDeployment.targets[]|select(.host==$host)' <<< "$input")
}
skills_integration_configuration() {
  [[ $(jq -r '.skillsDeployment!=null' <<< "$input") == true ]] || { printf 'null\n'; return 0; }
  local artifact token_sha=${1:-}
  artifact=$(skills_integration_artifact) || return 1
  [[ -n "$token_sha" ]] || token_sha=$(skills_integration_token_digest) || return 1
  [[ "$token_sha" =~ ^[a-f0-9]{64}$ ]] || { skills_integration_error 'Explicit executor token digest is required'; return 1; }
  jq -nc --argjson input "$input" --arg host "$host" --arg sha "$(jq -er .sha256 <<< "$artifact")" --arg token "$token_sha" '
    $input.skillsDeployment as $s |
    {registryId:$s.registryId,clientVersion:$s.clientVersion,artifactSHA256:$sha,
     skillsExecutor:({url:$s.executor.origin,credentialFile:"/config/skills-executor"}+(if $s.executor.caFile then {caFile:"/config/skills-executor-ca.pem"} else {} end)),
     magnusGrants:{($s.registryId):{tokenSha256:$token,targets:($s.targets|map({key:.target,value:{nodeId,agentTarget}})|from_entries)}},
     nativeTargets:($s.targets|map(select(.host==$host)|{key:.agentTarget,value:({registryId:$s.registryId,registryTarget:.target,owner,home,hermesHome,envFile:.environmentFile,syncScript:(.clientDirectory+"/"+$sha+"/hermes-sync.mjs"),nodeBinary}+(if .caFile then {caFile} else {} end))})|from_entries)}'
}

# Run on the registry host after explicit owner configuration and enrollment.
# This endpoint reads only current node posture; it never sends a native job.
skills_integration_verify_executor() {
  [[ $(jq -r '.skillsDeployment!=null' <<< "$input") == true ]] || return 0
  local artifact item origin token reply config expected client target node agent ca
  artifact=$(skills_integration_artifact) || return 1
  skills_integration_token_digest >/dev/null || return 1
  token=$(cat -- "$(jq -er .skillsDeployment.executor.credentialFile <<< "$input")")
  origin=$(jq -er .skillsDeployment.executor.origin <<< "$input")
  local -a trust=()
  ca=$(jq -r '.skillsDeployment.executor.caFile // empty' <<< "$input")
  if [[ -n "$ca" ]]; then skills_integration_regular "$ca" || return 1; trust=(--cacert "$ca"); fi
  while IFS= read -r item; do
    target=$(jq -er .target <<< "$item"); node=$(jq -er .nodeId <<< "$item"); agent=$(jq -er .agentTarget <<< "$item")
    config=$(jq -cS --arg registry "$(jq -er .skillsDeployment.registryId <<< "$input")" --arg sha "$(jq -er .sha256 <<< "$artifact")" '{registryId:$registry,registryTarget:.target,owner,home,hermesHome,envFile:.environmentFile,syncScript:(.clientDirectory+"/"+$sha+"/hermes-sync.mjs"),nodeBinary}+(if .caFile then {caFile} else {} end)' <<< "$item")
    expected=$(printf '%s' "$config" | sha256sum | cut -d ' ' -f1)
    reply=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl --disable --config - --silent --show-error --fail --proto '=https' --tlsv1.2 --max-time 20 --max-filesize 16384 "${trust[@]}" "$origin/api/v1/hiveskills/targets/$target") || { skills_integration_error 'Owning executor posture unavailable: configure the dedicated Magnus grant and explicitly enroll the chosen node before enabling Skills deployment'; return 2; }
    jq -e --arg registry "$(jq -er .skillsDeployment.registryId <<< "$input")" --arg target "$target" --arg node "$node" --arg agent "$agent" --arg expected "$expected" --arg client "$(jq -er '.files["hermes-sync.mjs"]' <<< "$artifact")" '.ready==true and .registryId==$registry and .target==$target and .nodeId==$node and .agentTarget==$agent and .configurationSha256==$expected and .clientSha256==$client' <<< "$reply" >/dev/null || { skills_integration_error 'Native Skills target is held: exact enrollment, profile mapping and signed client must all match; no deployment was sent'; return 2; }
  done < <(jq -c '.skillsDeployment.targets[]' <<< "$input")
}
