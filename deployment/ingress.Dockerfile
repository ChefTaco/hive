FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
# curl is unused (the healthcheck uses busybox wget); remove it and take patched Alpine
# packages. The upstream binary has a privileged-port file capability. Remove it so the
# executable can run with ALL capabilities dropped on unprivileged port 8443.
RUN apk del --no-cache curl && apk upgrade --no-cache && setcap -r /usr/bin/caddy && chown -R 1000:1000 /data /config
USER 1000:1000
ENV XDG_CONFIG_HOME=/data/config XDG_DATA_HOME=/data
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8081/ready
CMD ["caddy", "run", "--config", "/config/Caddyfile", "--adapter", "caddyfile"]
