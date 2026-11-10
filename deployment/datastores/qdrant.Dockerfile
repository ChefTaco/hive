# Preserve the upstream Qdrant binary, configuration, SBOM and recovery entrypoint.
# The glibc runtime supplies patched libraries without unrelated Debian tools.
ARG QDRANT_IMAGE
FROM ${QDRANT_IMAGE} AS upstream
FROM cgr.dev/chainguard/wolfi-base@sha256:b7787f1d3f29dcfb48730372d3515391ac3b218723201a765c94949922676099
RUN apk add --no-cache libunwind bash ca-certificates tzdata
COPY --from=upstream /qdrant/qdrant /qdrant/qdrant
COPY --from=upstream /qdrant/qdrant.spdx.json /qdrant/qdrant.spdx.json
COPY --from=upstream /qdrant/config /qdrant/config
COPY --from=upstream /qdrant/entrypoint.sh /qdrant/entrypoint.sh
WORKDIR /qdrant
ENV TZ=Etc/UTC RUN_MODE=production
EXPOSE 6333 6334
CMD ["./entrypoint.sh"]
