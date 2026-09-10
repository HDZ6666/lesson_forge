FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends xvfb chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENV RUN_CONTAINER_LIFECYCLE=1
