#!/usr/bin/env bash

# Suite audit collection: Cindertrace's collector pulls the HiveAuditRecord v1 export of HiveMem,
# HiveSkills, Ardent Project Studio and Embermend with short-lived Oathweave client_credentials
# tokens. On install and upgrade this declares, for each product it can reach, one Oathweave
# machine client (an Oathweave client has one audience), the product setting that accepts that
# client, and Cindertrace's collector settings. Every step is idempotent; a secret is generated
# once on the host that runs Oathweave and Cindertrace, is never rotated here and never leaves it.

# The first release of each product that serves its audit export, and of Cindertrace that collects
# it. null means not released yet: nothing is configured for that product, and nothing at all
# without Cindertrace. Set each version in the suite release that first pins it, as for a
# capability's `since` in scripts/suite/suite-catalog.json.
hive_audit_collection_releases() {
  printf '%s\n' '{"cindertrace":null,"hivemem":null,"hiveskills":null,"ardentstudio":null,"embermend":null}'
}

# Where each product serves the export, below its internal endpoint.
hive_audit_collection_paths() {
  printf '%s\n' '{"hivemem":"/v1/audit/export","hiveskills":"/v1/audit/export","ardentstudio":"/api/ardentstudio/v1/audit/export","embermend":"/api/v1/audit/export"}'
}

hive_audit_collection_action() {
  local host=$1 action=$2 input=$3
  HIVE_HOST_ACTION=$action HIVE_AUDIT_COLLECTION_INPUT=$input hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/audit-collection-host.sh")"
}

# What this configuration and the signed release allow: the sources Cindertrace can collect, and
# a note for each product left out. A product is reached on its distributed HTTPS endpoint or,
# on Cindertrace's host, on the internal endpoint the release catalog names.
hive_audit_collection_plan() {
  jq -n --slurpfile config "$HIVE_CONFIG" --slurpfile release "$HIVE_MANIFEST" \
    --argjson since "$(hive_audit_collection_releases)" --argjson paths "$(hive_audit_collection_paths)" '
    $config[0] as $c | $release[0] as $r |
    def version($name): $r.components[$name].version // $r.version;
    def numbers: split(".")|map(tonumber);
    def released($name): $since[$name] as $first | version($name) as $pinned |
      $first!=null and ($pinned|type=="string" and test("^[0-9]+(\\.[0-9]+)*$")) and (($pinned|numbers) >= ($first|numbers));
    def endpoint($name): $c.bootstrap.productEndpoints[$name].origin // $r.components[$name].catalog.connection.internalEndpoints.api // null;
    if $c.components.cindertrace==null or $c.components.oathweave==null or (released("cindertrace")|not) then {sources:[],notes:[]}
    else
      [$paths|keys[]|select($c.components[.]!=null and released(.))] as $products |
      if ($products|length)==0 then {sources:[],notes:[]}
      elif $c.components.cindertrace.host!=$c.components.oathweave.host then
        {sources:[],notes:["Cindertrace and Oathweave run on different hosts, so suite audit collection is not configured. See deployment/FULL.md#suite-audit-collection."]}
      else
        $c.components.cindertrace.host as $collector |
        [$products[] as $name | endpoint($name) as $origin |
          {product:$name,host:$c.components[$name].host,clientId:("cindertrace-audit-"+$name),audience:$name,
           url:(if $origin then $origin+$paths[$name] else null end),
           reachable:($c.components[$name].host==$collector or $c.bootstrap.productEndpoints[$name]!=null)}] as $candidates |
        {identityHost:$c.components.oathweave.host,
         tokenOrigin:endpoint("oathweave"),apiUrl:endpoint("cindertrace"),
         sources:[$candidates[]|select(.url!=null and (.url|startswith("https://")) and .reachable)|del(.reachable)],
         notes:[$candidates[]|
           if .url==null then "\(.product) names no internal endpoint in this release, so Cindertrace does not collect its audit export."
           elif (.url|startswith("https://")|not) then "\(.product) serves plain HTTP inside the installation and the Cindertrace collector reads only HTTPS exports, so its audit export is not collected. See deployment/FULL.md#suite-audit-collection."
           elif .reachable|not then "\(.product) runs on another host without an HTTPS endpoint, so Cindertrace does not collect its audit export."
           else empty end]}
        | if .tokenOrigin==null or .apiUrl==null then {sources:[],notes:["The release names no internal Oathweave or Cindertrace endpoint, so suite audit collection is not configured."]} else . end
      end
    end'
}

hive_audit_collection_provision() {
  local plan identity_host result issuer source note
  plan=$(hive_audit_collection_plan) || hive_die 'The suite audit collection plan could not be read'
  while IFS= read -r note; do printf 'Note: %s\n' "$note" >&2; done < <(jq -r '.notes[]' <<< "$plan")
  [[ $(jq '.sources|length' <<< "$plan") != 0 ]] || return 0
  identity_host=$(jq -r .identityHost <<< "$plan")
  result=$(hive_audit_collection_action "$identity_host" audit-collection-identity "$(jq -c '{products:[.sources[].product]}' <<< "$plan")") ||
    hive_die 'The Cindertrace audit clients could not be prepared; no service was changed'
  issuer=$(jq -er .issuer <<< "$result") || hive_die 'The Cindertrace audit clients have no issuer'
  while IFS= read -r source; do
    hive_audit_collection_action "$(jq -r .host <<< "$source")" audit-collection-accept \
      "$(jq -c --arg issuer "$issuer" --arg installation "$HIVE_ID" '{product,issuer:$issuer,installation:$installation}' <<< "$source")" >/dev/null ||
      hive_die "$(jq -r .product <<< "$source") could not be set to accept the Cindertrace audit client; no service was changed"
  done < <(jq -c '.sources[]' <<< "$plan")
  hive_audit_collection_action "$identity_host" audit-collection-collector "$(jq -c '{sources:[.sources[]|{source:.product,url}],tokenOrigin,apiUrl}' <<< "$plan")" >/dev/null ||
    hive_die 'Cindertrace could not be configured to collect the suite audit exports; no service was changed'
  printf 'Suite audit collection is configured for %s. The suite does not run the Cindertrace collector itself; see deployment/FULL.md#suite-audit-collection.\n' "$(jq -r '[.sources[].product]|join(", ")' <<< "$plan")" >&2
}
