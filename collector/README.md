# collector

当前进度见 [采集端进度](../docs/进度/采集端进度.md)，真实故障与处理证据见 [采集端实际问题](../docs/采集端实际问题.md)。来源为无需登录的公开页面/接口；匿名会话和访问保护不等于登录要求。本文描述代码入口，最新版本整册验收及自动恢复状态以进度文档为准。

组卷网采集工程，与 `pc/`、`service/` 并列。只把公开题库页面写入本目录的 SQLite 和本地素材，**不写 MySQL**。正式入库由 Service 的任务应用或离线 Publisher 负责；素材传输到后端自己的存储，当前不以 MinIO 为必需条件。

## 目录

```
collector/
  server.cjs                   HTTP API 入口（实现在 src/api/）
  zujuan_question_sync.cjs     题库内容采集 CLI 入口（实现在 src/jobs、src/cli）
  zujuan_metadata_sync.cjs     版本 / 教材发现 CLI 入口（实现在 src/jobs、src/cli）
  qbpkg.cjs                    离线包构建（审核发布时用）
  lib/api_store.cjs            只读查询 facade，实现在 src/storage/readers/
  lib/run_snapshots.cjs        运行快照 schema 与不可变触发器
  lib/qbpkg/                   qbpkg 实现
  src/
    shared/                    工具、文件锁、URL 白名单、HTML 小解析器、错误类
    sources/zujuan/            常量、URL、目录/题目/元数据解析、请求、响应分类、Chrome 会话、8 路列表窗口
    policies/                  分页边界、重试/限速、完整性判定（纯函数）
    assets/                    素材下载与公式 SVG 回退
    storage/                   SQLite schema、题库/元数据 store、续采校验、原始页、只读 readers
    jobs/                      单次运行（question_run、metadata_run）、结构化事件
    api/                       路由、HTTP 边界、publicJob 投影、job 持久化与编排
    cli/                       两个采集脚本的参数解析与入口
  legacy/                      旧页面点击采集器 zujuan_sync.cjs 及其 cron 包装脚本
  tests/                       Node 测试；tests/fixtures 为脱敏真实响应；tests/tools 为静态扫描
  data/zujuan.sqlite3          候选库（含 collector_jobs 任务表）
  data/zujuan/assets/          题图和公式（同步 MySQL 前放这里）
  data/zujuan/raw/             页面 gzip 快照
  .cache/zujuan-sync-profile   Chrome 专用持久配置
```

默认路径都相对本目录，不再写到仓库根的 `data/`。模块依赖方向固定为 `shared ← sources/policies/assets/storage ← jobs ← api/cli`；解析与策略模块不依赖浏览器和 SQLite。

## 运行

需要本机 Node 22.5+ 和已安装的 Google Chrome。

```bash
cd collector
npm ci
npm test
npm run check:undeclared        # 搬迁类改动后的未声明标识符扫描（依赖 ../pc/node_modules/acorn）
npm start
node zujuan_question_sync.cjs --textbook-id 260617 --max-catalogs 1 --max-pages 1
# 若已有带登录态的 Chrome 在 9222 运行，可复用该浏览器而不关闭它
node zujuan_question_sync.cjs --cdp-url http://127.0.0.1:9222 \
  --textbook-id 260617 --max-catalogs 1 --max-pages 1
# 旧页面采集器（仅人工/定时使用，不被 HTTP API 调用）
npm run legacy:sync -- --catalog-progress --acknowledge-source-policy
npm run legacy:sync:book -- --version-name 北师大版 --textbook-name 九年级上册
```

