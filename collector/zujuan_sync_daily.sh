#!/bin/sh

# Sequential daily refresh. Each invocation uses the same SQLite lock and
# checkpoint store; never run these five crawls concurrently.
set -eu

COLLECTOR_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN=$(command -v node || true)
fi
if [ -z "$NODE_BIN" ]; then
  echo "找不到 Node.js；请在 launchd 配置中设置 NODE_BIN 的绝对路径。" >&2
  exit 127
fi
if [ -z "${PLAYWRIGHT_CORE_PATH:-}" ] && [ -d "$COLLECTOR_DIR/node_modules/playwright-core" ]; then
  PLAYWRIGHT_CORE_PATH="$COLLECTOR_DIR/node_modules/playwright-core"
  export PLAYWRIGHT_CORE_PATH
fi
MAX_PAGES=${ZUJUAN_MAX_PAGES:-3}

cd "$COLLECTOR_DIR"
run_sync() {
  "$NODE_BIN" "$COLLECTOR_DIR/zujuan_sync.cjs" \
    --acknowledge-source-policy \
    --chapter-id 261314 \
    --max-pages "$MAX_PAGES" \
    --no-resume \
    --headful \
    "$@"
}

run_sync "$@"
run_sync --scene 预习 "$@"
run_sync --scene 作业 "$@"
run_sync --category 典型题 "$@"
run_sync --category 压轴题 "$@"
