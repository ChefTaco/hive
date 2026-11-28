# Hive ingress. Caddy 2.11.9 is built from its published module with the dependency and Go
# toolchain fixes it was released without (deployment/caddy/go.mod and go.sum pin every
# module by version and checksum), then placed on the official Caddy 2.11.9 Alpine image.
# Smallstep certificates is pinned to its merged go-jose v4 compatibility commit until a tagged
# release includes it; crypto 0.92.0 and go-jose 4.1.9 remove the unsupported v3 dependency.
FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS caddy
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-trimpath GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
WORKDIR /src
COPY caddy/go.mod caddy/go.sum caddy/main.go ./
RUN go mod download && go mod verify
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags='-s -w' -o /out/caddy .

FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
# The rebuilt binary carries no privileged-port file capability, so it runs with ALL
# capabilities dropped on unprivileged port 8443. curl is unused (the healthcheck uses
# busybox wget); remove it and take patched Alpine packages.
COPY --from=caddy /out/caddy /usr/bin/caddy
RUN apk del --no-cache curl && apk upgrade --no-cache && chown -R 1000:1000 /data /config
USER 1000:1000
ENV XDG_CONFIG_HOME=/data/config XDG_DATA_HOME=/data
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8081/ready
CMD ["caddy", "run", "--config", "/config/Caddyfile", "--adapter", "caddyfile"]
