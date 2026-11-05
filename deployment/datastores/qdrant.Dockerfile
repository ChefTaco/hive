# Hive suite Qdrant: the official image at an exact digest with its pending Debian security
# updates applied, apt removed, and the bundled web dashboard (/qdrant/static) removed; the
# suite never exposes it and its JavaScript dependencies carry known vulnerabilities. The
# Qdrant binary, and so the storage format, is the upstream one.
# Build: docker build -f qdrant.Dockerfile --build-arg QDRANT_IMAGE=qdrant/qdrant:TAG@sha256:... .
ARG QDRANT_IMAGE
FROM ${QDRANT_IMAGE}
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends $(dpkg-query -W -f '${Package}\n') \
 && dpkg --purge --force-remove-protected --force-remove-essential apt $(dpkg-query -W -f '${Package}\n' 'libapt-pkg*') \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/log/apt /qdrant/static
