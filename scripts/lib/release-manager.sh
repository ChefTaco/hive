#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# release-manager.sh - Atomic release + rollback primitives for Hive deploys
#
# Manages a service directory as immutable, timestamped releases with a
# `current` symlink and a `shared` directory for persistent state (database,
# .env, certs). Old releases are retained as rollback targets. This makes a bad
# deploy recoverable with a symlink flip instead of a rebuild.
#
# Layout under BASE (e.g. /opt/hive-router):
#   BASE/shared/            persistent state that survives releases
#   BASE/releases/<id>/     one immutable release (code + built dist + deps)
#   BASE/current -> releases/<id>
#
# All functions are pure with respect to their BASE argument so they can be
# unit-tested in a temp directory. They avoid `set -e` surprises by returning
# explicit status codes.
# -----------------------------------------------------------------------------

# Print a new sortable release id (UTC timestamp). A short random suffix avoids
# collisions when two deploys land in the same second.
release_manager_new_id() {
  printf '%s-%s\n' "$(date -u +%Y%m%d%H%M%S)" "$(printf '%04x' $((RANDOM % 65536)))"
}

# Ensure the base layout exists.
release_manager_init() {
  local base="$1"
  mkdir -p "$base/releases" "$base/shared" || return 1
}

# Migrate a legacy real-directory deployment into the shared layout. Moves any
# top-level .env, data, and certs into shared/ (only when not already present),
# so an existing host adopts the release layout without losing state. Legacy
# code files at the base root are left for the caller to clean after the first
# release is live and healthy. Idempotent: a no-op once shared/ is populated.
release_manager_migrate_legacy() {
  local base="$1"
  release_manager_init "$base" || return 1

  local item
  for item in .env data certs; do
    if [[ -e "$base/$item" && ! -L "$base/$item" && ! -e "$base/shared/$item" ]]; then
      mv "$base/$item" "$base/shared/$item" || return 1
    fi
  done
}

# Create a fresh release directory and print its path.
release_manager_prepare() {
  local base="$1" id="$2"
  local dir="$base/releases/$id"
  mkdir -p "$dir" || return 1
  printf '%s\n' "$dir"
}

# Point `current` at a release id (atomic replace of the symlink).
release_manager_activate() {
  local base="$1" id="$2"
  [[ -d "$base/releases/$id" ]] || { echo "release-manager: unknown release $id" >&2; return 1; }
  # Build the new symlink beside the target, then atomically rename over current.
  local tmp="$base/.current.$$.$RANDOM"
  ln -s "releases/$id" "$tmp" || return 1
  mv -T "$tmp" "$base/current" || { rm -f "$tmp"; return 1; }
}

# Print the currently active release id (empty if none).
release_manager_current_id() {
  local base="$1"
  local target
  target="$(readlink "$base/current" 2>/dev/null)" || return 0
  basename "$target"
}

# List release ids, oldest first.
release_manager_list() {
  local base="$1"
  [[ -d "$base/releases" ]] || return 0
  ls -1 "$base/releases" 2>/dev/null | sort
}

# Remove releases beyond the newest KEEP, never deleting the active release.
release_manager_prune() {
  local base="$1" keep="${2:-5}"
  local current
  current="$(release_manager_current_id "$base")"
  local -a releases
  mapfile -t releases < <(release_manager_list "$base")
  local total="${#releases[@]}"
  (( total <= keep )) && return 0
  local remove_count=$(( total - keep ))
  local removed=0 id
  for id in "${releases[@]}"; do
    (( removed >= remove_count )) && break
    if [[ "$id" == "$current" ]]; then
      continue
    fi
    rm -rf "${base:?}/releases/$id" || return 1
    removed=$(( removed + 1 ))
  done
}

# Resolve a rollback target: the given id, or the most recent release that is
# not currently active. Prints the target id, or fails if none is available.
release_manager_rollback_target() {
  local base="$1" requested="${2:-}"
  local current
  current="$(release_manager_current_id "$base")"

  if [[ -n "$requested" ]]; then
    if [[ -d "$base/releases/$requested" ]]; then
      printf '%s\n' "$requested"
      return 0
    fi
    echo "release-manager: requested rollback release not found: $requested" >&2
    return 1
  fi

  local -a releases
  mapfile -t releases < <(release_manager_list "$base")
  local i
  for (( i=${#releases[@]}-1; i>=0; i-- )); do
    if [[ "${releases[$i]}" != "$current" ]]; then
      printf '%s\n' "${releases[$i]}"
      return 0
    fi
  done
  echo "release-manager: no previous release available for rollback" >&2
  return 1
}
