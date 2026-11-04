FROM caddy:2.11.2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d
# The upstream binary has a privileged-port file capability. Remove it so the
# executable can run with ALL capabilities dropped on unprivileged port 8443.
RUN setcap -r /usr/bin/caddy && chown -R 1000:1000 /data /config
USER 1000:1000
ENV XDG_CONFIG_HOME=/data/config XDG_DATA_HOME=/data
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8081/ready
CMD ["caddy", "run", "--config", "/config/Caddyfile", "--adapter", "caddyfile"]
