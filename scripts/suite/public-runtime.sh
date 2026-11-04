#!/usr/bin/env bash
# Public browser configuration has a strict allowlist; secret references live in
# protected backend files and never belong in this artifact.
hive_check_public_runtime() {
  local path=$1
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || return 1
  jq -e '

        .schema==1 and (.mode // "suite")=="suite" and
        (keys-["schema","mode","products","identity","links"]|length==0) and
        (.products|type=="object" and has("oathweave") and
          (keys-["emberpath","oathweave","hivemem","hiveskills","cindertrace","chattermost"]|length==0) and
          all(to_entries[];.value==("/api/"+.key))) and
        (.identity|type=="object" and (keys-["issuer","apiPrefix","clients"]|length==0) and
          .apiPrefix=="/api/oathweave" and (.issuer|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[-A-Za-z0-9._~]+)*$")) and
          (.clients|type=="object" and all(.[];type=="string" and test("^hivexui-[a-z0-9-]+$")))) and
        (. as $r|all(.products|keys[];. as $name|$r.identity.clients[$name]!=null)) and
        ((.links // {})|type=="object" and (keys-["magnus"]|length==0) and all(.[];type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[-A-Za-z0-9._~]+)*$")))
  ' "$path" >/dev/null
}
