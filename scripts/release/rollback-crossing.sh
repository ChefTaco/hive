#!/usr/bin/env bash
# The components whose storage format a code-only rollback from TO to FROM cannot read, one per
# line: the format changes and FROM's manifest does not list TO's format as readable. The host
# refuses such a rollback ("Binary rollback cannot read the current storage format"), so the
# upgrade round trip skips its rollback step when this prints anything.
#   rollback-crossing.sh FROM_MANIFEST TO_MANIFEST
set -euo pipefail
[[ $# == 2 && -f "$1" && -f "$2" ]] || { printf 'Use: rollback-crossing.sh FROM_MANIFEST TO_MANIFEST\n' >&2; exit 2; }
jq -nr --slurpfile from "$1" --slurpfile to "$2" '
  $to[0].components | to_entries[] | .key as $name | (.value.storageFormat // "unversioned") as $format |
  $from[0].components[$name] as $old | select($old != null) |
  select(($old.storageFormat // "unversioned") != $format and (($old.readableFormats // []) | index($format)) == null) | $name'