`zujuan_question_sync.cjs` 是题库内容任务的正式 Collector 入口，由 `server.cjs` 在网页提交内容同步后启动；它不会修改正式表或 service。它先在同一持久 Chrome 档案打开教材入口，再读取静态目录 JSON，并在该页面会话中 POST `/zujuan-api/question/list`（当前默认 8 路分页窗口，并有请求门控）。默认使用已有的 `.cache/zujuan-sync-profile` 有头 Chrome 会话；只有显式传 `--headless` 才无头。它与 `legacy/zujuan_sync.cjs`/服务共用 `${db}.lock`，不能并行占用同一 SQLite 或 profile。已有 Chrome 调试端口运行时可传 `--cdp-url http://127.0.0.1:9222`（或 `--connect-over-cdp`），脚本通过该已有 context 共享 cookies/session，但始终新建专用采集 tab；连接模式结束只关闭自己新建的 tab，不关闭用户 browser/context。默认遍历章/小节/知识点和全部分页，验收时可用 `--max-catalogs`、`--catalog-id`、`--max-pages` 缩小范围。题目答案/解析固定写入 `answerStatus=not_collected`，列表题干标记 `contentSource=list_api` 与 `contentComplete`，原始接口页保存为 gzip 快照；`--no-download-assets` 可只记录素材 URL。遇到 401/403、JSON 变 HTML 或验证码/滑块时会把窗口置前，等待人工处理并以间隔 probe 同一页，不自动绕过验证。

题库同步任务可按任务选择 `--limit-to-1000-pages`：每个目录最多请求 1000 页，达到边界后将该目录按策略正常结束并继续其他目录；这属于策略内完成，不以网页显示的 `total` 或题目数相等作为验收门槛，也不表示网站全量题目都已抓取。未开启时保持原有分页行为，超过 1000 页会继续请求；`--max-pages` 仍是独立的调试截断参数。

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
- `COLLECTOR_HEADFUL`：部署侧是否显示 Chrome 窗口（`true/false`，默认 `false`）；任务请求不能覆盖此配置。注意 `zujuan_question_sync.cjs` 自身默认有头，`server.cjs` 只在 `true` 时追加 `--headful`、不会追加 `--headless`，因此生产容器里内容任务仍是有头 Chrome 跑在 Xvfb 上；元数据脚本默认无头。
- `COLLECTOR_JOB_TIMEOUT_MS`：单个任务总时限，默认 24 小时；到期后按取消路径终止子进程，任务终态 `interrupted`（有可续采 run）或 `failed`，`errorCode=job_timeout`。
- `COLLECTOR_STALL_TIMEOUT_MS`：停滞判定，默认 20 分钟；子进程在此期间没有任何结构化事件或日志输出即终止，`errorCode=stalled`。人工验证等待期间子进程持续发出 `verification_wait`，不会被判停滞。
- `COLLECTOR_EVENT_CHANNEL`：子进程事件通道，`ipc`（默认，`process.send`）、`stdout`（`@@event {json}` 行，供 CLI 调试）或 `none`。
- `COLLECTOR_CHILD_MAX_RSS_MB`：采集子进程内存上限（MB），默认 0 不启用；子进程随心跳上报 RSS，超限即停止并封存为可续采（`errorCode=memory_limit`）。生产配置 1536（COL-015）。
- 采集节奏（只读部署环境，请求体不能覆盖；不设置则保持 CLI 默认）：
  - `COLLECTOR_LIST_CONCURRENCY`：每个窗口并发的列表 API 页数，默认 8，上限 16。这是对来源站的真实压力，调高前先看下表。
  - `COLLECTOR_ASSET_CONCURRENCY`：素材（题图/公式）预取并发，默认 8，上限 32；只作用于静态素材主机，风险低。
  - `COLLECTOR_DELAY_MIN_MS` / `COLLECTOR_DELAY_MAX_MS`：窗口之间的随机间隔，默认 2500–4000。

  2026-09-07 在服务器隔离测试实例上对同一目录各抓 48 页的实测（生产任务同时在跑，全程无 405/429/验证信号）：

  | 间隔 ms | 列表并发 | 素材并发 | 稳态页/秒 | 约题/秒 |
  | --- | --- | --- | --- | --- |
  | 2500–4000（默认） | 8 | 8 | 2.2 | 22 |
  | 1500–2500 | 8 | 16 | 3.7 | 36 |
  | 1000–2000 | 8 | 16 | 3.6 | 36（间隔再短已无收益，窗口内工作成为瓶颈） |
  | 1500–2500 | 8 | 32 | 3.9 | 39 |
  | 1500–2500 | 12 | 16 | 4.2 | 42 |
  | 1500–2500 | 12 | 32 | 5.2 | 52 |

  素材串行下载时（预取实现之前）线上实测仅 0.35 页/秒；素材预取是最大的一次提升，与列表 API 压力无关。列表并发 12 只做过 48 页短测，整册长时间运行下的风控风险未验证；建议先用 `1500–2500 / 8 / 32` 观察，再决定是否提高列表并发。

