#!/usr/bin/env bash
# Optional preparation only: owning backends apply reviewed configuration.
hive_skills_validate() {
  jq -e 'has("skillsDeployment")' "$HIVE_CONFIG" >/dev/null || return 0
  jq -e '
    def id: type=="string" and test("^[a-z0-9][a-z0-9-]{1,62}$");
    def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
    . as $c | .skillsDeployment as $s |
    ($c.components.hiveskills!=null and $c.components.magnus!=null) and
    ($s|type=="object" and (keys-["registryId","clientVersion","executor","targets"]|length)==0) and
    ($s.registryId|id) and ($s.clientVersion|type=="string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    ($s.executor|type=="object" and (keys-["origin","credentialFile","caFile"]|length)==0) and
    ($s.executor.origin|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$")) and
    ($s.executor.credentialFile|path) and (($s.executor.caFile // "/dev/null")|path) and
    ($s.targets|type=="array" and length>0 and length<=64) and
    all($s.targets[]; (keys-["target","host","nodeId","agentTarget","owner","home","hermesHome","environmentFile","clientDirectory","nodeBinary","caFile"]|length)==0 and
      (.target|id) and ($c.hosts[.host]!=null) and (.agentTarget|id) and
      (.nodeId|type=="string" and test("^[A-Za-z0-9_-]{1,128}$")) and
      (.owner|type=="string" and test("^[a-z_][a-z0-9_-]{0,31}$")) and
      all([.home,.hermesHome,.environmentFile,.clientDirectory,.nodeBinary,(.caFile // "/dev/null")][];path)) and
    ([$s.targets[].target]|length==(unique|length)) and ([$s.targets[]|[.nodeId,.agentTarget]]|length==(unique|length)) and
    ([$s.targets[]|[.host,.agentTarget]]|length==(unique|length))
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid optional Skills deployment: select Skills and Magnus, explicit existing node/profile mappings and protected references; targets are never guessed'
}
hive_skills_manifest() {
  if ! jq -e '.nativeClients!=null' "$HIVE_MANIFEST" >/dev/null; then
    ! jq -e 'has("skillsDeployment")' "$HIVE_CONFIG" >/dev/null || hive_die 'Selected native Skills client is absent from the signed release'
    return 0
  fi
  jq -e '
    .nativeClients|type=="object" and (keys-["hiveskills"]|length)==0 and
    (.hiveskills|type=="object" and (keys-["version","url","sha256","nodeVersion","files"]|length)==0 and
      (.version|type=="string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
      (.url|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._/-]+$") and (split("/")|all(.!=".."))) and
      (.sha256|type=="string" and test("^[a-f0-9]{64}$")) and (.nodeVersion|IN("v24.22.1","v26.13.0")) and
      (.files|type=="object" and (keys|sort)==(["LICENSE","NOTICE","archive-utils.mjs","hermes-sync.mjs"]|sort) and all(.[];type=="string" and test("^[a-f0-9]{64}$"))))
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'Invalid signed native Skills client: exact archive, file and tested runtime digests are required'
  if jq -e 'has("skillsDeployment")' "$HIVE_CONFIG" >/dev/null; then
    [[ $(jq -r .skillsDeployment.clientVersion "$HIVE_CONFIG") == "$(jq -r .nativeClients.hiveskills.version "$HIVE_MANIFEST")" ]] || hive_die 'Selected Skills client version differs from the exact signed release'
  fi
}
hive_skills_action() {
  HIVE_HOST_ACTION=$2 hive_host "$1" "$(cat "$HIVE_ROOT/scripts/suite/skills-integration-host.sh" "$HIVE_ROOT/scripts/suite/skills-preparation-host.sh")"
}
hive_skills_prepare() {
  jq -e 'has("skillsDeployment")' "$HIVE_CONFIG" >/dev/null || hive_die 'skills-prepare requires explicit skillsDeployment configuration; existing profiles are never inferred'
  HIVE_SKILLS_MANIFEST=$(base64 -w0 "$HIVE_MANIFEST") HIVE_SKILLS_SIGNATURE=$(base64 -w0 "$HIVE_SIGNATURE") HIVE_SKILLS_TRUST=$(base64 -w0 "$HIVE_TRUST_KEY")
  local registry_host host status held=false
  registry_host=$(jq -er .components.hiveskills.host "$HIVE_CONFIG")
  HIVE_SKILLS_TOKEN_SHA=$(hive_skills_action "$registry_host" token) || hive_die 'Protected registry executor reference could not be verified'
  [[ "$HIVE_SKILLS_TOKEN_SHA" =~ ^[a-f0-9]{64}$ ]] || hive_die 'Registry returned an invalid executor digest'
  local hosts
  hosts=$(jq -r '[.skillsDeployment.targets[].host,.components.hiveskills.host,.components.magnus.host]|unique[]' "$HIVE_CONFIG")
  # Validate every host before staging any client or writing any proposal.
  while IFS= read -r host; do
    status=0; hive_skills_action "$host" preflight || status=$?
    if ((status==2)); then held=true; elif ((status!=0)); then hive_die 'Skills reference preflight failed; no client or configuration proposal was written'; fi
  done <<< "$hosts"
  while IFS= read -r host; do
    status=0; hive_skills_action "$host" stage || status=$?
    if ((status==2)); then held=true; elif ((status!=0)); then hive_die 'Native Skills client staging failed; all existing clients and profiles were retained'; fi
  done <<< "$hosts"
  while IFS= read -r host; do hive_skills_action "$host" proposal || hive_die 'Protected Skills proposal could not be written'; done <<< "$hosts"
  status=0; hive_skills_action "$registry_host" verify || status=$?
  if ((status!=0)); then held=true; fi
  if [[ "$held" == true ]]; then
    printf 'Skills preparation held. Review protected config/skills-proposals on each selected host. Explicitly prepare a missing immutable client as root, configure owning Magnus/native mappings, complete node enrollment, then rerun skills-prepare. No mapping was activated and no job was dispatched.\n' >&2
    return 2
  fi
  printf 'Skills target readiness verified. Protected proposals are ready for explicit owning-backend review; no mapping was activated and no job was dispatched.\n'
}
