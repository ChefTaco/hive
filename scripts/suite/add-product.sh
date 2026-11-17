#!/usr/bin/env bash
# hive.sh add PRODUCT: a product, with the private datastores it owns, joins an existing
# installation on its console host, configured exactly as fresh setup would have configured it.
# The operation is journaled beside the installation file (additions/PRODUCT.json) and every step
# is idempotent, so repeating the command after an interruption continues where it stopped:
#   1. an online backup of the installation, before anything changes;
#   2. on the console host (add-product-host.sh, reusing initialize-full-host.sh): the product's
#      secrets, internal certificate, datastore and product configuration, an explicit
#      issuer/subject link from the operator's existing Oathweave account to a new product account,
#      the console's browser client policy, ingress route and runtime.json entry;
#   3. the installation file gains the components (its previous copy is kept);
#   4. the change is applied as an upgrade to the installed release: stopped pre-change backup,
#      rehearsal on a restored copy, the product's schema migration claimed, applied and verified,
#      activation and the Hive Registry record;
#   5. the console's browser client is created in Oathweave's store with its permissions in
#      SUITE_ADMIN, as console-clients add does.

# What add supports. Each entry names the components it adds (the product first), the components
# it needs already installed, whether the product has a signed schema initialization, its HiveXUI
# browser client as fresh setup declares it (or null), and what the host step prepares.
hive_add_catalog() {
  printf '%s\n' '{"cindertrace":{"name":"Cindertrace","components":["cindertrace","cindertrace-postgres","cindertrace-redis"],"requires":[],"initialization":true,
    "browserClient":{"id":"hivexui-cindertrace","audience":"cindertrace","permissions":["cindertrace:view","cindertrace:investigate","cindertrace:admin"]},
    "prepares":"Cindertrace secrets, internal certificate, private PostgreSQL and Redis configuration and environment, with native browser sign-in for the operator and an Oathweave link from the operator account to a new Cindertrace account; the hivexui-cindertrace browser policy in Oathweave, the Cindertrace routes in the ingress and Cindertrace in the console runtime.json"},
  "cindertrace-collector":{"name":"Cindertrace collector","components":["cindertrace-collector"],"requires":["cindertrace"],"initialization":false,"browserClient":null,
    "prepares":"checks the collector settings that cindertrace-collector add ID --sources ... --run wrote"}}' | jq -c .
}

hive_add_record() { # JOURNAL FILTER [JQ ARGUMENTS...]
  local journal=$1 filter=$2 pending
  shift 2
  pending=$(mktemp "$(dirname -- "$journal")/.journal.XXXXXX")
  if [[ -f "$journal" ]]; then jq "$@" "$filter" "$journal" > "$pending"; else jq -n "$@" "$filter" > "$pending"; fi
  chmod 600 "$pending"; mv -T -- "$pending" "$journal"
}

# The installation file with the product's components placed on the console host, at the paths
# fresh setup uses.
hive_add_candidate() { # ENTRY
  jq --argjson entry "$1" '.console.host as $host | .hosts[$host].directory as $directory |
    reduce $entry.components[] as $name (.; .components[$name]=({host:$host} +
      (if ($name|test("-(postgres|redis|qdrant)$")) then {} else {envFile:($directory+"/config/"+$name+".env")} end) +
      {configDirectory:($directory+"/config/"+$name)}))' "$HIVE_CONFIG"
}

