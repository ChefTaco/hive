#!/usr/bin/env bash
# Controller side of the Hive Registry (the install catalog; HiveSkills is the separate
# skills registry). jq and SSH only: no Node on the controller.

hive_registry_missing_message='The Hive Registry is mandatory: add a hive-registry component to the installation configuration, on the same host as the console, with its standard envFile and configDirectory. Run upgrade or adopt on an existing installation to add it automatically.'

hive_registry_placed() { jq -e '.components["hive-registry"]!=null' "$HIVE_CONFIG" >/dev/null; }
hive_registry_host() { jq -r '.components["hive-registry"].host' "$HIVE_CONFIG"; }

# Installation JSON with the registry placed on the console host, or the first host of a
# configuration without a console. The operator's file is never rewritten.
hive_registry_add_to_configuration() {
  HIVE_REGISTRY_ORIGINAL_CONFIG=$HIVE_CONFIG
  HIVE_REGISTRY_TEMPORARY=$(mktemp)
  jq '(.console.host // (.hosts|keys[0])) as $host | .hosts[$host].directory as $directory | .components["hive-registry"]={host:$host,envFile:($directory+"/config/hive-registry.env"),configDirectory:($directory+"/config/hive-registry")}' "$HIVE_CONFIG" > "$HIVE_REGISTRY_TEMPORARY"
  HIVE_CONFIG=$HIVE_REGISTRY_TEMPORARY
  printf 'NOTICE: this configuration has no hive-registry component; using one on host %s. Add it to the file to make this explicit.\n' "$(hive_registry_host)" >&2
}

hive_registry_configuration() {
  local command=$1
  [[ -f "$HIVE_CONFIG" && ! -L "$HIVE_CONFIG" ]] || hive_die 'Configuration must be a regular file'
  jq -e . "$HIVE_CONFIG" >/dev/null 2>&1 || hive_die 'Invalid installation configuration'
  hive_registry_placed && return 0
  # Commands that create an installation refuse. On an existing one, the placement is
  # derived; status and doctor then report whether the registry really runs there.
  case "$command" in
    init|install|plan) hive_die "$hive_registry_missing_message";;
    *) hive_registry_add_to_configuration;;
  esac
}

hive_registry_validate() {
  hive_registry_placed || return 0
  jq -e '
    . as $c | .components["hive-registry"] as $placement | $c.hosts[$placement.host].directory as $directory |
    (if $c.console then $placement.host==$c.console.host else true end) and
    $placement.envFile==($directory+"/config/hive-registry.env") and
    $placement.configDirectory==($directory+"/config/hive-registry")
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'The Hive Registry must run on the same host as the console, with envFile config/hive-registry.env and configDirectory config/hive-registry in that host directory'
}

