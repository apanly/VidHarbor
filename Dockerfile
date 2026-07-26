FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS yt-dlp

ARG TARGETARCH
ARG YT_DLP_VERSION=2026.07.04
ARG YT_DLP_SHA256_AMD64=6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae
ARG YT_DLP_SHA256_ARM64=b6ce97646773070d7a7ffd6bbbdcaecb47c48483909c54c915bf08a7a9b5e0b1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates=20230311+deb12u1 \
        curl=7.88.1-10+deb12u15 \
        file=1:5.44-3 \
    && rm -rf /var/lib/apt/lists/*

RUN architecture="$(dpkg --print-architecture)" \
    && { test -z "$TARGETARCH" || test "$architecture" = "$TARGETARCH"; } \
    && case "$architecture" in \
        amd64) yt_dlp_asset='yt-dlp_linux'; yt_dlp_sha256="$YT_DLP_SHA256_AMD64"; file_pattern='x86-64' ;; \
        arm64) yt_dlp_asset='yt-dlp_linux_aarch64'; yt_dlp_sha256="$YT_DLP_SHA256_ARM64"; file_pattern='ARM aarch64' ;; \
        *) echo "unsupported architecture: $architecture" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --silent --show-error \
        --retry 3 --retry-all-errors --connect-timeout 30 --max-time 300 \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${yt_dlp_asset}" \
        --output /usr/local/bin/yt-dlp \
    && echo "${yt_dlp_sha256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && file /usr/local/bin/yt-dlp | grep -q "$file_pattern" \
    && test "$(yt-dlp --version)" = "$YT_DLP_VERSION"

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

ARG TARGETARCH
WORKDIR /app

RUN architecture="$(dpkg --print-architecture)" \
    && { test -z "$TARGETARCH" || test "$architecture" = "$TARGETARCH"; } \
    && case "$architecture" in \
        amd64) node_architecture='x64' ;; \
        arm64) node_architecture='arm64' ;; \
        *) echo "unsupported architecture: $architecture" >&2; exit 1 ;; \
    esac \
    && test "$(node --print 'process.arch')" = "$node_architecture" \
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
COPY README.md ./
COPY README.en.md ./
COPY LICENSE ./
COPY src ./src

RUN npm run build \
    && native_module="$(find node_modules/better-sqlite3 -name better_sqlite3.node -print -quit)" \
    && test -n "$native_module" \
    && architecture="$(dpkg --print-architecture)" \
    && case "$architecture" in \
        amd64) file_pattern='x86-64' ;; \
        arm64) file_pattern='ARM aarch64' ;; \
        *) echo "unsupported architecture: $architecture" >&2; exit 1 ;; \
    esac \
    && file "$native_module" | grep -q "$file_pattern" \
    && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

ARG TARGETARCH
RUN architecture="$(dpkg --print-architecture)" \
    && { test -z "$TARGETARCH" || test "$architecture" = "$TARGETARCH"; } \
    && case "$architecture" in \
        amd64) node_architecture='x64'; file_pattern='x86-64' ;; \
        arm64) node_architecture='arm64'; file_pattern='ARM aarch64' ;; \
        *) echo "unsupported architecture: $architecture" >&2; exit 1 ;; \
    esac \
    && test "$(node --print 'process.arch')" = "$node_architecture" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates=20230311+deb12u1 \
        ffmpeg=7:5.1.9-0+deb12u1 \
        file=1:5.44-3 \
    && rm -rf /var/lib/apt/lists/* \
    && file /usr/bin/ffmpeg | grep -q "$file_pattern" \
    && ffmpeg -version | grep -q '^ffmpeg version 5\.1\.9'

COPY --from=yt-dlp /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/README.md ./README.md
COPY --from=build --chown=node:node /app/README.en.md ./README.en.md
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE

RUN test "$(yt-dlp --version)" = "2026.07.04" \
    && native_module="$(find node_modules/better-sqlite3 -name better_sqlite3.node -print -quit)" \
    && test -n "$native_module" \
    && architecture="$(dpkg --print-architecture)" \
    && case "$architecture" in \
        amd64) file_pattern='x86-64' ;; \
        arm64) file_pattern='ARM aarch64' ;; \
        *) echo "unsupported architecture: $architecture" >&2; exit 1 ;; \
    esac \
    && file /usr/local/bin/yt-dlp | grep -q "$file_pattern" \
    && file "$native_module" | grep -q "$file_pattern" \
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
