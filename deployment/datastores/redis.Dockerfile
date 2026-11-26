# The official Alpine image preserves Redis, its entrypoint and AOF/RDB formats.
# The suite starts as its configured non-root owner, so the root-only gosu helper
# is unnecessary. Removing that binary also removes its obsolete bundled Go runtime.
ARG REDIS_IMAGE
FROM ${REDIS_IMAGE}
# OpenSSL 3.5.9-r2 fixes CVE-2026-124709; the explicit versions fail the build if it is missing.
RUN apk upgrade --no-cache && apk add --no-cache libssl3=3.5.9-r2 libcrypto3=3.5.9-r2 && rm -f /usr/local/bin/gosu