# Runs after the signature check. Only a rollback, or an operation that deploys nothing,
# may use a release from before the registry existed.
hive_registry_release() {
  if ! jq -e '.components["hive-registry"]!=null' "$HIVE_MANIFEST" >/dev/null; then
    case "${HIVE_OPERATION:-}" in
      rollback|status|backup|restore|rehearse|agents-accept|skills-prepare) ;;
      *) hive_die 'This release has no Hive Registry. The registry is mandatory: use a release whose signed manifest includes hive-registry.';;
    esac
    if [[ -n "${HIVE_REGISTRY_ORIGINAL_CONFIG:-}" ]]; then HIVE_CONFIG=$HIVE_REGISTRY_ORIGINAL_CONFIG
    elif hive_registry_placed; then
      HIVE_REGISTRY_TEMPORARY=$(mktemp)
      jq 'del(.components["hive-registry"])' "$HIVE_CONFIG" > "$HIVE_REGISTRY_TEMPORARY"
      HIVE_CONFIG=$HIVE_REGISTRY_TEMPORARY
    fi
    return 0
  fi
  jq -e '
    (.components["hive-registry"].kind // "application")=="application" and
    (.components["hive-registry"].storageFormat|type=="string") and
    ((.profiles.core|index("hive-registry"))!=null) and ((.profiles.full|index("hive-registry"))!=null)
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'The Hive Registry is mandatory in every release profile: the signed manifest must list hive-registry as an application with a storage format in the core and full profiles'
  jq -e '
    def url: type=="string" and test("^https://[^ ?#@]+$");
    def nullable_url: .==null or url;
    def local_path: .==null or (type=="string" and test("^/[A-Za-z0-9._~/-]*$"));
    def map_of(check): type=="object" and all(to_entries[]; (.key|test("^[a-z][a-z0-9-]{0,47}$")) and (.value|check));
    all(.components|to_entries[]; .value.catalog as $meta |
      ($meta|type=="object" and (keys-["displayName","description","repository","documentation","license","licenseSpdx","consoleSection","required","dependencies","connection"]|length==0)) and
      ($meta.displayName|type=="string" and length>0 and length<=120) and ($meta.description|type=="string" and length<=500) and
      ($meta.repository|nullable_url) and ($meta.documentation|nullable_url) and ($meta.license|nullable_url) and
      ($meta.required|type=="boolean") and ($meta.dependencies|type=="array" and all(.[];type=="string")) and
      ($meta.connection|type=="object" and (keys-["browserPrefix","consolePath","nativeApis","internalEndpoints"]|length==0)) and
      ($meta.connection.browserPrefix|local_path) and ($meta.connection.consolePath|local_path) and
      ($meta.connection.nativeApis|map_of(type=="string" and startswith("/"))) and
      ($meta.connection.internalEndpoints|map_of(type=="string" and test("^https?://[A-Za-z0-9.-]+:[0-9]+$"))))
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'Every component in a release with the Hive Registry needs valid catalog metadata in the signed manifest; generate it from scripts/suite/suite-catalog.json'
  # The registry starts first and records the rest; nothing it records may be required by it.
  jq -e '((.components["hive-registry"].requiresLocal // [])|length)==0' "$HIVE_MANIFEST" >/dev/null || hive_die 'The Hive Registry must not depend on the products it records'
}

hive_registry_action() {
  local host=$1 action=$2 input=${3:-null}
  HIVE_HOST_ACTION=$action HIVE_REGISTRY_INPUT=$input hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/registry-host.sh")"
}

# Creates the protected credentials and environment, once. Stable across retries.
hive_registry_provision() {
  hive_registry_placed || return 0
  local host user
  host=$(hive_registry_host)
  user=$(jq -er '.components["hive-registry"].service.user' "$HIVE_MANIFEST")
  HIVE_BOOTSTRAP_INGRESS=${HIVE_BOOTSTRAP_INGRESS:-$(base64 -w0 "$HIVE_ROOT/deployment/Caddyfile")}
  hive_registry_action "$host" registry-provision "$(jq -nc --arg user "$user" '{serviceUser:$user}')" || hive_die 'Hive Registry credentials and configuration could not be prepared; no service was changed'
}

# A release that adds the registry brings its ingress route: this step replaces a
# Caddyfile that lacks it and retains the previous file beside it.
hive_registry_refresh_ingress() {
  hive_registry_placed || return 0
  HIVE_BOOTSTRAP_INGRESS=${HIVE_BOOTSTRAP_INGRESS:-$(base64 -w0 "$HIVE_ROOT/deployment/Caddyfile")}
  hive_registry_action "$(hive_registry_host)" registry-refresh-ingress || hive_die 'The ingress route for the Hive Registry could not be installed; no service was changed'
}

