FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app

COPY ts-core/package.json ts-core/package-lock.json ./ts-core/
RUN cd ts-core && npm ci --silent

COPY ts-core/ ./ts-core/
RUN cd ts-core && npm run build --silent && npm prune --omit=dev --silent

RUN useradd --system --no-create-home --shell /usr/sbin/nologin hivemem
USER hivemem

ENV HIVEMEM_TS_CORE_HOST=0.0.0.0
ENV HIVEMEM_WEB_PORT=18790
ENV HIVEMEM_TS_PERSISTENCE=qdrant
ENV HIVEMEM_STORAGE_PATH=/var/opt/hivemem

EXPOSE 18790

CMD ["node", "ts-core/dist/src/cli.js"]
