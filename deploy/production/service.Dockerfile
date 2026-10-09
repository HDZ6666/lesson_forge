FROM python:3.12-slim-bookworm

ARG SOURCE_REVISION=uncommitted
LABEL org.opencontainers.image.revision=$SOURCE_REVISION

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcairo2 fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN pip install --no-cache-dir \
      --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
      -r requirements.txt

EXPOSE 9099

CMD ["python", "app.py"]