# What the signed release and this configuration say should be recorded. $1 is the
# status every entry carries. Same-origin paths become URLs on the installation origin.
hive_registry_body() {
  local phase=$1 status=$2
  jq -n --slurpfile config "$HIVE_CONFIG" --slurpfile release "$HIVE_MANIFEST" --arg phase "$phase" --arg status "$status" --arg operation "${HIVE_OPERATION:-install}" \
    --arg version "$HIVE_VERSION" --arg digest "$HIVE_MANIFEST_DIGEST" --arg plan "$HIVE_PLAN_DIGEST" '
    $config[0] as $c | $release[0] as $r |
    def identity: split("@")[1];
    def product_version($name): $r.components[$name].version // $r.version;
    {schema:1,phase:$phase,operation:$operation,actor:"hive.sh",
     installation:{id:$c.installation,origin:$c.origin,profile:$c.profile},
     release:{version:$version,manifestDigest:$digest,planDigest:$plan},
     catalog:($r.components|to_entries|map(.key as $name|.value as $component|$component.catalog as $meta|{
       id:$name,kind:($component.kind // "application"),displayName:$meta.displayName,description:$meta.description,
       links:{repository:$meta.repository,documentation:$meta.documentation,license:$meta.license,licenseSpdx:$meta.licenseSpdx},
       consoleSection:$meta.consoleSection,required:$meta.required,
       dependencies:((($meta.dependencies // [])+($component.requiresLocal // []))|unique),
       version:{version:product_version($name),image:$component.image,imageDigest:($component.image|identity),storageFormat:($component.storageFormat // null)}})),
     installed:($c.components|to_entries|map(.key as $name|.value as $placement|$r.components[$name] as $component|$component.catalog.connection as $connection|($c.bootstrap.productEndpoints[$name] // {}) as $endpoint|{
       id:$name,inventoryHost:$placement.host,version:product_version($name),image:$component.image,imageDigest:($component.image|identity),status:$status,
       connection:{consolePath:$connection.consolePath,browserPrefix:$connection.browserPrefix,
         nativeApis:($connection.nativeApis|map_values($c.origin+.)),
         internalEndpoints:($connection.internalEndpoints|with_entries(if .key=="model" and $endpoint.inferenceOrigin then .value=$endpoint.inferenceOrigin elif $endpoint.origin and (.key=="api" or .key=="admin") then .value=$endpoint.origin else . end))}}))}'
}

hive_registry_write() {
  local method=$1 path=$2 body=$3 host
  host=$(hive_registry_host)
  hive_registry_action "$host" registry-write "$(jq -nc --arg method "$method" --arg path "$path" --argjson body "$body" '{method:$method,path:$path,body:$body}')"
}

# Starts the registry and records the plan as activating. A failure holds the operation:
# products do not start without the mandatory registry able to record them.
hive_registry_begin() {
  hive_registry_placed || return 0
  local host user
  host=$(hive_registry_host)
  user=$(jq -er '.components["hive-registry"].service.user' "$HIVE_MANIFEST")
  hive_registry_action "$host" registry-start "$(jq -nc --arg user "$user" '{serviceUser:$user}')" || return 1
  hive_registry_write POST /v1/sync "$(hive_registry_body begin activating)" >/dev/null
}

hive_registry_observed() {
  local host
  while IFS= read -r host; do hive_registry_action "$host" registry-observe null || jq -n --arg host "$host" '{host:$host,active:false,unreachable:true,services:[]}'; done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG") | jq -s .
}

# Records installed only for what is observed running the exact signed image. Any other
# outcome leaves the transaction incomplete, and the command fails, so a successful-looking
# install can never carry a wrong catalog. Services keep running; rerun to finish.
hive_registry_complete() {
  hive_registry_placed || return 0
  local observed mismatch body
  observed=$(hive_registry_observed)
  body=$(hive_registry_body complete installed)
  mismatch=$(jq -n --argjson observed "$observed" --argjson body "$body" '
    ($observed|map(.host as $host|.services[]|{key:(.service+"@"+$host),value:.})|from_entries) as $actual |
    [$body.installed[]|. as $entry|$actual[$entry.id+"@"+$entry.inventoryHost] as $service|
      select(($service|not) or $service.state!="running" or ($service.health|IN("","healthy")|not) or $service.imageMatches!=true or $service.image!=$entry.image)|$entry.id]') || return 1
  if [[ "$mismatch" != '[]' ]]; then
    printf 'Hive Registry: these products do not match the signed release on their hosts: %s\n' "$(jq -r 'join(", ")' <<< "$mismatch")" >&2
    return 1
  fi
  hive_registry_write POST /v1/sync "$body" >/dev/null
}

hive_registry_failed() {
  hive_die "The Hive Registry could not record this ${1:-operation}, so it is not complete. Services keep running and the transaction stays open; status and doctor report the drift. Fix the cause and repeat the same command: registry writes are idempotent."
}

# Compares the registry to what the hosts actually run. Prints one JSON object.
hive_registry_report() {
  local observed host summary='null' list='null'
  observed=$(hive_registry_observed)
  host=$(hive_registry_host)
  if jq -e 'any(.[];.active) and (any(.[].services[];.service=="hive-registry")|not)' <<< "$observed" >/dev/null; then
    jq -n '{state:"missing",drift:[{code:"not-installed",detail:"This installation has no Hive Registry; upgrade or adopt adds it"}]}'
    return
  fi
  if jq -e 'any(.[];.active)' <<< "$observed" >/dev/null; then
    summary=$(hive_registry_action "$host" registry-read '{"path":"/v1/installation"}' 2>/dev/null) || summary=null
    list=$(hive_registry_action "$host" registry-read '{"path":"/v1/products"}' 2>/dev/null) || list=null
    jq -e . <<< "$summary" >/dev/null 2>&1 || summary=null
    jq -e . <<< "$list" >/dev/null 2>&1 || list=null
  fi
  jq -n --argjson observed "$observed" --argjson summary "$summary" --argjson list "$list" '
    def drift($code;$detail): {code:$code,detail:$detail};
    ($observed|map(select(.active))) as $active |
    ($observed|map(.host as $host|.services[]|.+{host:$host})) as $actual |
    (($list.products? // [])|map(select(.installation!=null))) as $recorded |
    ($recorded|map(select(.source=="release"))) as $managed |
    ($list.products? // []) as $catalog |
    if ($active|length)==0 then {state:(if any($observed[];.unreachable) then "unavailable" else "not-active" end),drift:[]}
    elif $summary==null or $list==null or ($summary|type!="object") or ($list|type!="object") then {state:"unavailable",drift:[drift("registry-unavailable";"The registry did not answer on its host")]}
    else
      ([$active[]|select(.transactionPhase!=null and .transactionPhase!="complete")|drift("incomplete-transaction";.host+" is in phase "+.transactionPhase)] +
       [$active[].receipt|select(.version!=$summary.release.version or .digest!=$summary.release.manifestDigest)|drift("release-mismatch";"Registry records "+($summary.release.version // "no release")+"; a host runs "+.version)] +
       [$managed[]|select(.installation.status!="installed")|drift("not-installed";.id+" is recorded as "+.installation.status)] +
       ($actual|map(. as $service|select(($managed|any(.id==$service.service and .installation.inventoryHost==$service.host))|not)|drift("unrecorded";$service.service+" runs on "+$service.host+" but is not recorded"))) +
       ($managed|map(. as $entry|select(($actual|any(.service==$entry.id and .host==$entry.installation.inventoryHost))|not)|drift("not-deployed";$entry.id+" is recorded on "+$entry.installation.inventoryHost+" but is not in its deployment"))) +
       ($actual|map(. as $service|($managed|map(select(.id==$service.service))|first) as $entry|select($entry)|
          (if $service.state!="running" then [drift("not-running";$service.service+" on "+$service.host+" is "+$service.state)] else [] end) +
          (if ($service.health|IN("","healthy")|not) then [drift("unhealthy";$service.service+" on "+$service.host+" is "+$service.health)] else [] end) +
          (if $service.state!="missing" and $service.imageMatches!=true then [drift("image-mismatch";$service.service+" on "+$service.host+" does not run its deployed image")] else [] end) +
          (if ($service.image|split("@")[1])!=$entry.installation.imageDigest then [drift("digest-mismatch";$service.service+" is recorded with a different image digest")] else [] end))|add // []) +
       [$active[]|select(.catalog!=null)|.catalog[]|. as $signed|($catalog|map(select(.id==$signed.id))|first) as $entry|
          select(($entry|not) or ($entry.offered!=true) or (($entry.versions|any(.image==$signed.image and .storageFormat==$signed.storageFormat))|not))|drift("catalog-mismatch";$signed.id+" differs from the signed release catalog")]) as $drift |
      {state:(if ($drift|length)==0 then "in-sync" else "drift" end),release:$summary.release.version,products:($recorded|length),externallyManaged:($recorded|map(select(.source=="external")|.id)),drift:($drift|unique)}
    end'
}

# Host preflight of the configuration as written, for operations that do not add the
# registry. An installation from before it has no credentials to check yet.
hive_registry_preflight() {
  if [[ -n "${HIVE_REGISTRY_ORIGINAL_CONFIG:-}" ]]; then
    local effective=$HIVE_CONFIG
    HIVE_CONFIG=$HIVE_REGISTRY_ORIGINAL_CONFIG; hive_doctor; HIVE_CONFIG=$effective
  else hive_doctor; fi
}

hive_registry_doctor() {
  local report state
  report=$(hive_registry_report)
  state=$(jq -r .state <<< "$report")
  case "$state" in
    in-sync) printf 'Hive Registry: in sync with this installation (%s products)\n' "$(jq -r .products <<< "$report")";;
    not-active)
      [[ -z "${HIVE_REGISTRY_ORIGINAL_CONFIG:-}" ]] || hive_die "$hive_registry_missing_message"
      printf 'Hive Registry: not active yet; nothing is installed on these hosts\n';;
    *)
      printf 'Hive Registry: %s\n' "$state" >&2
      jq -r '.drift[]|"  "+.code+": "+.detail' <<< "$report" >&2
      hive_die 'The registry does not match this installation. Repeat the last lifecycle command to reconcile it; registry writes are idempotent.';;
  esac
}

# hive.sh registry list|get ID|connection ID|summary|history|add ID --file ENTRY.json|remove ID
hive_registry_command() {
  local subcommand=${1:-} id=${2:-} path host body level
  hive_registry_placed || hive_die "$hive_registry_missing_message"
  host=$(hive_registry_host)
  if [[ -n "$id" ]]; then [[ "$id" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || hive_die 'Registry product IDs use lowercase letters, digits and hyphens'; fi
  level=read
  case "$subcommand" in
    list) path=/v1/products;;
    installed) path='/v1/products?installed=true';;
    summary) path=/v1/installation;;
    history) path=/v1/history;;
    get) [[ -n "$id" ]] || hive_die 'registry get needs a product ID'; path=/v1/products/$id;;
    connection) [[ -n "$id" ]] || hive_die 'registry connection needs a product ID'; path=/v1/products/$id/connection;;
    add|update)
      [[ -n "$id" ]] || hive_die "registry $subcommand needs a product ID"
      [[ -n "$HIVE_REGISTRY_FILE" && -f "$HIVE_REGISTRY_FILE" && ! -L "$HIVE_REGISTRY_FILE" ]] || hive_die "registry $subcommand needs --file ENTRY.json; entries never contain credentials"
      [[ $(stat -c %s "$HIVE_REGISTRY_FILE") -le 65536 ]] || hive_die 'Registry entry file is too large'
      body=$(jq -ce 'select(type=="object")' "$HIVE_REGISTRY_FILE") || hive_die 'Registry entry file must contain a JSON object'
      hive_registry_write PUT "/v1/products/$id" "$body" || hive_die 'The registry refused this entry'
      return;;
    remove)
      [[ -n "$id" ]] || hive_die 'registry remove needs a product ID'
      hive_registry_write DELETE "/v1/products/$id" null || hive_die 'The registry refused this removal'
      return;;
    *) hive_die 'Use: registry list|installed|summary|history|get ID|connection ID|add ID --file F|update ID --file F|remove ID';;
  esac
  hive_registry_action "$host" registry-read "$(jq -nc --arg path "$path" --arg level "$level" '{path:$path,level:$level}')" || hive_die 'The registry did not answer; check hive.sh status'
}
