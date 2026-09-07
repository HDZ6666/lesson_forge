#!/bin/sh

# Stable wrapper for cron/launchd. Keep the browser/profile and SQLite paths
# inside the project so a scheduled run uses the same checkpoint as a manual run.
set -eu

COLLECTOR_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN=$(command -v node || true)
fi
if [ -z "$NODE_BIN" ]; then
  echo "找不到 Node.js；请设置 NODE_BIN 的绝对路径。" >&2
  exit 127
fi

if [ -z "${PLAYWRIGHT_CORE_PATH:-}" ]; then
  if [ -d "$COLLECTOR_DIR/node_modules/playwright-core" ]; then
    PLAYWRIGHT_CORE_PATH="$COLLECTOR_DIR/node_modules/playwright-core"
    export PLAYWRIGHT_CORE_PATH
  fi
fi

cd "$COLLECTOR_DIR"
exec "$NODE_BIN" "$COLLECTOR_DIR/legacy/zujuan_sync.cjs" \
  --acknowledge-source-policy \
  --headful \
  "$@"
