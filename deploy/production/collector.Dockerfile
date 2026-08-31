FROM node:22-bookworm-slim

ENV NODE_ENV=production \
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
    && mkdir -p /opt/google/chrome \
    && ln -s /usr/bin/chromium /opt/google/chrome/chrome \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 9110

CMD ["sh", "-c", "Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & exec node server.cjs"]
