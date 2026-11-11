# Shared glibc runtime: patched distribution packages and no npm build tooling.
# Keep apk metadata for independent inventory and vulnerability scanning.
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS node
FROM cgr.dev/chainguard/wolfi-base@sha256:b7787f1d3f29dcfb48730372d3515391ac3b218723201a765c94949922676099
# The distribution package can lag a Node security release. Copy only the official
# binary, retaining the hardened glibc userspace and no package-manager tooling.
RUN apk add --no-cache openssl libssl3 libcrypto3 flock bash gzip ca-certificates libstdc++ libatomic && addgroup -g 1000 node && adduser -D -u 1000 -G node node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN test "$(node --version)" = v26.13.1
# Scanner feeds do not identify SQLite embedded in Node; execute it explicitly.
RUN node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');const v=db.prepare('select sqlite_version() v').get().v.split('.').map(Number);if(v[0]<3||(v[0]===3&&v[1]<54))throw Error('Unpatched embedded SQLite');db.close()"
ENV NODE_ENV=production
USER 1000:1000
ENTRYPOINT []
CMD ["node"]
