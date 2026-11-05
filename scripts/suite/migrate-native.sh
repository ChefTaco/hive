#!/usr/bin/env bash
# Moves one existing native (systemd) installation onto the suite. Bash and jq only.
# plan is read-only. prepare stops nothing. cutover and rollback act only when run by name.

hive_native_validate() {
  jq -e 'has("nativeMigration")' "$HIVE_CONFIG" >/dev/null || return 0
  jq -e '
    def path: type=="string" and test("^/[A-Za-z0-9_./-]+$") and (split("/")|all(.!=".."));
    def id: type=="string" and test("^[a-z][a-z0-9-]{0,47}$");
    .nativeMigration as $n |
    ($n|type=="object" and (keys-["schema","expectedHost","machineIdSHA256","source","browserIssuer","verifyAddress","verifyExtraTrustFile","reviewedLinksFile","imageRegistry","dataAliases","adminAccount","rehearsal","networkSubnets","dryRunSubnets"]|length==0)) and
    $n.schema==1 and ($n.expectedHost|type=="string" and test("^[A-Za-z0-9][A-Za-z0-9-]{0,62}$")) and ($n.machineIdSHA256|test("^[a-f0-9]{64}$")) and
    ($n.source|type=="object" and (keys-["root","serviceManager","controlCommand","qdrantContainer","qdrantUrl","redisUrl","dataNetwork","archive"]|length==0)) and
    (($n.source.root // "/")|.=="/" or path) and (($n.source.serviceManager // "systemd")|IN("systemd","command")) and
    (if ($n.source.serviceManager // "systemd")=="command" or ($n.source.root // "/")!="/" then $n.rehearsal==true else true end) and
    ($n.browserIssuer|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?$")) and
    (($n.reviewedLinksFile // "/dev/null")|path) and
    (if $n.adminAccount then ($n.adminAccount|type=="object" and (keys-["subject","username","tokenFile","tokenTtlSeconds"]|length==0) and (.subject|type=="string" and length>0) and (.username|type=="string" and length>0) and (.tokenFile|path) and ((.tokenTtlSeconds // 86400)|type=="number" and .>=1 and .<=604800)) else true end) and
    (if $n.imageRegistry then ($n.imageRegistry|type=="object" and (keys-["server","username","passwordFile"]|length==0) and (.server|type=="string") and (.username|type=="string") and (.passwordFile|path)) else true end) and
    (.console.nativeListeners|type=="array" and all(.[];(keys-["port","component"]|length==0) and (.port|type=="number" and floor==. and .>=1024 and .<=65535) and (.component|id))) and
    ((.console.networkSubnet // "")|type=="string" and test("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/[0-9]{1,2}$")) and
    (.bootstrap==null) and (.profile=="custom")
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'Invalid nativeMigration configuration: see deployment/MIGRATE_NATIVE.md for the exact fields. The configuration needs the source identity, an HTTPS browser issuer, console.nativeListeners and console.networkSubnet, and no fresh-install bootstrap.'
}

hive_native_inputs() {
  HIVE_OPERATION=install
  HIVE_BOOTSTRAP_USERS=$(jq -c --slurpfile config "$HIVE_CONFIG" '.components|with_entries(select(.key as $name|$config[0].components[$name]!=null))|map_values(.service.user)' "$HIVE_MANIFEST")
  HIVE_BOOTSTRAP_IMAGES=$(jq -c --slurpfile config "$HIVE_CONFIG" '.components|with_entries(select(.key as $name|$config[0].components[$name]!=null))|map_values(.image)' "$HIVE_MANIFEST")
  HIVE_BOOTSTRAP_INGRESS=$(base64 -w0 "$HIVE_ROOT/deployment/Caddyfile")
  HIVE_NATIVE_DATA_TOOL=$(base64 -w0 "$HIVE_ROOT/scripts/suite/migrate-native-data.mjs")
  HIVE_NATIVE_ADMIN_SCRIPT=$(base64 -w0 "$HIVE_ROOT/scripts/suite/set-admin-password.sh")
  HIVE_NATIVE_LINKS=''
  local links
  links=$(jq -r '.nativeMigration.reviewedLinksFile // empty' "$HIVE_CONFIG")
  if [[ -n "$links" ]]; then
    [[ -f "$links" && ! -L "$links" && $(stat -c %u "$links") == "$(id -u)" ]] || hive_die 'The reviewed links file must be an operator-owned regular file'
    (( (8#$(stat -c %a "$links") & 077)==0 )) || hive_die 'The reviewed links file must be owner-only'
    HIVE_NATIVE_LINKS=$(jq -ce 'select(.schema==1 and (.installation|type=="string"))' "$links") || hive_die 'Invalid reviewed links file'
    [[ $(jq -r .installation <<< "$HIVE_NATIVE_LINKS") == "$(jq -r .installation "$HIVE_CONFIG")" ]] || hive_die 'This reviewed links file belongs to another installation. Refusing: independent installations are never mixed.'
  fi
}

hive_native_action() {
  local host=$1 action=$2
  HIVE_HOST_ACTION=$action hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/migrate-native-host.sh")"
}

hive_native_host() {
  jq -e '.hosts|length==1' "$HIVE_CONFIG" >/dev/null || hive_die 'A native installation runs on one host'
  jq -r '.hosts|keys[0]' "$HIVE_CONFIG"
}

# The raw token exists only on the controller, in one owner-only file. The host and the
# identity store receive its digest, so it is stored only as a hash.
hive_native_issue_token() {
  local host=$1 file subject token digest
  file=$(jq -r '.nativeMigration.adminAccount.tokenFile // empty' "$HIVE_CONFIG")
  [[ -n "$file" ]] || hive_die 'Confirm the administrator first: set nativeMigration.adminAccount'
  [[ ! -e "$file" && ! -L "$file" ]] || hive_die "A token file already exists at $file. Move it away after use; an older token stops working when a new one is issued."
  token="hive-reset.$(jq -r .installation "$HIVE_CONFIG").$(openssl rand -hex 32)"
  digest=$(printf '%s' "$token" | sha256sum | cut -d ' ' -f1)
  HIVE_NATIVE_TOKEN_DIGEST=$digest
  HIVE_NATIVE_TOKEN_TTL=$(jq -r '.nativeMigration.adminAccount.tokenTtlSeconds // 86400' "$HIVE_CONFIG")
  hive_native_action "$host" native-issue-token >&2 || { unset token; hive_die 'The reset token could not be issued; no token exists'; }
  (umask 077; set -o noclobber; printf '%s\n' "$token" > "$file") || { unset token; hive_die 'The token file could not be written; issue a new token'; }
  unset token
  subject=$(jq -r .nativeMigration.adminAccount.username "$HIVE_CONFIG")
  printf 'One-use reset token for %s is in %s (owner-only). It expires in %s seconds.\n' "$subject" "$file" "$HIVE_NATIVE_TOKEN_TTL" >&2
}

hive_native_rollback() {
  local host=$1
  printf 'Rolling back: the suite stops and the native services restart on their unchanged data.\n' >&2
  hive_native_action "$host" native-rollback
  # A reset token belongs to the suite data that was just set aside.
  local file
  file=$(jq -r '.nativeMigration.adminAccount.tokenFile // empty' "$HIVE_CONFIG")
  if [[ -n "$file" && -e "$file" ]]; then mv -- "$file" "$file.void-$(date -u +%Y%m%dT%H%M%SZ)"; fi
}

# Verification runs in two phases. Preservation compares the migrated copy with the native copy
# exactly, before the suite starts: no port is published, no product or worker runs, so no client
# can have changed anything yet. Serving checks run once clients can connect, and accept their
# writes: ports, certificates, tokens, credentials and the invariants no client can change.
hive_native_cutover() {
  local host=$1 hold=$2
  hive_native_action "$host" native-stop || hive_die 'Native writers could not be stopped; see the message above. Repeat cutover, or run rollback.'
  hive_native_action "$host" native-capture || hive_die 'The final copy failed. Native data is untouched. Repeat cutover, or run rollback.'
  hive_native_action "$host" native-migrate || hive_die 'Product migrations failed on the copy. Native data is untouched. Run rollback.'
  local result=0
  hive_native_action "$host" native-preserve || result=$?
  if ((result)); then
    if [[ "$hold" == true ]]; then hive_die 'Preserved data differs from the native copy. The suite was not started; --hold-on-failure keeps the copy for inspection. Then run rollback.'; fi
    hive_native_rollback "$host"
    hive_die 'Preserved data differs from the native copy, so this installation was rolled back before any client reached the suite. Evidence is in the migration directory.'
  fi
  # A repeated cutover continues from the last receipt.
  if [[ $(hive_native_action "$host" native-status | jq -r .suiteActive) != true ]]; then
    hive_doctor
    hive_registry_begin || hive_die 'The Hive Registry could not start. Native data is untouched. Run rollback.'
    hive_action "$host" activate || hive_die 'The suite did not become healthy. Native data is untouched. Run rollback.'
  fi
  hive_registry_complete || hive_registry_failed cutover
  hive_action "$host" complete
  hive_native_action "$host" native-verify || result=$?
  if ((result)); then
    if [[ "$hold" == true ]]; then hive_die 'Verification failed. The suite is left running because of --hold-on-failure. Inspect it, then run rollback.'; fi
    hive_native_rollback "$host"
    hive_die 'Verification failed, so this installation was rolled back. Evidence is in the migration directory.'
  fi
  if jq -e '.nativeMigration.adminAccount!=null' "$HIVE_CONFIG" >/dev/null; then
    if [[ ! -e $(jq -r .nativeMigration.adminAccount.tokenFile "$HIVE_CONFIG") ]]; then hive_native_issue_token "$host"; fi
  fi
  printf 'Cutover complete for %s.\n' "$(jq -r .installation "$HIVE_CONFIG")"
  if jq -e '.nativeMigration.adminAccount!=null' "$HIVE_CONFIG" >/dev/null; then
    printf 'Next, the owner runs on the host, on a terminal: sudo %s/bin/hive-set-admin-password\n' "$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG")"
  fi
}

hive_native_set_password() {
  local host=$1 target directory
  local -a ssh_options
  hive_ssh_options "$host"
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  directory=$(jq -r --arg host "$host" '.hosts[$host].directory' "$HIVE_CONFIG")
  [[ -t 0 ]] || hive_die 'set-admin-password needs a terminal: it prompts for the token and the password without echo'
  if [[ "$target" == local ]]; then exec "$directory/bin/hive-set-admin-password"; fi
  ssh_options=("${ssh_options[@]/BatchMode=yes/BatchMode=no}")
  exec ssh -t "${ssh_options[@]}" -- "$target" "sudo $directory/bin/hive-set-admin-password"
}

hive_native_migrate() {
  local subcommand=$1 confirmed=$2 hold=$3 host
  [[ -n "$subcommand" ]] || hive_die 'Use: migrate-native plan|prepare|cutover|verify|rollback|status|issue-admin-token|set-admin-password|tls-refresh'
  jq -e '.nativeMigration!=null' "$HIVE_CONFIG" >/dev/null || hive_die 'This configuration has no nativeMigration block'
  host=$(hive_native_host)
  hive_need openssl; hive_need sha256sum; hive_manifest
  hive_native_inputs
  case "$subcommand" in
    plan) hive_native_action "$host" native-plan; return;;
    status) hive_native_action "$host" native-status; return;;
    set-admin-password) hive_native_set_password "$host"; return;;
    prepare|cutover|verify|rollback|issue-admin-token|tls-refresh) ;;
    *) hive_die 'Use: migrate-native plan|prepare|cutover|verify|rollback|status|issue-admin-token|set-admin-password|tls-refresh';;
  esac
  case "$subcommand" in
    cutover|rollback)
      if [[ "$confirmed" != true ]]; then
        hive_native_action "$host" native-plan
        [[ -t 0 ]] || hive_die "$subcommand stops services; it requires --yes or a terminal"
        local answer
        read -r -p "Type the installation name to $subcommand it: " answer
        [[ "$answer" == "$(jq -r .installation "$HIVE_CONFIG")" ]] || hive_die 'Cancelled'
      fi;;
  esac
  case "$subcommand" in
    prepare)
      hive_native_action "$host" native-plan > /dev/null || hive_die 'Plan checks failed; nothing was changed'
      hive_native_action "$host" native-configure || hive_die 'Configuration could not be staged; native services are untouched'
      hive_registry_provision
      hive_native_action "$host" native-registry-login || hive_die 'Image registry login failed; native services are untouched'
      hive_stage
      hive_native_action "$host" native-dry-run || hive_die 'The dry run failed; native services are untouched'
      hive_native_action "$host" native-registry-logout
      printf 'Prepared. Native services were not stopped. Review plan output, then run cutover.\n';;
    cutover) hive_native_cutover "$host" "$hold";;
    verify) hive_native_action "$host" native-verify-live;;
    rollback) hive_native_rollback "$host";;
    issue-admin-token) hive_native_issue_token "$host";;
    tls-refresh) hive_native_action "$host" native-tls-refresh;;
  esac
}
