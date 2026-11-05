# Hive ingress. Caddy 2.11.7 is built from its published module with the dependency and Go
# toolchain fixes it was released without (deployment/caddy/go.mod and go.sum pin every
# module by version and checksum), then placed on the official Caddy 2.11.7 Alpine image.
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine@sha256:2529d034e028b777993173bcd4d48f0594e31daaa0191454c52ebf0b5fa0db97 AS caddy
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-trimpath GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
WORKDIR /src
COPY caddy/go.mod caddy/go.sum caddy/main.go ./
RUN go mod download && go mod verify
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags='-s -w' -o /out/caddy .

FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
# The rebuilt binary carries no privileged-port file capability, so it runs with ALL
# capabilities dropped on unprivileged port 8443. curl is unused (the healthcheck uses
# busybox wget); remove it and take patched Alpine packages.
COPY --from=caddy /out/caddy /usr/bin/caddy
RUN apk del --no-cache curl && apk upgrade --no-cache && chown -R 1000:1000 /data /config
USER 1000:1000
ENV XDG_CONFIG_HOME=/data/config XDG_DATA_HOME=/data
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8081/ready
CMD ["caddy", "run", "--config", "/config/Caddyfile", "--adapter", "caddyfile"]
