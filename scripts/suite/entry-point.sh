# A stable `hive` command (deployment/README.md#the-hive-command). Every successful install,
# upgrade, rollback and adopt records the controller that ran it, owner-only, in
# $XDG_STATE_HOME/hive/ID/controller.json. `hive.sh entry-point install` puts
# scripts/suite/hive-entry.sh in ~/.local/bin/hive; it runs the recorded controller of the
# installation after checking that its source still has the recorded digest, so lifecycle
# commands never run from the wrong release checkout.

hive_entry_point_state() { # INSTALLATION
  printf '%s/hive/%s/controller.json\n' "${XDG_STATE_HOME:-${HOME:?HOME is required}/.local/state}" "$1"
}

hive_entry_point_record() { # OPERATION
  local operation=$1 state digest config controller
  state=$(hive_entry_point_state "$HIVE_ID") || return 0
  digest=$(hive_controller_digest) || return 0
  config=$(realpath -e -- "${HIVE_OPERATOR_CONFIG:-$HIVE_CONFIG}") || return 0
  controller=$(realpath -e -- "$HIVE_ROOT/hive.sh") || return 0
  if ! ( umask 077; mkdir -p -- "${state%/*}" &&
      jq -n --arg installation "$HIVE_ID" --arg release "$HIVE_VERSION" --arg controller "$controller" --arg digest "$digest" \
        --arg config "$config" --arg operation "$operation" --arg at "$(date -u +%FT%TZ)" \
        '{schema:1,installation:$installation,release:$release,controller:$controller,controllerSHA256:$digest,config:$config,operation:$operation,recordedAt:$at}' > "$state.tmp" &&
      mv -f -- "$state.tmp" "$state" ); then
    printf 'Hive: could not record this controller for the hive command in %s\n' "$state" >&2
  fi
}

hive_entry_point_command() { # install [BIN_DIRECTORY] | status
  local action=${1:-status} directory=${2:-${HOME:?HOME is required}/.local/bin} state
  case "$action" in
    install)
      (($# <= 2)) || hive_die 'Usage: hive.sh entry-point install [DIRECTORY] | status'
      [[ "$directory" == /* ]] || hive_die 'The directory is an absolute path'
      mkdir -p -- "$directory" || hive_die "Could not create $directory"
      install -m 0755 -- "$HIVE_ROOT/scripts/suite/hive-entry.sh" "$directory/hive.tmp" && mv -f -- "$directory/hive.tmp" "$directory/hive" || hive_die "Could not install $directory/hive"
      printf 'Installed %s/hive. It runs the controller that last installed, upgraded, rolled back or adopted an installation.\n' "$directory"
      [[ ":$PATH:" == *":$directory:"* ]] || printf 'Add %s to PATH to run it as hive.\n' "$directory"
      ;;
    status)
      (($# <= 1)) || hive_die 'Usage: hive.sh entry-point install [DIRECTORY] | status'
      local base=${XDG_STATE_HOME:-${HOME:?HOME is required}/.local/state}/hive found=false
      while IFS= read -r state; do
        found=true
        jq -r '"\(.installation): release \(.release), \(.controller) (\(.operation) at \(.recordedAt))"' "$state"
      done < <(find "$base" -mindepth 2 -maxdepth 2 -name controller.json -type f 2>/dev/null | sort)
      [[ "$found" == true ]] || printf 'No installation has recorded its controller yet; the next install, upgrade, rollback or adopt records it.\n'
      ;;
    *) hive_die 'Usage: hive.sh entry-point install [DIRECTORY] | status';;
  esac
}
