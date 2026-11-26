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

hive_release_key_fingerprint() {
  local fingerprint
  fingerprint=$(openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | sha256sum | cut -d ' ' -f1) || return 1
  [[ $fingerprint =~ ^[a-f0-9]{64}$ && $fingerprint != e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ]] || return 1
  printf '%s\n' "$fingerprint"
}

hive_release_version_before() {
  [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1) == "$1" ]]
}

# Print "retiredSHA256 nextSHA256 firstRelease" for every rotation statement in a checkout's
# trust/rotations. Each statement must be signed by the key it retires. Parsed with jq only.
hive_release_rotations() (
  set -Eeuo pipefail
  local directory=$1/trust/rotations work statement retired next first
  [[ -e "$directory" || -L "$directory" ]] || exit 0
  [[ -d "$directory" && ! -L "$directory" ]] || hive_die 'Unsafe publisher key rotation directory'
  work=$(mktemp -d) || hive_die 'Could not check publisher key rotations'
  trap 'rm -rf -- "$work"' EXIT
  for statement in "$directory"/*.json; do
    [[ -e "$statement" || -L "$statement" ]] || continue
    [[ -f "$statement" && ! -L "$statement" && -f "$statement.sig" && ! -L "$statement.sig" ]] || hive_die 'Publisher key rotation statement or signature is missing or unsafe'
    jq -e '.schema==1 and .kind=="hive-publisher-key-rotation" and
      (.retiredKeySHA256|type=="string" and test("^[a-f0-9]{64}$")) and (.nextKeySHA256|type=="string" and test("^[a-f0-9]{64}$")) and
      .retiredKeySHA256!=.nextKeySHA256 and (.retiredKey|type=="string") and (.nextKey|type=="string") and
      (.firstRelease|type=="string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$statement" >/dev/null 2>&1 || hive_die 'Invalid publisher key rotation statement'
    { jq -j .retiredKey "$statement" > "$work/retired.pub" && jq -j .nextKey "$statement" > "$work/next.pub"; } || hive_die 'Cannot read a publisher key rotation statement'
    retired=$(hive_release_key_fingerprint "$work/retired.pub") && next=$(hive_release_key_fingerprint "$work/next.pub") || hive_die 'Invalid key in a publisher key rotation statement'
    [[ $retired == "$(jq -r .retiredKeySHA256 "$statement")" && $next == "$(jq -r .nextKeySHA256 "$statement")" ]] || hive_die 'Publisher key rotation fingerprints do not match their keys'
    openssl pkeyutl -verify -pubin -inkey "$work/retired.pub" -rawin -in "$statement" -sigfile "$statement.sig" >/dev/null 2>&1 || hive_die 'Publisher key rotation statement is not signed by the key it retires'
    first=$(jq -r .firstRelease "$statement")
    printf '%s %s %s\n' "$retired" "$next" "$first"
  done
)

# Succeed when the launcher may trust the release key of a checkout for this version:
# the same key; a newer key reached from the launcher's key through statements each signed
# by the key it retires; or a key this launcher's own history retired, for releases before
# its retirement. A retired key can never vouch for a later release.
hive_release_trust_key() (
  set -Eeuo pipefail
  local checkout=$1 version=$2 launcher target current edge retired next first edges steps=0 found
  cmp -s "$HIVE_ROOT/trust/publisher.pub" "$checkout/trust/publisher.pub" && exit 0
  launcher=$(hive_release_key_fingerprint "$HIVE_ROOT/trust/publisher.pub") || hive_die 'Invalid launcher publisher key'
  target=$(hive_release_key_fingerprint "$checkout/trust/publisher.pub") || hive_die 'Invalid release publisher key'
  [[ $launcher != "$target" ]] || exit 0
  edges=$( { hive_release_rotations "$HIVE_ROOT"; hive_release_rotations "$checkout"; } | sort -u) || exit 1
  current=$launcher
  while ((steps++ < 64)); do
    found=$(awk -v key="$current" '$1==key' <<< "$edges")
    [[ -n "$found" ]] || break
    [[ $(wc -l <<< "$found") == 1 ]] || hive_die 'Conflicting publisher key rotation statements'
    read -r retired next first <<< "$found"
    current=$next
    if [[ $current == "$target" ]]; then
      hive_release_version_before "$version" "$first" && hive_die "Release $version predates its publisher key (first valid for $first)"
      exit 0
    fi
  done
  # Only the launcher's own checkout may vouch for a retired key; downloaded statements cannot.
  edges=$(hive_release_rotations "$HIVE_ROOT") || exit 1
  found=$(awk -v key="$target" '$1==key' <<< "$edges")
  if [[ -n "$found" && $(wc -l <<< "$found") == 1 ]]; then
    read -r retired next first <<< "$found"
    hive_release_version_before "$version" "$first" || hive_die "Release $version is signed by a publisher key retired before $first"
    current=$next steps=0
    while [[ $current != "$launcher" ]] && ((steps++ < 64)); do
      edge=$(awk -v key="$current" '$1==key' <<< "$edges")
      [[ -n "$edge" && $(wc -l <<< "$edge") == 1 ]] || break
      read -r retired current first <<< "$edge"
    done
    [[ $current == "$launcher" ]] && exit 0
  fi
  hive_die 'Release publisher key differs from this checkout and no verified key rotation links them; review the release key before continuing'
)

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
  # Retain the launcher's trust anchor, including when launching an older release: a different
  # key is accepted only through a verified rotation chain (docs/RELEASING.md#rotating-the-key).
  hive_release_trust_key "$checkout" "$version" || exit 1
  openssl pkeyutl -verify -pubin -inkey "$checkout/trust/publisher.pub" -rawin \
    -in "$checkout/releases/$version.json" -sigfile "$checkout/releases/$version.json.sig" >/dev/null 2>&1 || hive_die 'Release signature verification failed'
  jq -e --arg version "$version" '.schema==1 and .version==$version and (.controllerSHA256|type=="string" and test("^[a-f0-9]{64}$"))' \
    "$checkout/releases/$version.json" >/dev/null || hive_die 'Invalid suite release manifest'
  hive_release_verify_source "$checkout" "$version"
  printf '%s\n' "$checkout"
)

# Withdrawn releases: the newest signed manifest in this checkout lists the releases its publisher
# withdrew (build-suite-manifest.mjs, from the inputs' "withdrawn"). Prints "action TAB reason TAB
# replacement" for VERSION when it is listed. Manifests whose signature does not verify are ignored.
hive_release_withdrawn() {
  local version=$1 name newest=''
  [[ -d "$HIVE_ROOT/releases" ]] || return 0
  while IFS= read -r name; do
    [[ -f "$HIVE_ROOT/releases/$name.json.sig" && ! -L "$HIVE_ROOT/releases/$name.json" ]] || continue
    openssl pkeyutl -verify -pubin -inkey "$HIVE_ROOT/trust/publisher.pub" -rawin -in "$HIVE_ROOT/releases/$name.json" \
      -sigfile "$HIVE_ROOT/releases/$name.json.sig" >/dev/null 2>&1 || continue
    newest=$HIVE_ROOT/releases/$name.json
    break
  done < <(find "$HIVE_ROOT/releases" -maxdepth 1 -type f -name '[0-9]*.[0-9]*.[0-9]*.json' ! -name '*.inputs.json' -printf '%f\n' | sed 's/\.json$//' | sort -rV)
  [[ -n "$newest" ]] || return 0
  jq -r --arg version "$version" '(.withdrawn // [])[] | select(.version==$version) | [.action, .reason, (.replacement // "")] | @tsv' "$newest"
}

# A refused release stops before it can plan, install or upgrade; HIVE_ALLOW_WITHDRAWN_RELEASE set
# to exactly that version runs it anyway, for a recovery that needs it. A warned one only warns.
hive_release_check_withdrawn() {
  local version=$1 entry action reason replacement
  entry=$(hive_release_withdrawn "$version") || hive_die 'Could not read the withdrawn releases'
  [[ -n "$entry" ]] || return 0
  IFS=$'\t' read -r action reason replacement <<< "$entry"
  if [[ "$action" == refuse && "${HIVE_ALLOW_WITHDRAWN_RELEASE:-}" != "$version" ]]; then
    hive_die "Release $version was withdrawn: $reason.${replacement:+ Use $replacement instead.} To run it anyway, for a recovery that needs exactly this release, set HIVE_ALLOW_WITHDRAWN_RELEASE=$version."
  fi
  printf 'Hive: warning: release %s was withdrawn: %s.%s\n' "$version" "$reason" "${replacement:+ Use $replacement instead.}" >&2
}

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
      --) [[ "$command" == admin-access ]] && break; return 0;;
      *)
        if [[ "$command" == admin-access && "$option" != --* ]]; then index=$((index+1)); continue; fi
        return 0;; # Let the controller validate other commands and unknown options.
    esac
  done
  [[ -n "$requested" ]] || return 0
  case "$command" in install|init|plan|upgrade|admin-access) ;;
    *) [[ $requested != latest ]] || hive_die 'latest applies only to install, init, plan, upgrade and admin-access'; return 0;;
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
  if [[ "$command" != admin-access ]]; then hive_need openssl; hive_release_check_withdrawn "$version"; fi
  arguments[release_index]=$version
  # Exact versions can run from a matching local checkout. Channel launches always
  # retain a verified tag so installed timers can keep using the selected controller.
  if [[ "$requested" != latest && -f "$HIVE_ROOT/releases/$version.json" ]]; then
    digest=$(hive_controller_digest) || hive_die 'Could not verify local controller source'
    if jq -e --arg digest "$digest" '.controllerSHA256==$digest' "$HIVE_ROOT/releases/$version.json" >/dev/null; then
      return 0
    fi
  fi
  hive_need git; hive_need openssl; hive_need flock; hive_need cmp; hive_need sed
  checkout=$(hive_release_checkout "$version") || hive_die 'Could not prepare the requested Hive controller'
  printf 'Hive: running release %s from %s\n' "$version" "$checkout" >&2
  exec bash "$checkout/hive.sh" "${arguments[@]}"
}