# What the installation and the release must offer before anything is changed.
hive_add_check() { # ENTRY
  local entry=$1 name
  jq -e --argjson entry "$entry" '. as $r | all($entry.components[]; $r.components[.]!=null) and ($entry.initialization==false or $r.components[$entry.components[0]].initialization!=null)' "$HIVE_MANIFEST" >/dev/null ||
    hive_die "Release $HIVE_VERSION does not offer $(jq -r .name <<< "$entry")$(jq -r 'if (.components|length)>1 then " with its datastores" else "" end' <<< "$entry")"
  for name in $(jq -r '.requires[]' <<< "$entry"); do
    jq -e --arg name "$name" '.components[$name]!=null' "$HIVE_CONFIG" >/dev/null || hive_die "$(jq -r .name <<< "$entry") needs $name in this installation: add it first"
  done
  jq -e '.components.oathweave!=null and .components.ingress!=null and .components.hivexui!=null and .components["hive-registry"]!=null and .console!=null and .components.oathweave.host==.console.host' "$HIVE_CONFIG" >/dev/null ||
    hive_die 'add needs Oathweave, HiveXUI, the ingress and the Hive Registry, with Oathweave on the console host'
  jq -e '.bootstrap.productEndpoints==null' "$HIVE_CONFIG" >/dev/null || hive_die 'add does not support a distributed installation yet; see deployment/DISTRIBUTED.md'
  jq -e '.bootstrap!=null or .nativeMigration.adminAccount!=null' "$HIVE_CONFIG" >/dev/null ||
    hive_die 'add links the operator account fresh setup created (bootstrap) or a migration names (nativeMigration.adminAccount); this installation file has neither'
  for name in $(jq -r '.components[]' <<< "$entry"); do
    ! jq -e --arg name "$name" '.components[$name]!=null' "$HIVE_CONFIG" >/dev/null || hive_die "$name is already in this installation"
  done
}

