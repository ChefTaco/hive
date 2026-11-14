#!/usr/bin/env bash
# Product-owned bootstrap contracts. Called only by the fresh initializer after
# all hosts have passed preflight. No existing product state is adopted here.
hive_full_configuration() {
  local component password image user uid gid hash_output password_hash endpoint hostname magnus_identities
  for component in magnus cindertrace chattermost; do
    has_component "$component" || continue
    case "$component" in magnus) password=$(secret magnus-db);; cindertrace) password=$(secret security-db);; chattermost) password=$(secret chat-db);; esac
    printf '%s\n' "$password" | publish_file "$component-postgres" "$directory/config/$component-postgres/password"
    if [[ "$component" != chattermost ]]; then
      case "$component" in magnus) password=$(secret magnus-redis);; cindertrace) password=$(secret security-redis);; esac
      printf 'bind 0.0.0.0\nprotected-mode yes\ndir /data\nappendonly yes\nappendfsync everysec\nrequirepass %s\n' "$password" | publish_file "$component-redis" "$directory/config/$component-redis/redis.conf"
    fi
  done
  # The gateway and the server must hold the same links.
  # Ardent Project Studio's Magnus client is a service link: role ARDENT_SERVICE, subject = client ID.
  # An external Magnus holds the same links; the identity host writes them for the operator.
  { has_component magnus || { [[ -n "$external_magnus" ]] && has_component oathweave; }; } && magnus_identities=$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$(secret magnus-id)" --arg studio "$studio_magnus_client" --argjson withStudio "$(selected ardentstudio && echo true || echo false)" '[{issuer:$issuer,subject:$subject,localUserId:$id,role:"ADMIN"}] + (if $withStudio then [{issuer:$issuer,subject:$studio,localUserId:"ardentstudio",role:"ARDENT_SERVICE"}] else [] end)')
  if has_component magnus; then
    {
      common_environment; resource_identity; line MAGNUS_HOME /data; line MAGNUS_AUTO_MIGRATE false; line MAGNUS_UPDATE_CHECK false; line MAGNUS_AGENT_UPGRADES false
      if selected embermend; then
        line MAGNUS_EMBERMEND_GRANTS_JSON "$(jq -nc --arg token "$(printf '%s' "$(secret embermend-magnus)" | sha256sum | cut -d ' ' -f1)" --arg installation "$installation" '{"embermend":{tokenSha256:$token,installationId:$installation,productInstallationId:$installation,applicationIds:[],targets:{}}}')"
      fi
      line DATABASE_URL "postgresql://magnus:$(secret magnus-db)@magnus-postgres:5432/magnus"
      line REDIS_URL "redis://:$(secret magnus-redis)@magnus-redis:6379"
      if [[ "$magnus_node_keys_only" == true ]]; then
        # Magnus 3.0.0 or later: nodes and decisions are signed with node and server keys only, so a
        # fresh Magnus gets none of the fleet-wide node secrets and agents need none.
        line API_SECRET "$(secret magnus-api)"; line JWT_SECRET "$(secret magnus-jwt)"
        line AUDIT_HMAC_SECRET "$(secret magnus-audit)"; line LOG_INGEST_SIGNING_SECRET "$(secret magnus-log)"
        line CREDENTIAL_ROTATION_KEY "$(secret magnus-rotation)"; line METRICS_TOKEN "$(secret magnus-metrics)"; line WEBHOOK_ENCRYPTION_KEY "$(secret magnus-webhook)"
      else
      line API_SECRET "$(secret magnus-api)"; line JWT_SECRET "$(secret magnus-jwt)"; line NODE_MANAGER_SECRET "$(secret magnus-manager)"
      line AUDIT_HMAC_SECRET "$(secret magnus-audit)"; line RESULT_SIGNING_SECRET "$(secret magnus-result)"; line LOG_INGEST_SIGNING_SECRET "$(secret magnus-log)"
      line CREDENTIAL_ROTATION_KEY "$(secret magnus-rotation)"; line METRICS_TOKEN "$(secret magnus-metrics)"; line WEBHOOK_ENCRYPTION_KEY "$(secret magnus-webhook)"
      # The node agents hold the same key (hive.sh magnus-agent install copies it), so an ADMIN can
      # settle an Ardent action whose outcome is unknown.
      line COMMAND_RECONCILIATION_SECRET "$(secret magnus-reconcile)"
      fi
      line RESOURCE_PARTICIPANT_RECONCILIATION_SECRET "$(secret magnus-resource-review)"
      line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line CONTROL_API_BIND_HOST 0.0.0.0; line CONTROL_API_PORT 4000
      line CONTROL_API_URL "$(product_endpoint magnus https://magnus:4000)"; line CORS_ORIGIN "$origin"; line DASHBOARD_PUBLIC_ORIGIN "$origin"
      line SECURITY_FUSION_MODE off; line ENABLE_AGENT_DISCOVERY false
      line MAGNUS_CONSOLE_BASE_PATH /fleet; line MAGNUS_HERMES_ENABLED true
      line MAGNUS_OATHWEAVE_IDENTITIES_JSON "$magnus_identities"
      # Ardent New Agent enrolls each agent in HiveMem as Magnus's own Oathweave service identity and
      # creates the agents' workspace. Agents on fleet nodes reach HiveMem through the console.
      if [[ "$magnus_memory" == true ]]; then
        line MAGNUS_ARDENT_HIVEMEM_URL "$(product_endpoint hivemem https://hivemem:18790)"
        line MAGNUS_ARDENT_HIVEMEM_AGENT_URL "$origin/memory/"
        line MAGNUS_ARDENT_HIVEMEM_TOKEN_URL "$(product_endpoint oathweave https://oathweave:4200)/api/v1/oauth/token"
        line MAGNUS_ARDENT_HIVEMEM_CLIENT_ID "$magnus_hivemem_client"; line MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET "$(secret magnus-hivemem-client)"
        line MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID ardent-agents
      fi
      # Ardent skill installs fetch HiveSkills catalog releases over HTTPS from the registry's internal
      # address; its certificate is issued by the suite authority Magnus trusts (NODE_EXTRA_CA_CERTS).
      if selected hiveskills; then line MAGNUS_ARDENT_HIVESKILLS_URL "$(product_endpoint hiveskills https://hiveskills:4030)"; fi
      # DASHBOARD_PUBLIC_ORIGIN above is only for links in notifications: the console does not
      # answer drain challenges, the gateway does. With no gateway, say so explicitly, or every
      # node's resource drain waits for a participant that does not exist. CA trust for the
      # gateway's certificate comes from NODE_EXTRA_CA_CERTS in the common environment.
      if has_component magnus-gateway; then
        line FLEET_GATEWAY_URL "$(product_endpoint magnus-gateway https://magnus-gateway:4310)"
        line FLEET_GATEWAY_TOKEN_SHA256 "$(printf '%s' "$(secret magnus-gateway-api)" | sha256sum | cut -d ' ' -f1)"
        line RESOURCE_ENROLLMENT_DASHBOARD_SECRET "$(secret magnus-gateway-drain)"
      else line RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT absent; fi
    } | publish_file magnus "$directory/config/magnus.env"
  fi
  if has_component magnus-gateway; then
    endpoint=$(product_endpoint magnus-gateway https://magnus-gateway:4310); hostname=${endpoint#https://}; hostname=${hostname%%:*}
    {
      common_environment; resource_identity
      line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line FLEET_GATEWAY_BIND_HOST 0.0.0.0; line FLEET_GATEWAY_PORT 4310; line FLEET_GATEWAY_TLS_NAME "$hostname"
      line FLEET_GATEWAY_PUBLIC_ORIGIN "$origin"; line FLEET_GATEWAY_TRUST_FORWARDED_FOR true
      line MAGNUS_OATHWEAVE_IDENTITIES_JSON "$magnus_identities"
      line CONTROL_API_URL "$(product_endpoint magnus https://magnus:4000)"; line CONTROL_API_CA_PATH /config/authority.pem
      line FLEET_GATEWAY_API_TOKEN "$(secret magnus-gateway-api)"; line RESOURCE_ENROLLMENT_DASHBOARD_SECRET "$(secret magnus-gateway-drain)"
      line FLEET_GATEWAY_SSH_USERNAME "$(jq -er .bootstrap.magnusGateway.sshUsername <<< "$input")"; line FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH /config/ssh-key
      line FLEET_GATEWAY_KNOWN_HOSTS_FILE /data/known-hosts/known-hosts.json
    } | publish_file magnus-gateway "$directory/config/magnus-gateway.env"
    publish_file magnus-gateway "$directory/config/magnus-gateway/ssh-key" < "$(jq -er .bootstrap.magnusGateway.sshPrivateKeyFile <<< "$input")"
  fi
  if has_component cindertrace; then
    jq -nc --arg username "$username" --rawfile password "$state/secrets/security-admin-password" '{username:$username,password:($password|rtrimstr("\n"))}' | publish_file cindertrace "$directory/config/cindertrace/initial-browser-account.json"
    image=$(jq -er .bootstrapImages.cindertrace <<< "$input")
    [[ "$image" =~ @sha256:[a-f0-9]{64}$ ]] || die 'Fresh browser credential hashing requires an exact reviewed Cindertrace image digest'
    user=$(jq -er .bootstrapServiceUsers.cindertrace <<< "$input"); uid=${user%:*}; gid=${user#*:}
    hash_output="$state/cindertrace-browser"
    install -d -m 700 -o "$uid" -g "$gid" "$hash_output"
    docker pull --quiet "$image" >/dev/null
    docker run --rm --network none --user "$user" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --tmpfs /tmp:mode=1777 \
      --mount "type=bind,source=$directory/config/cindertrace/initial-browser-account.json,target=/config/initial-browser-account.json,readonly" \
      --mount "type=bind,source=$hash_output,target=/data" \
      --entrypoint node "$image" services/security-fusion/dist/browser-auth/hash-password.js --config /config/initial-browser-account.json --output /data/browser-admin.json >/dev/null || die 'Product-owned Cindertrace browser credential preparation failed; protected inputs are retained'
    record_file "$hash_output/browser-admin.json"
    password_hash=$(jq -er '.schema==1 and (.passwordHash|type=="string") | select(.)' "$hash_output/browser-admin.json" >/dev/null && jq -er .passwordHash "$hash_output/browser-admin.json")
    [[ "$password_hash" == '$argon2id$'* ]] || die 'Product-owned browser password hash is invalid'
    {
      common_environment; resource_identity; line CINDERTRACE_STATE_DIR /data
      line DATABASE_URL "postgresql://cindertrace:$(secret security-db)@cindertrace-postgres:5432/cindertrace"
      line REDIS_URL "redis://:$(secret security-redis)@cindertrace-redis:6379/0"
      line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line SECURITY_BIND_HOST 0.0.0.0; line SECURITY_API_PORT 4101
      line CINDERTRACE_BROWSER_AUTH_ENABLED true; line DASHBOARD_PUBLIC_ORIGIN "$origin"; line DASHBOARD_ADMIN_USERNAME "$username"
      line DASHBOARD_ADMIN_ACCOUNT_ID "$(secret security-id)"; line DASHBOARD_ADMIN_PASSWORD_HASH "'$password_hash'"
      line SESSION_SECRET "$(secret security-session)"; line SECURITY_CONSOLE_TOKEN_SECRET "$(secret security-console)"; line AUDIT_HMAC_SECRET "$(secret security-audit)"
      line SECURITY_FUSION_RECEIPT_SIGNING_KEY "$(secret security-receipt)"; line SECURITY_BACKUP_ENCRYPTION_KEY "$(secret security-backup)"; line AUTH_RATE_LIMIT_LABEL_KEY "$(secret security-rate)"
      line SECURITY_WRITES_ENABLED true; line SECURITY_INGEST_ENABLED false; line SECURITY_DISPATCH_ENABLED false; line SECURITY_RETENTION_ENABLED false; line SECURITY_NOTIFICATIONS_ENABLED false
      line SECURITY_APPROVAL_MODE console; line SECURITY_FUSION_UDP_ENABLED false; line TAILSCALE_LOCAL_ENABLED false
      line SECURITY_FUSION_EVIDENCE_DIR /data/security-fusion/evidence; line SECURITY_FUSION_STATE_DIR /data/collector; line SECURITY_MIGRATION_HISTORY_DIR /data
      line SECURITY_FUSION_RECEIPT_CHAIN_EXPORT /data/receipt-heads.jsonl; line AUDIT_LOG_DIR /data/audit-logs; line UI_SECURITY_LOG_PATH /data/ui-security/events.jsonl; line SECURITY_BACKUP_STATUS_FILE /data/backup-status.json
      line CINDERTRACE_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$(secret security-id)" '[{issuer:$issuer,subject:$subject,localUserId:$id,role:"ADMIN"}]')"
    } | publish_file cindertrace "$directory/config/cindertrace.env"
  fi
  if has_component chattermost; then
    endpoint=$(product_endpoint chattermost https://chattermost:8065); hostname=${endpoint#https://}; hostname=${hostname%%:*}
    {
      common_environment; resource_identity
      line DATABASE_URL "postgresql://chattermost_app:$(secret chat-db)@chattermost-postgres:5432/chattermost?schema=public"
      line SERVER_URL "$origin"; line PORT 8065; line BIND_HOST 0.0.0.0; line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line TLS_PROBE_SERVER_NAME "$hostname"; line TLS_PROBE_CA_PATH /config/authority.pem
      line CHATTERMOST_ENV_FILE /config/runtime.env; line POSTGRES_PASSWORD_FILE /config/postgres-password
      line COOKIE_SECRET "$(secret chat-cookie)"; line TOKEN_HASH_SECRET "$(secret chat-token)"
      line ADMIN_USERNAME "$username"; line ADMIN_EMAIL "$email"; line ADMIN_PASSWORD "$(secret chat-admin-password)"; line ADMIN_INITIAL_ID "$(secret chat-id)"; line ADMIN_FORCE_PASSWORD_RESET false
      line HERMES_BOT_TOKEN "$(secret chat-bot)"; line STORE_BACKEND postgres; line STORE_PATH /data/store.json; line FILE_STORAGE_PATH /data/files; line PROFILE_IMAGE_STORAGE_PATH /data/profile-images
      line ENABLE_TELEMETRY false; line ENABLE_DIAGNOSTICS false; line ENABLE_SECURITY_ALERT_CHECKS false; line ENABLE_PUBLIC_FILE_LINKS false; line ENABLE_REDIS_FANOUT false; line ENABLE_DISTRIBUTED_RATE_LIMIT false
      line OATHWEAVE_BROWSER_ORIGINS_JSON "$(jq -nc --arg origin "$origin" '[$origin]')"
      line OATHWEAVE_CHAT_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$(secret chat-id)" '[{issuer:$issuer,subject:$subject,localUserId:$id}]')"
    } | publish_file chattermost "$directory/config/chattermost.env"
    publish_file chattermost "$directory/config/chattermost/runtime.env" < "$directory/config/chattermost.env"
    printf '%s\n' "$(secret chat-db)" | publish_file chattermost "$directory/config/chattermost/postgres-password"
  fi
  if has_component emberfold; then
    {
      common_environment; line EMBERFOLD_API_TOKEN "$(secret context-api)"
    } | publish_file emberfold "$directory/config/emberfold.env"
    printf '%s\n' '{"host":"0.0.0.0","port":8096,"providers":[],"concurrency":2,"timeout_ms":120000}' | publish_file emberfold "$directory/config/emberfold/service.json"
  fi
  if has_component embermend; then
    printf '%s\n' "$(secret embermend-db)" | publish_file embermend-postgres "$directory/config/embermend-postgres/password"
    {
      common_environment; resource_identity
      line DATABASE_URL "postgresql://embermend:$(secret embermend-db)@embermend-postgres:5432/embermend"
      line MAGNUS_URL "${external_magnus:-$(product_endpoint magnus https://magnus:4000)}"; line MAGNUS_EMBERMEND_TOKEN "$(secret embermend-magnus)"
      line EMBERMEND_BIND 0.0.0.0; line EMBERMEND_PORT 4180
      line EMBERMEND_IDENTITY_GRANTS "$(jq -nc --arg subject "$subject" --arg installation "$installation" '[{subject:$subject,kind:"operator",permissions:["read","evidence","assess","prepare","propose","publish-explanation","ingest","policy"],scope:{installationId:$installation,applicationIds:[],targetIds:[]}},{subject:"embermend-coordinator",kind:"coordinator",permissions:["read","evidence","assess","prepare","propose","publish-explanation"],scope:{installationId:$installation,applicationIds:[],targetIds:[]}},{subject:"embermend-verifier",kind:"integration",permissions:["read","evidence","ingest"],scope:{installationId:$installation,applicationIds:[],targetIds:[]}}]')"
    } | publish_file embermend "$directory/config/embermend.env"
    publish_file embermend-worker "$directory/config/embermend-worker.env" < "$directory/config/embermend.env"
  fi
  if has_component ardentstudio; then
    # Studio reaches Magnus and HiveMem directly on their verified HTTPS endpoints, as itself,
    # never through the browser routes. Its operator link carries no permission ceiling.
    {
      line NODE_ENV production; line NODE_EXTRA_CA_CERTS /config/authority.pem
      line ARDENT_STUDIO_HOST 0.0.0.0; line ARDENT_STUDIO_PORT 8097; line ARDENT_STUDIO_DATA /data
      resource_identity
      line ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$(secret studio-id)" --arg name "$username" '[{issuer:$issuer,subject:$subject,localUserId:$id,displayName:$name}]')"
      line ARDENT_STUDIO_OATHWEAVE_TOKEN_URL "$(product_endpoint oathweave https://oathweave:4200)/api/v1/oauth/token"
      line ARDENT_STUDIO_MAGNUS_URL "${external_magnus:-$(product_endpoint magnus https://magnus:4000)}"
      line ARDENT_STUDIO_MAGNUS_CLIENT_ID "$studio_magnus_client"; line ARDENT_STUDIO_MAGNUS_CLIENT_SECRET "$(secret studio-magnus-client)"
      line ARDENT_STUDIO_MAGNUS_SCOPE magnus:ardent
      line ARDENT_STUDIO_HIVEMEM_URL "$(product_endpoint hivemem https://hivemem:18790)"
      line ARDENT_STUDIO_HIVEMEM_CLIENT_ID "$studio_hivemem_client"; line ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET "$(secret studio-hivemem-client)"
      line ARDENT_STUDIO_HIVEMEM_SCOPE "'hivemem:workspaces:write hivemem:memories:write'"
    } | publish_file ardentstudio "$directory/config/ardentstudio.env"
  fi
  # Hive does not run an external Magnus and cannot write its environment. These are the entries
  # it needs, for the operator to add there: Oathweave's browser issuer, its key set and userinfo
  # as another host reaches them (through the console origin, which maps /api/oathweave/* to
  # /api/v1/*), and the links. No entry is a secret; the file is owner-only like the rest.
  if [[ -n "$external_magnus" ]] && has_component oathweave; then
    local external_file="$state/external-magnus.env" pending
    pending=$(mktemp "$state/publish.XXXXXX")
    {
      printf '# Generated by hive.sh for installation %s. Add these entries to the environment of the\n' "$installation"
      printf '# Magnus at %s and restart it; see deployment/FULL.md#external-magnus.\n' "$external_magnus"
      printf '# Merge MAGNUS_OATHWEAVE_IDENTITIES_JSON with any links that Magnus already has. A Magnus\n'
      printf '# trusts one Oathweave issuer, and refuses OATHWEAVE_ISSUER together with IAM_CORE_URL.\n'
      line OATHWEAVE_ISSUER "$issuer"
      line OATHWEAVE_JWKS_URL "$origin/api/oathweave/oauth/jwks"
      line OATHWEAVE_USERINFO_URL "$origin/api/oathweave/oauth/userinfo"
      line MAGNUS_OATHWEAVE_IDENTITIES_JSON "'$magnus_identities'"
      if selected embermend; then
        printf '# Embermend requires the external Magnus 2.5+ bridge. Merge this named grant with existing\n'
        printf '# MAGNUS_EMBERMEND_GRANTS_JSON entries; never replace unrelated grants. Target and application\n'
        printf '# access remain empty until reviewed setup; this fragment grants no fleet action.\n'
        line MAGNUS_EMBERMEND_GRANTS_JSON "'$(jq -nc --arg name "embermend-$installation" --arg token "$(printf '%s' "$(secret embermend-magnus)" | sha256sum | cut -d ' ' -f1)" --arg installation "$installation" '{($name):{tokenSha256:$token,installationId:$installation,productInstallationId:$installation,applicationIds:[],targets:{}}}')'"
      fi
    } > "$pending"
    chmod 600 "$pending"
    if [[ -e "$external_file" || -L "$external_file" ]]; then
      [[ -f "$external_file" && ! -L "$external_file" ]] && cmp -s "$pending" "$external_file" || die 'Existing configuration differs; it will not be overwritten'
      rm -- "$pending"
    else sync -f "$pending"; mv -T -- "$pending" "$external_file"; fi
    record_file "$external_file"
  fi
}
