#!/usr/bin/env bash
# Test helper: adds the generated catalog metadata to a synthetic release manifest.
hive_test_catalog() {
  local file=$1 root
  root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
  jq --slurpfile catalog "$root/scripts/suite/suite-catalog.json" '.components|=with_entries(.value.catalog=($catalog[0][.key] // $catalog[0].emberfold)) | .components["hive-registry"].storageFormat="hive-registry-v1"' "$file" > "$file.catalog"
  mv -- "$file.catalog" "$file"
}
