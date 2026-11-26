#!/usr/bin/env bash
# hive: Hive's stable entry point, installed by `hive.sh entry-point install`. It runs the
# controller that last installed, upgraded, rolled back or adopted the installation, recorded in
# $XDG_STATE_HOME/hive/ID/controller.json, after checking that the controller's source still has
# the digest it had then, without running any of its code first. The installation is the one --config names, HIVE_INSTALLATION, or the
# only one recorded. Every argument is passed on unchanged. See deployment/README.md#the-hive-command.
set -Eeuo pipefail
die() { printf 'hive: %s\n' "$*" >&2; exit 1; }
command -v jq >/dev/null || die 'jq is required'
base=${XDG_STATE_HOME:-${HOME:?HOME is required}/.local/state}/hive
config='' previous='' installation=${HIVE_INSTALLATION:-}
for argument in "$@"; do
  if [[ "$previous" == --config ]]; then config=$argument; fi
  previous=$argument
done
if [[ -n "$config" ]]; then
  installation=$(jq -er '.installation|strings' "$config" 2>/dev/null) || die "Cannot read the installation name from $config"
elif [[ -z "$installation" ]]; then
  mapfile -t states < <(find "$base" -mindepth 2 -maxdepth 2 -name controller.json -type f 2>/dev/null)
  ((${#states[@]} == 1)) || die 'Name the installation with --config FILE or HIVE_INSTALLATION=ID: there is not exactly one recorded installation'
  installation=$(jq -er '.installation|strings' "${states[0]}") || die "Cannot read ${states[0]}"
  export HIVE_INSTALLATION=$installation
fi
[[ "$installation" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'Invalid installation name'
state=$base/$installation/controller.json
[[ -f "$state" && ! -L "$state" && -O "$state" ]] || die "No controller is recorded for $installation. Run its next upgrade (or install, rollback or adopt) with hive.sh once"
(( (8#$(stat -c %a "$state") & 077) == 0 )) || die "$state must be readable by its owner only"
controller=$(jq -er '.controller|strings' "$state") && digest=$(jq -er '.controllerSHA256|strings' "$state") && release=$(jq -er '.release|strings' "$state") || die "Invalid $state"
root=${controller%/hive.sh}
[[ "$controller" == /*/hive.sh && -f "$controller" && ! -L "$controller" && -f "$root/scripts/suite/controller.sh" && -O "$root" ]] ||
  die "The controller that ran $installation (release $release) is missing: $controller"
# Hash the controller runtime files without running any code of the checkout, as the release
# launcher does (hive_release_verify_source): parse only the literal printf list of
# hive_runtime_files, then hash those regular files in that order.
definition=$(sed -n '/^hive_runtime_files() {$/,/^}$/p' "$root/scripts/suite/controller.sh") || die "Cannot read the controller in $root"
[[ $definition == "hive_runtime_files() {"$'\n'"  printf '%s\\n' "* && $definition == *$'\n}' ]] || die "The controller in $root has an unsupported runtime list"
body=${definition#"hive_runtime_files() {"$'\n'"  printf '%s\\n' "}
body=${body%$'\n}'}
body=${body//$'\\\n'/ }
body=${body//$'\n'/ }
read -r -a files <<< "$body"
[[ " ${files[*]} " == *' hive.sh '* && " ${files[*]} " == *' scripts/suite/controller.sh '* ]] || die "The controller in $root has an invalid runtime list"
for file in "${files[@]}"; do
  [[ $file =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && /$file/ != *'/../'* && -f "$root/$file" && ! -L "$root/$file" ]] || die "The controller in $root has an invalid runtime file: $file"
done
actual=$( (cd -- "$root" || exit 1; for file in "${files[@]}"; do sha256sum --zero -- "$file" || exit 1; done) | sha256sum | cut -d ' ' -f1) || die "Cannot check the controller in $root"
[[ "$actual" == "$digest" ]] || die "The controller in $root changed since it ran $installation (release $release). Restore that checkout, or run hive.sh from the release you want"
exec bash "$controller" "$@"
