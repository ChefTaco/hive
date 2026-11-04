#!/usr/bin/env bash

adapter_register_inference() {
  local item id endpoint credential ca slug model kind journal temporary registration_sha response provider_id alias alias_id existing api_prefix
  while IFS= read -r item; do
    [[ $(jq -r '.registration!=null' <<< "$item") == true ]] || continue
    id=$(jq -er .id <<< "$item"); temporary="$directory/inference-checks/$id"
    jq -e '.discovery==true and .generation==true and .streaming==true' "$temporary/receipt.json" >/dev/null || die 'Model acceptance must precede provider registration'
    endpoint=$(jq -er .registration.endpoint <<< "$item"); credential=$(jq -er .registration.credentialFile <<< "$item"); ca=$(jq -r '.registration.caFile // empty' <<< "$item")
    api_prefix=$(jq -r '.registration.apiPrefix // "/api"' <<< "$item")
    [[ "$api_prefix" =~ ^/api(/[a-z][a-z0-9-]*)?$ ]] || die 'Invalid Emberpath API prefix'
    endpoint="${endpoint%/}$api_prefix"
    slug=$(jq -er .registration.providerSlug <<< "$item"); model=$(jq -er .model.id <<< "$item")
    local spec protocol; spec=$(jq -Sc '{engine,protocol:(.protocol // "openai"),endpoint,model}' <<< "$item" | sha256sum | cut -d ' ' -f1)
    [[ $(jq -er .specSHA256 "$temporary/receipt.json") == "$spec" ]] || die 'External endpoint verification receipt does not match this provider'
    protocol=$(jq -r '.protocol // "openai"' <<< "$item")
    case $(jq -er .engine <<< "$item") in llamacpp) kind=LLAMACPP;; ollama) if [[ "$protocol" == ollama ]]; then kind=OLLAMA; else kind=OPENAI; fi;; openai) kind=OPENAI;; esac
    [[ -f "$credential" && ! -L "$credential" && $(stat -c %s "$credential") -le 16384 ]] || die 'A protected product-scoped enrollment credential is required'
    local permissions contents; permissions=$(stat -c %a "$credential"); (( (8#$permissions & 077)==0 )) || die 'Product enrollment credentials must be owner-only'
    contents=$(cat -- "$credential")
    [[ "$contents" =~ ^Authorization:\ Bearer\ [A-Za-z0-9._~-]+$ || "$contents" =~ ^Cookie:\ hive_router_admin=[A-Za-z0-9._~-]+$ ]] || die 'Expected one native product session or scoped resource authorization header'
    local -a options=(--header "@$credential")
    [[ -z "$ca" ]] || options+=(--cacert "$ca")
    journal="$temporary/registration.json"
    registration_sha=$(jq -Sc '{endpoint,engine,model,registration:(.registration|del(.credentialFile))}' <<< "$item" | sha256sum | cut -d ' ' -f1)
    if [[ -f "$journal" ]]; then
      [[ $(jq -er .specSHA256 "$journal") == "$registration_sha" ]] || die 'Provider enrollment parameters changed; reconcile the previous receipt explicitly'
      [[ $(jq -er .phase "$journal") != create-started && $(jq -er .phase "$journal") != alias-started ]] || die 'Provider enrollment outcome is unknown; inspect the product audit and reconcile before retrying'
    fi
    adapter_curl "${options[@]}" --output "$temporary/providers.json" "$endpoint/providers"
    existing=$(jq -c --arg slug "$slug" '[.data[]|select(.slug==$slug)]' "$temporary/providers.json")
    if [[ $(jq length <<< "$existing") == 1 ]]; then
      provider_id=$(jq -er '.[0].id' <<< "$existing")
      jq -e --arg url "$(jq -er .endpoint <<< "$item")" --arg kind "$kind" '.[0]|.baseUrl==$url and .kind==$kind' <<< "$existing" >/dev/null || die 'Existing provider points to different infrastructure'
      if [[ -f "$journal" ]]; then [[ $(jq -er .providerId "$journal") == "$provider_id" ]] || die 'Existing provider identity differs';
      else [[ $(jq -r '.registration.existingProviderId // empty' <<< "$item") == "$provider_id" ]] || die 'Adopting an existing provider requires its explicitly reviewed product ID'; fi
    elif [[ $(jq length <<< "$existing") == 0 ]]; then
      [[ ! -f "$journal" ]] || die 'A previously registered provider disappeared; never recreate its identity silently'
      jq -n --arg slug "$slug" --arg kind "$kind" --arg url "$(jq -er .endpoint <<< "$item")" --arg model "$model" '{slug:$slug,name:$slug,kind:$kind,baseUrl:$url,authMode:"NONE",enabled:true,models:[{model:$model,enabled:true,capabilityJson:{streaming:true}}]}' > "$temporary/provider-request.json"
      local model_header; model_header=$(jq -r '.authHeaderFile // empty' <<< "$item")
      if [[ -n "$model_header" ]]; then
        jq --rawfile header "$model_header" '.authMode="BEARER"|.authSecret=($header|sub("^Authorization: Bearer ";"")|rtrimstr("\n"))' "$temporary/provider-request.json" > "$temporary/provider-auth-request.json"
        mv -T "$temporary/provider-auth-request.json" "$temporary/provider-request.json"
      fi
      jq -n --arg sha "$registration_sha" '{schema:1,specSHA256:$sha,phase:"create-started"}' | atomic_json "$journal"
      adapter_curl "${options[@]}" --header 'Content-Type: application/json' --data-binary "@$temporary/provider-request.json" --output "$temporary/provider-response.json" "$endpoint/providers"
      provider_id=$(jq -er '.data.id' "$temporary/provider-response.json")
      rm -- "$temporary/provider-request.json"
    else die 'Provider inventory has an ambiguous identity'; fi
    [[ "$provider_id" =~ ^[A-Za-z0-9_-]+$ ]] || die 'Invalid product provider ID'
    jq -n --arg sha "$registration_sha" --arg id "$provider_id" '{schema:1,specSHA256:$sha,phase:"provider-ready",providerId:$id}' | atomic_json "$journal"
    adapter_curl "${options[@]}" --output "$temporary/aliases.json" "$endpoint/model-aliases"
    while IFS= read -r alias; do
      existing=$(jq -c --arg alias "$alias" '[.data[]|select(.alias==$alias)]' "$temporary/aliases.json")
      if [[ $(jq length <<< "$existing") == 1 ]]; then
        jq -e --arg id "$provider_id" --arg model "$model" '.[0]|.providerId==$id and .upstreamModel==$model' <<< "$existing" >/dev/null || die 'An existing model alias has a different owner or model'
      elif [[ $(jq length <<< "$existing") == 0 ]]; then
        jq --arg alias "$alias" '.phase="alias-started"|.pendingAlias=$alias' "$journal" | atomic_json "$journal"
        jq -n --arg alias "$alias" --arg id "$provider_id" --arg model "$model" '{alias:$alias,providerId:$id,upstreamModel:$model,enabled:true}' > "$temporary/alias-request.json"
        adapter_curl "${options[@]}" --header 'Content-Type: application/json' --data-binary "@$temporary/alias-request.json" --output "$temporary/alias-response.json" "$endpoint/model-aliases"
        jq '.phase="provider-ready"|del(.pendingAlias)' "$journal" | atomic_json "$journal"
      else die 'Alias inventory is ambiguous'; fi
    done < <(jq -r '(.registration.aliases // [])[]' <<< "$item")
    jq '.phase="complete"' "$journal" | atomic_json "$journal"
  done < <(jq -c '.inference[]' <<< "$input")
}
