#!/usr/bin/env bash
# Resolve a channel once, then run the matching tagged controller with an exact version.
# Never update the caller's checkout or change its working directory (paths may be relative).

hive_release_verify_source() {
  local checkout=$1 version=$2 definition body file digest
  local -a files=()
  # Published controllers declare a literal printf list. Parse only that format, without
  # sourcing or evaluating downloaded shell code, and require both launcher and controller.
  [[ -f "$checkout/scripts/suite/controller.sh" && ! -L "$checkout/scripts/suite/controller.sh" ]] || hive_die 'Release controller source is missing'
  definition=$(sed -n '/^hive_runtime_files() {$/,/^}$/p' "$checkout/scripts/suite/controller.sh") || hive_die 'Cannot read release runtime list'
  [[ $definition == "hive_runtime_files() {"$'\n'"  printf '%s\\n' "* && $definition == *$'\n}' ]] || hive_die 'Unsupported release runtime list'
  body=${definition#"hive_runtime_files() {"$'\n'"  printf '%s\\n' "}
  body=${body%$'\n}'}
  body=${body//$'\\\n'/ }
  body=${body//$'\n'/ }
  read -r -a files <<< "$body"
  [[ " ${files[*]} " == *' hive.sh '* && " ${files[*]} " == *' scripts/suite/controller.sh '* ]] || hive_die 'Release runtime list omits its controller'
  for file in "${files[@]}"; do
    [[ $file =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && /$file/ != *'/../'* && -f "$checkout/$file" && ! -L "$checkout/$file" ]] || hive_die 'Invalid release runtime file'
  done
  digest=$( (cd "$checkout" || exit 1; for file in "${files[@]}"; do sha256sum --zero -- "$file" || exit 1; done) | sha256sum | cut -d ' ' -f1) || hive_die 'Could not hash release controller'
  [[ $digest == "$(jq -er .controllerSHA256 "$checkout/releases/$version.json")" ]] || hive_die 'Release controller source digest does not match its signed manifest'
}

hive_release_checkout() (
  set -Eeuo pipefail
  local version=$1 base checkout staging='' file head tag status
  base=${XDG_DATA_HOME:-${HOME:?HOME or XDG_DATA_HOME is required}/.local/share}/hive/releases
  mkdir -p -- "$base" || hive_die 'Could not create release directory'
  [[ ! -L "$base" && -O "$base" ]] || hive_die 'Release directory must be owned by the current user and not a symlink'
  chmod 700 "$base" || hive_die 'Could not protect release directory'
  [[ ! -L "$base/.lock" ]] || hive_die 'Unsafe release lock'
  exec {release_lock}> "$base/.lock" || hive_die 'Could not open release lock'
  flock "$release_lock" || hive_die 'Could not lock release directory'
  trap 'if [[ -n "$staging" ]]; then rm -rf -- "$staging"; fi' EXIT
  checkout=$base/$version
  if [[ ! -e "$checkout" && ! -L "$checkout" ]]; then
    staging=$(mktemp -d "$base/.download-XXXXXX") || hive_die 'Could not stage release checkout'
    git -c core.hooksPath=/dev/null -c advice.detachedHead=false clone --quiet --depth 1 --single-branch --branch "v$version" \
      https://github.com/ChefTaco/hive.git "$staging" >&2 || hive_die 'Could not download the requested Hive release'
    mv -- "$staging" "$checkout" || hive_die 'Could not retain release checkout'
    staging=''
  fi
  [[ -d "$checkout" && ! -L "$checkout" && -O "$checkout" && -d "$checkout/.git" && ! -L "$checkout/.git" ]] || hive_die 'Unsafe release checkout'
  [[ $(git -C "$checkout" remote get-url origin) == https://github.com/ChefTaco/hive.git ]] || hive_die 'Release checkout has an unexpected origin'
  head=$(git -C "$checkout" rev-parse HEAD) || hive_die 'Cannot read release checkout revision'
  tag=$(git -C "$checkout" rev-parse "refs/tags/v$version^{commit}") || hive_die 'Cannot read release tag'
  [[ $head == "$tag" ]] || hive_die 'Release checkout is not at the requested tag'
  status=$(git -C "$checkout" status --porcelain --untracked-files=all) || hive_die 'Cannot check release checkout changes'
  [[ -z "$status" ]] || hive_die 'Release checkout has local changes; restore it before continuing'
  for file in hive.sh "releases/$version.json" "releases/$version.json.sig" trust/publisher.pub; do
    [[ -f "$checkout/$file" && ! -L "$checkout/$file" ]] || hive_die 'Release is missing regular controller, manifest, signature or publisher files'
  done
  # Retain the launcher's trust anchor, including when launching an older release.
  cmp -s "$HIVE_ROOT/trust/publisher.pub" "$checkout/trust/publisher.pub" || hive_die 'Release publisher key differs from this checkout; review the release key before continuing'
  openssl pkeyutl -verify -pubin -inkey "$HIVE_ROOT/trust/publisher.pub" -rawin \
    -in "$checkout/releases/$version.json" -sigfile "$checkout/releases/$version.json.sig" >/dev/null 2>&1 || hive_die 'Release signature verification failed'
  jq -e --arg version "$version" '.schema==1 and .version==$version and (.controllerSHA256|type=="string" and test("^[a-f0-9]{64}$"))' \
    "$checkout/releases/$version.json" >/dev/null || hive_die 'Invalid suite release manifest'
  hive_release_verify_source "$checkout" "$version"
  printf '%s\n' "$checkout"
)

hive_release_launch() {
  local command=install requested='' explicit_manifest=false release_index=-1 index=0 option version tag checkout digest
  local -a arguments=("$@")
  if (($#)) && [[ $1 != --* ]]; then command=$1; index=1; fi
  # Parse option values as values: a config filename must never become a launcher option.
  while ((index < ${#arguments[@]})); do
    option=${arguments[index]}
    case "$option" in
      --help|-h) return 0;;
      --release|--config|--manifest|--signature|--trust-key|--archive|--reconciliation|--sources|--file|--host|--ssh-config|--sudo-password-file|--node-id|--port|--fingerprint|--previous|--approved-by|--approval-ref)
        ((index+1 < ${#arguments[@]})) && [[ -n ${arguments[index+1]} && ${arguments[index+1]} != --* ]] || return 0
        if [[ $option == --release ]]; then
          [[ $release_index == -1 ]] || hive_die 'Pass --release only once'
          release_index=$((index+1)); requested=${arguments[release_index]}
        fi
        case "$option" in --manifest|--signature|--trust-key) explicit_manifest=true;; esac
        index=$((index+2));;
      --yes|--non-interactive|--hold-on-failure|--stopped|--allow-migrations|--relax-auth-limits|--install-node|--trust) index=$((index+1));;
      *) return 0;; # Let the controller validate other commands and unknown options.
    esac
  done
  [[ -n "$requested" ]] || return 0
  case "$command" in install|init|plan|upgrade) ;;
    *) [[ $requested != latest ]] || hive_die 'latest applies only to install, init, plan and upgrade'; return 0;;
  esac
  if [[ $explicit_manifest == true ]]; then
    [[ $requested != latest ]] || hive_die 'Use an exact --release with --manifest, --signature or --trust-key'
    return 0
  fi
  version=$requested
  if [[ $requested == latest ]]; then
    hive_need curl; hive_need jq
    # GitHub excludes drafts and prereleases. Refuse legacy npm releases and malformed tags.
    tag=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 60 https://api.github.com/repos/ChefTaco/hive/releases/latest | \
      jq -er 'select(.draft==false and .prerelease==false) | .tag_name | select(type=="string" and test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))') || hive_die 'Could not resolve the latest published Hive suite release; retry or specify an exact version'
    version=${tag#v}
    [[ ${version%%.*} -ge 2 ]] || hive_die 'GitHub latest is a legacy release; specify an exact Hive suite version'
    printf 'Hive: latest resolved to %s\n' "$version" >&2
  fi
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || hive_die 'Use --release latest or an exact version such as 2.0.5'
  hive_need jq; hive_need sha256sum
  arguments[release_index]=$version
  # A matching local controller stays offline. Explicit manifests retain their existing path.
  if [[ -f "$HIVE_ROOT/releases/$version.json" ]]; then
    digest=$(hive_controller_digest) || hive_die 'Could not verify local controller source'
    if jq -e --arg digest "$digest" '.controllerSHA256==$digest' "$HIVE_ROOT/releases/$version.json" >/dev/null; then
      if [[ $requested == latest ]]; then exec bash "$HIVE_ROOT/hive.sh" "${arguments[@]}"; fi
      return 0
    fi
  fi
  hive_need git; hive_need openssl; hive_need flock; hive_need cmp; hive_need sed
  checkout=$(hive_release_checkout "$version") || hive_die 'Could not prepare the requested Hive controller'
  printf 'Hive: running release %s from %s\n' "$version" "$checkout" >&2
  exec bash "$checkout/hive.sh" "${arguments[@]}"
}
