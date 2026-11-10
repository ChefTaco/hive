# The official Alpine image preserves Redis, its entrypoint and AOF/RDB formats.
# The suite starts as its configured non-root owner, so the root-only gosu helper
# is unnecessary. Removing that binary also removes its obsolete bundled Go runtime.
ARG REDIS_IMAGE
FROM ${REDIS_IMAGE}
RUN apk upgrade --no-cache && rm -f /usr/local/bin/gosu