### 任务编排与持久化

- 子进程通过结构化事件上报 `run_created`、`progress`、`heartbeat`、`verification_wait`、`error`、`sealed`、`metadata_run_created`、`metadata_summary`；`server.cjs` 不再从日志文本中解析 run 或计数，日志只作为 `logTail` 诊断。`error` 事件带 `code/message/recoverable/failedPages`，`GET /v1/jobs/:id` 的 `errorCode` 与 `errorMessage` 来自该事件，不会被 CLI 的帮助提示覆盖。
- 任务持久化在同一 SQLite 的 `collector_jobs` 表：`active_slot` 唯一索引是跨进程互斥（第二个活动任务得到 409）；重启后前一进程遗留的活动任务被封存为 `interrupted`/`failed`、`errorCode=collector_restarted`，对应 run 同时封存，`GET /v1/jobs/:id` 仍能查到历史任务。
- 直接运行 CLI 时可加隐藏参数 `--events-stdout`，把同样的事件打印为 `@@event` 行。

`service` 必须通过 `BANK_COLLECTOR_URL` 和 `BANK_COLLECTOR_TOKEN`（如启用）连接此 API。即使是本地开发，也先运行 `cd collector && npm start`，再在 service 中设置 `BANK_COLLECTOR_URL=http://127.0.0.1:9110`；默认 loopback collector 不启用 token。API 只接受固定任务类型、服务端允许的教材 ID 和页数上限，不接受 SQL、脚本路径、数据库路径或任意命令。主要接口为：

- `POST /v1/jobs`、`GET /v1/jobs/:id`、`POST /v1/jobs/:id/cancel`；
- `POST /v1/metadata/validate`、`GET /v1/metadata/snapshot`；
- `GET /v1/candidates`、`GET /v1/catalog-progress`；
- `GET /v1/runs/{runId}/snapshot-page`：按 `collection`、`cursor`、`pageSize` 和 `textbookExternalId` 读取一个不可变运行快照页；`collection` 只能是 `catalogs`、`questions`、`questionCatalogs`、`tags` 或 `assets`，响应会受行数和字节上限约束，并返回 `nextCursor`；
- `GET /v1/runs/{runId}/assets/{sha256}`：按素材 SHA-256 和可选的 `textbookExternalId` 下载素材字节；collector 会校验快照归属、路径安全性、文件大小及实际 SHA-256 后才开始传输；
- `GET /health` 用于无敏感信息存活检查，`GET /v1/health` 需要认证。

## 独立部署边界

`collector` 自持 `data/` 和 `.cache/`，独立部署时应对这两个目录做持久化。`service` 不挂载 collector SQLite，`collector` 也不连接 MySQL；service 只通过上述 HTTP API 分页读取已封存快照。素材不会把 collector 宿主路径交给 service：collector 通过 `/assets/{sha256}` 传输经校验的字节，service 再校验 SHA-256 并保存到自己的 `BANK_ASSET_ROOT`（生产 Compose 使用持久化的 `/app/runtime/bank`）。
