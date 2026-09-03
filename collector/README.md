# collector

组卷网采集工程，与 `pc/`、`service/` 并列。只把公开题库页面写入本目录的 SQLite 和本地素材，**不写 MySQL**。发布进教案系统、以及是否把图片放到 MinIO，要等候选库审核后再做。

## 目录

```
collector/
  zujuan_sync.cjs              题目采集
  zujuan_question_sync.cjs     题库基础全量同步（列表 API 先行验证）
  zujuan_metadata_sync.cjs     版本 / 教材发现
  server.cjs                   受控 HTTP API 和任务编排
  lib/api_store.cjs            候选快照的只读查询边界
  qbpkg.cjs                    离线包构建（审核发布时用）
  lib/qbpkg/                   qbpkg 实现
  tests/                       Node 测试
  data/zujuan.sqlite3          候选库
  data/zujuan/assets/          题图和公式（同步 MySQL 前放这里）
  data/zujuan/raw/             页面 gzip 快照
  .cache/zujuan-sync-profile   Chrome 专用持久配置
```

默认路径都相对本目录，不再写到仓库根的 `data/`。

## 运行

需要本机 Node 22+ 和已安装的 Google Chrome。

```bash
cd collector
npm ci
npm test
npm start
node zujuan_question_sync.cjs --textbook-id 260617 --max-catalogs 1 --max-pages 1
# 若已有带登录态的 Chrome 在 9222 运行，可复用该浏览器而不关闭它
node zujuan_question_sync.cjs --cdp-url http://127.0.0.1:9222 \
  --textbook-id 260617 --max-catalogs 1 --max-pages 1
node zujuan_sync.cjs --catalog-progress --acknowledge-source-policy
node zujuan_sync.cjs --acknowledge-source-policy --headful \
  --version-name 北师大版 --textbook-name 九年级上册
```

`zujuan_question_sync.cjs` 是题库内容任务的正式 Collector 入口，由 `server.cjs` 在网页提交内容同步后启动；它不会修改正式表或 service。它先在同一持久 Chrome 档案打开教材入口，再读取静态目录 JSON，并在该页面会话中串行 POST `/zujuan-api/question/list`。默认使用已有的 `.cache/zujuan-sync-profile` 有头 Chrome 会话；只有显式传 `--headless` 才无头。它与旧 `zujuan_sync.cjs`/服务共用 `${db}.lock`，不能并行占用同一 SQLite 或 profile。已有 Chrome 调试端口运行时可传 `--cdp-url http://127.0.0.1:9222`（或 `--connect-over-cdp`），脚本通过该已有 context 共享 cookies/session，但始终新建专用采集 tab；连接模式结束只关闭自己新建的 tab，不关闭用户 browser/context。默认遍历章/小节/知识点和全部分页，验收时可用 `--max-catalogs`、`--catalog-id`、`--max-pages` 缩小范围。题目答案/解析固定写入 `answerStatus=not_collected`，列表题干标记 `contentSource=list_api` 与 `contentComplete`，原始接口页保存为 gzip 快照；`--no-download-assets` 可只记录素材 URL。遇到 401/403、JSON 变 HTML 或验证码/滑块时会把窗口置前，等待人工处理并以间隔 probe 同一页，不自动绕过验证。

`npm start` 默认在 `127.0.0.1:9110` 启动 API。对外绑定时必须配置令牌：

```bash
COLLECTOR_API_HOST=0.0.0.0 \
COLLECTOR_API_PORT=9110 \
COLLECTOR_API_TOKEN='replace-with-a-secret' \
npm start
```

可用的运行环境变量：

- `COLLECTOR_DB`：SQLite 候选库，默认 `collector/data/zujuan.sqlite3`；
- `COLLECTOR_DATA_DIR`：原始页和素材目录，默认 `collector/data/zujuan`；
- `COLLECTOR_PROFILE_DIR`：Chrome 配置，默认 `collector/.cache/zujuan-sync-profile`；
- `COLLECTOR_NODE_BIN`：运行采集脚本的 Node 可执行文件。
- `COLLECTOR_HEADFUL`：部署侧是否显示 Chrome 窗口（`true/false`，默认 `false`）；任务请求不能覆盖此配置。

`service` 必须通过 `BANK_COLLECTOR_URL` 和 `BANK_COLLECTOR_TOKEN`（如启用）连接此 API。即使是本地开发，也先运行 `cd collector && npm start`，再在 service 中设置 `BANK_COLLECTOR_URL=http://127.0.0.1:9110`；默认 loopback collector 不启用 token。API 只接受固定任务类型、服务端允许的教材 ID 和页数上限，不接受 SQL、脚本路径、数据库路径或任意命令。主要接口为：

- `POST /v1/jobs`、`GET /v1/jobs/:id`、`POST /v1/jobs/:id/cancel`；
- `POST /v1/metadata/validate`、`GET /v1/metadata/snapshot`；
- `GET /v1/candidates`、`GET /v1/catalog-progress`；
- `GET /v1/runs/{runId}/snapshot-page`：按 `collection`、`cursor`、`pageSize` 和 `textbookExternalId` 读取一个不可变运行快照页；`collection` 只能是 `catalogs`、`questions`、`questionCatalogs`、`tags` 或 `assets`，响应会受行数和字节上限约束，并返回 `nextCursor`；
- `GET /v1/runs/{runId}/assets/{sha256}`：按素材 SHA-256 和可选的 `textbookExternalId` 下载素材字节；collector 会校验快照归属、路径安全性、文件大小及实际 SHA-256 后才开始传输；
- `GET /health` 用于无敏感信息存活检查，`GET /v1/health` 需要认证。

## 独立部署边界

`collector` 自持 `data/` 和 `.cache/`，独立部署时应对这两个目录做持久化。`service` 不挂载 collector SQLite，`collector` 也不连接 MySQL；service 只通过上述 HTTP API 分页读取已封存快照。素材不会把 collector 宿主路径交给 service：collector 通过 `/assets/{sha256}` 传输经校验的字节，service 再校验 SHA-256 并保存到自己的 `BANK_ASSET_ROOT`（生产 Compose 使用持久化的 `/app/runtime/bank`）。
