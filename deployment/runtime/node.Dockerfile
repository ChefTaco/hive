# Shared glibc runtime: patched distribution packages and no npm build tooling.
# Keep apk metadata for independent inventory and vulnerability scanning.
FROM node:26.13.1-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS node
FROM cgr.dev/chainguard/wolfi-base@sha256:5172a213d2bba8b1c9ca11957db65562b52b0f9844583a0347318ea5fd8e3aa5
# The distribution package can lag a Node security release. Copy only the official
# binary, retaining the hardened glibc userspace and no package-manager tooling.
RUN apk add --no-cache openssl libssl3 libcrypto3 flock bash gzip ca-certificates libstdc++ libatomic && addgroup -g 1000 node && adduser -D -u 1000 -G node node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/LICENSE /usr/share/licenses/node/LICENSE
RUN test "$(node --version)" = v26.13.1
# Scanner feeds do not identify SQLite embedded in Node; execute it explicitly.
RUN node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');const v=db.prepare('select sqlite_version() v').get().v.split('.').map(Number);if(v[0]<3||(v[0]===3&&v[1]<54))throw Error('Unpatched embedded SQLite');db.close()"
ENV NODE_ENV=production
USER 1000:1000
ENTRYPOINT []
CMD ["node"]
