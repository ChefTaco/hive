# Sourced by the upstream entrypoint only after initdb has created a fresh database.
# Never mark an existing data directory merely because startup reached this file.
umask 077
cp /usr/share/hive/postgres-runtime-id "$PGDATA/.hive-runtime-collation"
