# Transported optional command: no Compose, migrations, enrollment or activation.
set -Eeuo pipefail
umask 077
read -r input
installation_directory=$(jq -er .directory <<< "$input")
host=$(jq -er .host <<< "$input"); plan=$(jq -er .plan <<< "$input"); action=$(jq -er .action <<< "$input")
[[ "$installation_directory" =~ ^/[A-Za-z0-9_./-]+$ && "$installation_directory" == "$(realpath -e -- "$installation_directory")" && ! -L "$installation_directory" && "$plan" =~ ^[a-f0-9]{64}$ ]] || { skills_integration_error 'Explicit existing canonical installation directory is required'; exit 1; }
jq -e --arg installation "$(jq -er .installation <<< "$input")" --arg host "$host" '.installation==$installation and .host==$host' "$installation_directory/installation.json" >/dev/null || { skills_integration_error 'Existing installation ownership differs'; exit 1; }
exec 9>"$installation_directory/controller.lock"; flock -n 9 || { skills_integration_error 'Another controller holds this host'; exit 1; }
directory=$(mktemp -d); trap 'rm -rf -- "$directory"' EXIT
for kind in manifest signature trust; do
  case "$kind" in manifest) destination="manifest.$plan.json";; signature) destination="signature.$plan";; trust) destination="trust.$plan.pub";; esac
  jq -er --arg kind "$kind" '.skillsRelease[$kind]' <<< "$input" | base64 -d > "$directory/$destination"
done
skills_integration_artifact >/dev/null || exit 1
case "$action" in
  token) skills_integration_token_digest;;
  preflight) skills_integration_preflight;;
  stage) skills_integration_stage;;
  verify) skills_integration_verify_executor;;
  proposal)
    token=$(jq -er .skillsTokenSHA256 <<< "$input")
    proposal=$(skills_integration_configuration "$token") || exit 1
    proposal=$(jq -c --arg host "$host" --argjson input "$input" --arg plan "$plan" '.+{schema:1,planSHA256:$plan,host:$host,activated:false,operatorActionRequired:true}|if $input.placements.hiveskills==null then del(.skillsExecutor) else . end|if $input.placements.magnus==null then del(.magnusGrants) else . end' <<< "$proposal")
    destination="$installation_directory/config/skills-proposals"
    [[ ! -L "$installation_directory/config" && ! -L "$destination" ]] || exit 1
    install -d -m 700 "$destination"
    file="$destination/$plan.json"
    if [[ -e "$file" || -L "$file" ]]; then
      [[ -f "$file" && ! -L "$file" && $(stat -c %u "$file") == "$(id -u)" && $(stat -c %a "$file") == 600 && $(jq -cS . "$file") == "$(jq -cS . <<< "$proposal")" ]] || { skills_integration_error 'Existing Skills proposal differs; retained without overwrite'; exit 1; }
    else (set -o noclobber; printf '%s\n' "$proposal" > "$file"); fi
    printf 'Protected Skills configuration proposal prepared for host %s; owner review required.\n' "$host";;
  *) skills_integration_error 'Unknown Skills preparation action'; exit 1;;
esac
