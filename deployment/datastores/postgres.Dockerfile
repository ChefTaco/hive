ARG POSTGRES_IMAGE=postgres:17.12-trixie@sha256:dbb9623d5121b5d2c2c9e2fba56e40193cbb3510d4af7f035b1ab1823aff3205
FROM ${POSTGRES_IMAGE} AS upstream
FROM cgr.dev/chainguard/wolfi-base@sha256:b7787f1d3f29dcfb48730372d3515391ac3b218723201a765c94949922676099 AS build
ARG POSTGRES_MAJOR=17
ARG POSTGRES_VERSION=17.12
ARG POSTGRES_SHA256=9cf136a703d8ee2f83465c43be4e9e8e7930c82b0bfba13be7e2537be769ac55
# Compilers, headers and Perl are confined to this stage.
RUN apk add --no-cache build-base curl ca-certificates bison flex pkgconf icu-dev=79.1-r2 libxml2-dev=2.15.4-r2 libxslt-dev=1.1.45-r8 openssl-4.0-dev krb5-dev openldap-2.6-dev linux-pam-dev libedit-dev util-linux-dev lz4-dev zstd-dev zlib-dev perl
WORKDIR /src
RUN curl -fsSLo pg.tar.bz2 https://ftp.postgresql.org/pub/source/v${POSTGRES_VERSION}/postgresql-${POSTGRES_VERSION}.tar.bz2 && echo "${POSTGRES_SHA256}  pg.tar.bz2" | sha256sum -c - && tar -xf pg.tar.bz2 --strip-components=1
# Keep setup failures from falling through to a later build step.
RUN set -e; ./configure --prefix=/usr --bindir=/usr/lib/postgresql/${POSTGRES_MAJOR}/bin --libdir=/usr/lib/postgresql/${POSTGRES_MAJOR}/lib --datadir=/usr/share/postgresql/${POSTGRES_MAJOR} --with-openssl --with-libedit-preferred --with-uuid=e2fs --with-libxml --with-libxslt --with-icu --with-lz4 --with-zstd --with-gssapi --with-ldap --with-pam && make -j8 world-bin && make DESTDIR=/stage install-world-bin
FROM cgr.dev/chainguard/wolfi-base@sha256:b7787f1d3f29dcfb48730372d3515391ac3b218723201a765c94949922676099
ARG POSTGRES_MAJOR=17
ARG POSTGRES_VERSION=17.12
RUN apk add --no-cache bash ca-certificates tzdata glibc-locale-en openssl libssl3 libcrypto3 libxml2-16=2.15.4-r2 libxslt=1.1.45-r8 libldap-2.6 liblz4-1 libzstd1 krb5-libs linux-pam libstdc++ libedit libuuid libicu79=79.1-r2 icu79-data-full=79.1-r2 && addgroup -g 999 postgres && adduser -D -u 999 -G postgres postgres
COPY --from=build /stage/usr/ /usr/
COPY --from=build /src/COPYRIGHT /usr/share/licenses/hive-postgres/postgresql
COPY --from=upstream /usr/lib/*-linux-gnu/libnss_wrapper.so /usr/lib/libnss_wrapper.so
COPY --from=upstream /usr/share/doc/libnss-wrapper/copyright /usr/share/licenses/hive-postgres/nss-wrapper
COPY --from=upstream /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV LD_LIBRARY_PATH=/usr/lib/postgresql/${POSTGRES_MAJOR}/lib PATH=/usr/lib/postgresql/${POSTGRES_MAJOR}/bin:$PATH PGDATA=/var/lib/postgresql/data PG_MAJOR=${POSTGRES_MAJOR} PG_VERSION=${POSTGRES_VERSION}
RUN sed -ri "s!^#?(listen_addresses)\s*=\s*\S+.*!\1 = '*'!" /usr/share/postgresql/${POSTGRES_MAJOR}/postgresql.conf.sample
RUN mkdir -p /var/lib/postgresql/data /var/run/postgresql && chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
RUN mkdir -p /usr/share/hive /docker-entrypoint-initdb.d && (/usr/lib/libc.so.6 | head -n 1 | grep -F 'stable release version 2.44.') >/dev/null && (printf '%s\n' glibc-2.44 icu-79.1 "$PG_MAJOR" | sha256sum | cut -d' ' -f1) > /usr/share/hive/postgres-runtime-id
COPY --chmod=0755 hive-postgres-runtime /usr/local/bin/hive-postgres-runtime
COPY 00-hive-runtime.sh /docker-entrypoint-initdb.d/00-hive-runtime.sh
USER postgres
ENTRYPOINT ["hive-postgres-runtime"]
CMD ["postgres"]
