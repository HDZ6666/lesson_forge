FROM node:22-bookworm-slim

ARG SOURCE_REVISION=uncommitted
LABEL org.opencontainers.image.revision=$SOURCE_REVISION

# node:sqlite prints an ExperimentalWarning on every process start (API and
# each crawl child); the collector depends on it deliberately.
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISPLAY=:99

RUN sed -i \
      -e 's@deb.debian.org/debian@mirrors.cloud.tencent.com/debian@g' \
      -e 's@deb.debian.org/debian-security@mirrors.cloud.tencent.com/debian-security@g' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      fonts-noto-cjk \
      xvfb \
      x11vnc \
    && mkdir -p /opt/google/chrome \
    && ln -s /usr/bin/chromium /opt/google/chrome/chrome \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 9110

CMD ["node", "container-entrypoint.cjs"]
