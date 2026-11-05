# Hive suite Redis: the official image at an exact digest with its pending Debian security
# updates applied, then apt removed. The suite runs it as its non-root service owner.
# Build: docker build -f redis.Dockerfile --build-arg REDIS_IMAGE=redis:TAG@sha256:... .
ARG REDIS_IMAGE
FROM ${REDIS_IMAGE}
RUN apt-get update \
 && apt-get install -y --only-upgrade --no-install-recommends $(dpkg-query -W -f '${Package}\n') \
 && dpkg --purge --force-remove-protected --force-remove-essential apt $(dpkg-query -W -f '${Package}\n' 'libapt-pkg*') \
 && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/log/apt
