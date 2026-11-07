# Hive suite PostgreSQL: the official image at an exact digest, minus what the suite never runs.
# The suite starts PostgreSQL as its non-root service owner, so the entrypoint never reaches
# its root-only gosu step; gosu (an old Go build) and apt are removed. Everything else,
# including docker-entrypoint.sh, initdb and data checksums, is the upstream image.
# Build: docker build -f postgres.Dockerfile --build-arg POSTGRES_IMAGE=postgres:TAG@sha256:... .
ARG POSTGRES_IMAGE
FROM ${POSTGRES_IMAGE}
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends $(dpkg-query -W -f '${Package}\n') \
 && rm -f /usr/local/bin/gosu \
 && dpkg --purge --force-remove-protected --force-remove-essential apt $(dpkg-query -W -f '${Package}\n' 'libapt-pkg*') \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/log/apt
