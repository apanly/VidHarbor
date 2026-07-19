FROM node:24.18.0-bookworm-slim@sha256:af01d58b748ec92b1d6e8e11429aad424fd1e68c848185399dca0596a1ab8f5c AS yt-dlp

ARG TARGETARCH=arm64
ARG YT_DLP_VERSION=2026.07.04
ARG YT_DLP_SHA256=b6ce97646773070d7a7ffd6bbbdcaecb47c48483909c54c915bf08a7a9b5e0b1

RUN test "$TARGETARCH" = "arm64" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates=20230311+deb12u1 \
        curl=7.88.1-10+deb12u15 \
        file=1:5.44-3 \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --silent --show-error \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux_aarch64" \
        --output /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && file /usr/local/bin/yt-dlp | grep -q 'ARM aarch64' \
    && test "$(yt-dlp --version)" = "$YT_DLP_VERSION"

FROM node:24.18.0-bookworm-slim@sha256:af01d58b748ec92b1d6e8e11429aad424fd1e68c848185399dca0596a1ab8f5c AS build

ARG TARGETARCH=arm64

WORKDIR /app

RUN test "$TARGETARCH" = "arm64" \
    && test "$(node --print 'process.arch')" = "arm64" \
    && test "$(dpkg --print-architecture)" = "arm64" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        file=1:5.44-3 \
        g++=4:12.2.0-3 \
        make=4.3-4.1 \
        python3=3.11.2-1+b1 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm_config_build_from_source=true npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build \
    && native_module="$(find node_modules/better-sqlite3 -name better_sqlite3.node -print -quit)" \
    && test -n "$native_module" \
    && file "$native_module" | grep -q 'ARM aarch64' \
    && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim@sha256:af01d58b748ec92b1d6e8e11429aad424fd1e68c848185399dca0596a1ab8f5c AS runtime

ARG TARGETARCH=arm64

RUN test "$TARGETARCH" = "arm64" \
    && test "$(node --print 'process.arch')" = "arm64" \
    && test "$(dpkg --print-architecture)" = "arm64" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates=20230311+deb12u1 \
        ffmpeg=7:5.1.9-0+deb12u1 \
        file=1:5.44-3 \
    && rm -rf /var/lib/apt/lists/* \
    && file /usr/bin/ffmpeg | grep -q 'ARM aarch64' \
    && ffmpeg -version | grep -q '^ffmpeg version 5\.1\.9'

COPY --from=yt-dlp /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN test "$(yt-dlp --version)" = "2026.07.04" \
    && file /usr/local/bin/yt-dlp | grep -q 'ARM aarch64' \
    && native_module="$(find node_modules/better-sqlite3 -name better_sqlite3.node -print -quit)" \
    && test -n "$native_module" \
    && file "$native_module" | grep -q 'ARM aarch64' \
    && mkdir -p /data /downloads \
    && chown node:node /data /downloads

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/vidharbor.db \
    DOWNLOADS_MOUNT_PATH=/downloads

USER node

EXPOSE 3000
VOLUME ["/data", "/downloads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://localhost:3000/',{method:'GET'}).then(response=>{if(response.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
