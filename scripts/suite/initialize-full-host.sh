#!/usr/bin/env bash
# Product-owned bootstrap contracts. Called only by the fresh initializer after
# all hosts have passed preflight. No existing product state is adopted here.
hive_full_configuration() {
  local component password image user uid gid hash_output password_hash endpoint hostname
  for component in magnus cindertrace chattermost; do
    has_component "$component" || continue
    case "$component" in magnus) password=$(secret magnus-db);; cindertrace) password=$(secret security-db);; chattermost) password=$(secret chat-db);; esac
    printf '%s\n' "$password" | publish_file "$component-postgres" "$directory/config/$component-postgres/password"
    if [[ "$component" != chattermost ]]; then
      case "$component" in magnus) password=$(secret magnus-redis);; cindertrace) password=$(secret security-redis);; esac
      printf 'bind 0.0.0.0\nprotected-mode yes\ndir /data\nappendonly yes\nappendfsync everysec\nrequirepass %s\n' "$password" | publish_file "$component-redis" "$directory/config/$component-redis/redis.conf"
    fi
  done
  if has_component magnus; then
    {
      common_environment; resource_identity; line MAGNUS_HOME /data; line MAGNUS_AUTO_MIGRATE false; line MAGNUS_UPDATE_CHECK false; line MAGNUS_AGENT_UPGRADES false
      line DATABASE_URL "postgresql://magnus:$(secret magnus-db)@magnus-postgres:5432/magnus"
      line REDIS_URL "redis://:$(secret magnus-redis)@magnus-redis:6379"
      line API_SECRET "$(secret magnus-api)"; line JWT_SECRET "$(secret magnus-jwt)"; line NODE_MANAGER_SECRET "$(secret magnus-manager)"
      line AUDIT_HMAC_SECRET "$(secret magnus-audit)"; line RESULT_SIGNING_SECRET "$(secret magnus-result)"; line LOG_INGEST_SIGNING_SECRET "$(secret magnus-log)"
      line CREDENTIAL_ROTATION_KEY "$(secret magnus-rotation)"; line METRICS_TOKEN "$(secret magnus-metrics)"; line WEBHOOK_ENCRYPTION_KEY "$(secret magnus-webhook)"
      line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line CONTROL_API_BIND_HOST 0.0.0.0; line CONTROL_API_PORT 4000
      line CONTROL_API_URL "$(product_endpoint magnus https://magnus:4000)"; line CORS_ORIGIN "$origin"; line DASHBOARD_PUBLIC_ORIGIN "$origin"
      line SECURITY_FUSION_MODE off; line ENABLE_AGENT_DISCOVERY false
      line MAGNUS_CONSOLE_BASE_PATH /fleet; line MAGNUS_HERMES_ENABLED true
      line MAGNUS_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$(secret magnus-id)" '[{issuer:$issuer,subject:$subject,localUserId:$id,role:"ADMIN"}]')"
    } | publish_file magnus "$directory/config/magnus.env"
  fi
  if has_component cindertrace; then
    jq -nc --arg username "$username" --arg password "$(secret security-admin-password)" '{username:$username,password:$password}' | publish_file cindertrace "$directory/config/cindertrace/initial-browser-account.json"
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
}
