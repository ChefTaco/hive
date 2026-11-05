#!/usr/bin/env bash

# Reject the obsolete draft before planning, downloads, SSH or Docker access.
hive_external_inference_config() {
  jq -e '
    def obsolete: [..|objects|keys[]|select(IN("managed","backend","devices","gpu","hardware","certification","contextSize","limits","downloadBytes","license","quantization","registry","namespace","tag","revision","sha256","url","storage","storageDirectory","modelDirectory"))]|length>0;
    (.inference|any(.[]; obsolete)) or
    ([.components|keys[]]|any(.[]; test("^(inference-|ollama$|llamacpp$|llama-cpp$|vllm$)"))) or
    has("inferenceProfiles") or has("managedInference") or has("modelStorage")
  ' "$HIVE_CONFIG" >/dev/null && hive_die 'Obsolete managed-inference configuration: Hive only verifies external HTTPS endpoints. Remove managed/backend, model download/storage/license, device and hardware settings; use endpoint, model.id and protected credential references. Keep existing model files, volumes, containers and services under their current external owner; Hive will not change them.'
  return 0
}

hive_adapter_validate() {
  hive_external_inference_config
  jq -e '
    def id: type=="string" and test("^[a-z][a-z0-9-]{0,47}$");
    def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
    def https: type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._:/@-]+)?$") and (split("/")|all(.!=".."));
    . as $c |
    all(.agents[]; (.id|id) and ($c.hosts[.host]!=null) and (.runtime|IN("magnus","ardent","hermes","codex")) and
      (.version|type=="string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and (.profileDirectory|path) and (.environmentFile|path) and
      (.service|IN("user","none")) and (.authorized|type=="boolean")) and
    ([.agents[].id]|length==(unique|length)) and
    all(.inference[]; (keys-["id","host","engine","protocol","endpoint","model","caFile","authHeaderFile","registration"]|length==0) and
      (.id|id) and ($c.hosts[.host]!=null) and (.engine|IN("llamacpp","ollama","openai")) and
      ((.protocol // "openai")|IN("openai","ollama")) and (if .protocol=="ollama" then .engine=="ollama" else true end) and (.endpoint|https) and
      (.model|type=="object" and keys==["id"]) and (.model.id|type=="string" and length>0 and length<=256) and
      (if .registration then (.registration|keys-["endpoint","apiPrefix","credentialFile","providerSlug","aliases","existingProviderId","caFile"]|length==0) and
        (.registration.endpoint|https) and (.registration.credentialFile|path) and
        ((.registration.apiPrefix // "/api")|type=="string" and test("^/api(/[a-z][a-z0-9-]*)?$")) and
        ((.registration.caFile // "/dev/null")|path) and (.registration.providerSlug|id) and
        ((.registration.existingProviderId // "example")|type=="string" and test("^[A-Za-z0-9_-]+$")) and
        ((.registration.aliases // [])|type=="array" and length<=100 and all(.[];type=="string" and test("^[A-Za-z0-9_.:/-]{1,200}$"))) else true end) and
      ((.caFile // "/dev/null")|path) and ((.authHeaderFile // "/dev/null")|path)) and
    ([.inference[].id]|length==(unique|length))
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid agent or external inference configuration. Inference supports external HTTPS OpenAI-compatible APIs (including Ollama and llama.cpp); model contains only its existing id. Other provider protocols remain configured in Emberpath.'
}

hive_adapter_manifest() {
  jq -e '
    has("inferenceProfiles") or has("managedInference") or has("modelStorage") or
    ([.components|to_entries[]|(.key+" "+.value.image)]|any(.[];test("(^inference-|(^|[/ :_-])(ollama|llama[.-]?cpp|vllm)([/ :@_-]|$))";"i")))
  ' "$HIVE_MANIFEST" >/dev/null && hive_die 'Obsolete managed-inference release manifest: remove inference images, profiles, hardware matrices and model artifacts. Inference services are external dependencies; preserve their existing resources and configure HTTPS endpoints instead.'
  jq -e --slurpfile config "$HIVE_CONFIG" '
    . as $r | $config[0] as $c |
    all($c.agents[]; . as $a | $r.agentArtifacts[$a.runtime][$a.version][$c.hosts[$a.host].architecture // "amd64"] |
      (.url|type=="string" and startswith("https://")) and (.sha256|test("^[a-f0-9]{64}$")) and
      (.executable|test("^[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".." and .!=""))) and
      (.arguments|type=="array" and all(.[];type=="string" and (test("[\\r\\n]")|not))) and
      (if .preflight then (.preflight.arguments|type=="array" and length>0 and all(.[];type=="string" and (test("[\\r\\n]")|not))) and (.preflight.expectedOutput|type=="string" and length>0 and length<=256 and (test("[\\r\\n]")|not)) else true end) and
      (if has("initializationArguments") or has("verificationArguments") then
        all([.initializationArguments,.verificationArguments][];type=="array" and length>0 and length<=128 and all(.[];type=="string" and length>0 and length<=4096 and (test("[\\r\\n]")|not) and (contains("\u0000")|not)))
       else true end) and
      (if .acceptanceArguments then (.acceptanceArguments|type=="array" and length>0 and all(.[];type=="string" and (test("[\\r\\n]")|not))) else true end))
  ' "$HIVE_MANIFEST" >/dev/null || hive_die 'Selected native agent artifact is absent from the signed release matrix'
}