hive_add_product() {
  local product=${1:-} entry name journal phase host directory candidate result archive clients
  (($# == 1)) || hive_die "Use: add PRODUCT [--yes]; PRODUCT is one of: $(hive_add_catalog | jq -r 'keys|join(", ")')"
  entry=$(hive_add_catalog | jq -ce --arg product "$product" '.[$product] // empty') ||
    hive_die "add supports $(hive_add_catalog | jq -r 'keys|join(", ")'). See deployment/FULL.md#adding-a-product-to-an-existing-installation"
  name=$(jq -r .name <<< "$entry")
  # The journal and the rewritten installation file belong to the file the operator named.
  [[ $(realpath -e -- "$HIVE_CONFIG") == "$HIVE_OPERATOR_CONFIG" ]] || hive_die 'add rewrites the installation file, which must name the hive-registry component itself: run upgrade first, add the component to the file, then add'
  [[ "$HIVE_RELAX_AUTH_LIMITS" != true ]] || hive_die '--relax-auth-limits does not apply to add'
  journal="$(dirname -- "$HIVE_OPERATOR_CONFIG")/additions/$product.json"
  phase=none
  if [[ -e "$journal" || -L "$journal" ]]; then
    [[ -f "$journal" && ! -L "$journal" ]] || hive_die "Unsafe journal $journal"
    jq -e --arg id "$HIVE_ID" --arg product "$product" '.schema==1 and .installation==$id and .product==$product' "$journal" >/dev/null || hive_die "$journal belongs to another installation or product"
    phase=$(jq -r .phase "$journal")
    if [[ "$phase" != complete ]]; then
      [[ $(jq -r .release "$journal") == "$HIVE_VERSION" ]] || hive_die "The interrupted add of $name used release $(jq -r .release "$journal"); continue it with --release $(jq -r .release "$journal")"
    fi
  fi
  if [[ "$phase" == complete || "$phase" == none ]]; then
    ! jq -e --arg name "$product" '.components[$name]!=null' "$HIVE_CONFIG" >/dev/null || hive_die "$name is already installed in this installation"
    [[ "$phase" == none ]] || mv -T -- "$journal" "$journal.complete-$(date -u +%Y%m%d%H%M%S)"
    phase=none
    hive_add_check "$entry"
  fi
  host=$(jq -r .console.host "$HIVE_CONFIG")
  directory=$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG")
  if [[ "$phase" == none ]]; then
    printf 'Add %s to installation %s (release %s) on host %s:\n' "$name" "$HIVE_ID" "$HIVE_VERSION" "$host"
  else
    printf 'Continue adding %s to installation %s (release %s) on host %s, after step "%s":\n' "$name" "$HIVE_ID" "$HIVE_VERSION" "$host" "$phase"
  fi
  printf '  1. Online backup of the installation; no service stops\n'
  printf '  2. On %s: %s\n' "$host" "$(jq -r .prepares <<< "$entry")"
  printf '  3. The installation file %s gains %s (its previous copy is kept beside the journal)\n' "$HIVE_OPERATOR_CONFIG" "$(jq -r '.components|join(", ")' <<< "$entry")"
  if jq -e '.initialization' <<< "$entry" >/dev/null; then
    printf '  4. Apply it as an upgrade to release %s: stopped pre-change backup, rehearsal on a restored copy, %s schema migration claimed, applied and verified, then activation. Oathweave, the ingress and HiveXUI restart\n' "$HIVE_VERSION" "$name"
  else
    printf '  4. Apply it as an upgrade to release %s: stopped pre-change backup, rehearsal on a restored copy, then activation, which starts %s\n' "$HIVE_VERSION" "$name"
  fi
  if jq -e '.browserClient!=null' <<< "$entry" >/dev/null; then printf '  5. Create %s in Oathweave with its permissions in SUITE_ADMIN\n' "$(jq -r .browserClient.id <<< "$entry")"; fi
  printf 'Journal: %s\n' "$journal"
  if [[ "${HIVE_CONFIRMED:-false}" != true ]]; then
    [[ "${HIVE_ADD_INTERACTIVE:-true}" == true && -t 0 ]] && hive_confirm "Add $name?" || hive_die 'Cancelled; nothing was changed. Unattended use needs --yes'
  fi
  if [[ "$phase" == none ]]; then
    [[ ! -L "$(dirname -- "$journal")" ]] || hive_die 'Unsafe journal directory'
    install -d -m 700 -- "$(dirname -- "$journal")"
    hive_add_record "$journal" '{schema:1,installation:$id,product:$product,release:$release,phase:"started",startedAt:$now}' \
      --arg id "$HIVE_ID" --arg product "$product" --arg release "$HIVE_VERSION" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    phase=started
  fi
  if [[ "$phase" == started ]]; then
    archive="pre-add-$product-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
    ( HIVE_OPERATION=backup HIVE_ARCHIVE=$archive; hive_lifecycle backup ) || hive_die "The backup before adding $name failed; nothing was changed. Repeat the command to continue"
    hive_add_record "$journal" '.phase="backed-up" | .backup=$archive' --arg archive "$archive"
    phase=backed-up
  fi
  if [[ "$phase" == backed-up ]]; then
    HIVE_ADD_TEMPORARY=$(mktemp)
    hive_add_candidate "$entry" > "$HIVE_ADD_TEMPORARY"
    result=$(
      HIVE_CONFIG=$HIVE_ADD_TEMPORARY
      hive_validate; hive_manifest
      HIVE_BOOTSTRAP_USERS=$(hive_release_selected .service.user)
      HIVE_BOOTSTRAP_IMAGES=$(hive_release_selected .image)
      HIVE_HOST_ACTION=add-product HIVE_ADD_INPUT=$(jq -c --arg product "$product" '{product:$product,components,browserClient}' <<< "$entry") \
        hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/public-runtime.sh" "$HIVE_ROOT/scripts/suite/initialize-full-host.sh" "$HIVE_ROOT/scripts/suite/add-product-host.sh")"
    ) || hive_die "$name could not be configured on $host; the installation is unchanged and serving. Fix the cause and repeat the command to continue"
    result=$(tail -n 1 <<< "$result")
    jq -e '.phase=="complete"' <<< "$result" >/dev/null 2>&1 || hive_die "$host did not confirm the $name configuration"
    hive_add_record "$journal" '.phase="prepared" | .changedFiles=$result.changed | . + ($result|{operator:.username,passwordFile,collector}|with_entries(select(.value!=null)))' --argjson result "$result"
    phase=prepared
  fi
  if [[ "$phase" == prepared ]]; then
    local before pending
    before="$(dirname -- "$journal")/$product.installation-before.json"
    [[ -e "$before" ]] || { cp -- "$HIVE_OPERATOR_CONFIG" "$before"; chmod 600 "$before"; }
    if ! jq -e --arg name "$product" '.components[$name]!=null' "$HIVE_OPERATOR_CONFIG" >/dev/null; then
      HIVE_ADD_TEMPORARY=${HIVE_ADD_TEMPORARY:-$(mktemp)}
      hive_add_candidate "$entry" > "$HIVE_ADD_TEMPORARY"
      pending=$(mktemp "$(dirname -- "$HIVE_OPERATOR_CONFIG")/.installation.XXXXXX")
      cat -- "$HIVE_ADD_TEMPORARY" > "$pending"; chmod 600 "$pending"; mv -T -- "$pending" "$HIVE_OPERATOR_CONFIG"
    fi
    hive_add_record "$journal" '.phase="configured" | .previousConfiguration=$before' --arg before "$before"
    phase=configured
    printf '%s added to %s; the previous file is %s\n' "$(jq -r '.components|join(", ")' <<< "$entry")" "$HIVE_OPERATOR_CONFIG" "$before"
  fi
  if [[ "$phase" == configured ]]; then
    for name in $(jq -r '.components[]' <<< "$entry"); do
      jq -e --arg name "$name" '.components[$name]!=null' "$HIVE_OPERATOR_CONFIG" >/dev/null || hive_die "$name is no longer in $HIVE_OPERATOR_CONFIG; restore it, then repeat the command"
    done
    name=$(jq -r .name <<< "$entry")
    # The same release with the product's components: only the new product has a schema to
    # initialize, so migrations are allowed for this plan. A repeat uses the same plan and
    # recovers its open transaction.
    ( HIVE_CONFIG=$HIVE_OPERATOR_CONFIG HIVE_ALLOW_MIGRATIONS=true HIVE_OPERATION=upgrade HIVE_ARCHIVE=''
      hive_validate; hive_manifest; hive_lifecycle upgrade ) ||
      hive_die "Applying $name stopped; see above. Repeat the same add command to continue: it repeats the same upgrade plan, which recovers an open transaction"
    hive_add_record "$journal" '.phase="applied"'
    phase=applied
  fi
  if [[ "$phase" == applied ]] && jq -e '.browserClient==null' <<< "$entry" >/dev/null; then
    hive_add_record "$journal" '.phase="complete" | .completedAt=$now' --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    phase=complete
  fi
  if [[ "$phase" == applied ]]; then
    clients=$(jq -c --arg redirect "$(jq -r .origin "$HIVE_CONFIG")/auth/callback" '[.browserClient+{redirectUris:[$redirect],firstParty:true}]' <<< "$entry")
    result=$(HIVE_HOST_ACTION=console-clients HIVE_CONSOLE_CLIENTS_INPUT=$clients hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/console-clients-host.sh")") ||
      hive_die "$name runs, but its console client could not be created in Oathweave; see above. Repeat the command to continue"
    jq -e '.existingRecordsUnchanged==true' <<< "$result" >/dev/null || hive_die 'Oathweave did not confirm the console client'
    hive_add_record "$journal" '.phase="complete" | .completedAt=$now' --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  printf '\n%s is installed in %s.\n' "$name" "$HIVE_ID"
  if [[ "$product" == cindertrace-collector ]]; then
    printf '  Collector: %s runs as component cindertrace-collector; its sources report under Cindertrace > Sources\n' "$(jq -r '.collector // "?"' "$journal")"
    printf '  Settings:  edit its sources file, then ./hive.sh cindertrace-collector add ID --sources ... --run applies them\n'
    printf '  Backup:    %s was taken before any change\n' "$(jq -r '.backup // "?"' "$journal")"
    return 0
  fi
  printf '  Console:   sign out of %s/ and in again to see %s\n' "$(jq -r .origin "$HIVE_CONFIG")" "$name"
  printf '  Recovery:  %s'"'"'s own sign-in, for when Oathweave is unavailable: account %s, password in %s on %s (owner-only; never printed)\n' "$name" "$(jq -r '.operator // "?"' "$journal")" "$(jq -r '.passwordFile // "?"' "$journal")" "$host"
  printf '  Backup:    %s was taken before any change\n' "$(jq -r '.backup // "?"' "$journal")"
  printf '  Events:    ./hive.sh cindertrace-collector add ID --sources SOURCE[,SOURCE] --config %s (deployment/FULL.md#sending-security-events-to-cindertrace)\n' "$HIVE_OPERATOR_CONFIG"
}
