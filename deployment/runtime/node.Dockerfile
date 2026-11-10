# Shared glibc runtime: patched distribution packages and no npm build tooling.
# Keep apk metadata for independent inventory and vulnerability scanning.
FROM cgr.dev/chainguard/wolfi-base@sha256:b7787f1d3f29dcfb48730372d3515391ac3b218723201a765c94949922676099
RUN apk add --no-cache nodejs-24=24.22.2-r2 openssl libssl3 libcrypto3 flock bash gzip ca-certificates libstdc++ && addgroup -g 1000 node && adduser -D -u 1000 -G node node
ENV NODE_ENV=production
USER 1000:1000
ENTRYPOINT []
CMD ["node"]
