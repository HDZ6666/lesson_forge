# collector

接手见[文档入口](../docs/README.md)，目标行为见[实施规格](../docs/重构实施规格.md)，当前状态见[任务清单](../docs/实施任务清单.md)。本文描述已有代码入口；历史故障证据保留在[归档](../docs/archive/采集端实际问题.md)，不能替代当前验收。来源为无需登录的公开页面/接口，匿名会话和访问保护不等于登录要求。

2026-10-01 已合并原《题库同步脚本说明》的有效内容；此后采集运行说明只维护本页。无人值守调度、来源冷却和部分成果自动入库仍按实施规格推进，不能从现有轮询或重试推导这些功能已经完成。

组卷网采集工程，与 `pc/`、`service/` 并列。只把公开题库页面写入本目录的 SQLite 和本地素材，**不写 MySQL**。正式入库由 Service 的任务应用或离线 Publisher 负责；素材传输到后端自己的存储，当前不以 MinIO 为必需条件。

## 目录

```
collector/
  server.cjs                   HTTP API 入口（实现在 src/api/）
  zujuan_question_sync.cjs     题库内容采集 CLI 入口（实现在 src/jobs、src/cli）
  zujuan_metadata_sync.cjs     版本 / 教材发现 CLI 入口（实现在 src/jobs、src/cli）
  qbpkg.cjs                    离线包构建（兼容的离线发布路径）
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

需要本机 Node 22.5+ 和已安装的 Google Chrome。以下命令供按需选择，本轮文档整理未运行采集。

```bash
cd collector
npm ci
npm test
npm run check:undeclared        # 搬迁类改动后的未声明标识符扫描（依赖 ../pc/node_modules/acorn）
npm start
```

直接调试在另一个终端进入 `collector`，使用独立的 SQLite、素材目录和浏览器配置；以下两条采集命令是可选方式，不要同时执行：

```bash
node zujuan_question_sync.cjs --help
node zujuan_question_sync.cjs --textbook-id 260617 --max-catalogs 1 --max-pages 1 \
  --db data/manual-probe.sqlite3 --data-dir data/manual-probe \
  --profile-dir .cache/manual-probe-profile
# 若已有采集匿名会话的 Chrome 在 9222 运行，可复用该浏览器而不关闭它
node zujuan_question_sync.cjs --cdp-url http://127.0.0.1:9222 \
  --textbook-id 260617 --max-catalogs 1 --max-pages 1 \
  --db data/manual-probe.sqlite3 --data-dir data/manual-probe
```

限目录/限页是调试范围，不能将其结果解释为全册覆盖。CDP 连接会共享已有会话，不能同时让服务任务使用该浏览器。旧页面采集器仍在 `legacy/`，保留 `npm run legacy:sync*` 兼容入口，其参数不能与当前内容采集器混用。

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
- `COLLECTOR_CHILD_MAX_RSS_MB`：采集子进程内存上限（MB），默认 0 不启用；子进程随心跳上报 RSS，超限即停止并封存为可续采（`errorCode=memory_limit`）。历史 COL-015 记录曾设为 1536，当前运行值需检查部署配置。
- 采集节奏（只读部署环境，请求体不能覆盖；不设置则保持 CLI 默认）：
  - `COLLECTOR_LIST_CONCURRENCY`：每个窗口并发的列表 API 页数，默认 8，上限 16；这是现有实现默认值，不是新调度方案的推荐预算。
  - `COLLECTOR_ASSET_CONCURRENCY`：素材（题图/公式）预取并发，默认 8，上限 32；影响素材请求、内存和带宽，也需纳入运行预算。
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

  这组短测只用于解释历史性能变化，不代表当前服务器或整册长期运行能力。本版要求稳定优先，采集节奏应根据来源响应和服务器负载实测调整，不沿用历史提速建议作为默认配置。

### 任务编排与持久化

- 子进程通过结构化事件上报 `run_created`、`progress`、`heartbeat`、`verification_wait`、`error`、`sealed`、`metadata_run_created`、`metadata_summary`；`server.cjs` 不再从日志文本中解析 run 或计数，日志只作为 `logTail` 诊断。`error` 事件带 `code/message/recoverable/failedPages`，`GET /v1/jobs/:id` 的 `errorCode` 与 `errorMessage` 来自该事件，不会被 CLI 的帮助提示覆盖。
- 任务持久化在同一 SQLite 的 `collector_jobs` 表：`active_slot` 唯一索引是跨进程互斥（第二个活动任务得到 409）；重启后前一进程遗留的活动任务被封存为 `interrupted`/`failed`、`errorCode=collector_restarted`，对应 run 同时封存，`GET /v1/jobs/:id` 仍能查到历史任务。
- 直接运行 CLI 时可加隐藏参数 `--events-stdout`，把同样的事件打印为 `@@event` 行。

### 新建、重试与续采

以下描述现有 [任务服务](../service/plugins/bank/service/task_service.py) 的行为，重构后的单本队列按实施规格验收：

- 网页新建：新业务 task、新 Collector job；内容采集为对应教材生成 run。
- 网页重试：新业务任务，重新采集；不是断点续采。
- 网页断点续采：保留业务 task，新 job/run，继承可恢复运行保存的快照和断点。
- CLI 的 `--resume-run-id` 指向已封存的不完整运行，范围必须匹配；完整成功快照不作为不完整续采源，参数以 `--help` 为准。
- Service 已对瞬时中断提供有限自动续采：默认最多 3 次，30/90/300 秒退避，下一次时间持久化在任务选项中；来源阻断/验证不会进入这条自动重试路径。这不能替代全教材周期计划和跨任务来源冷却。
- 后端重启后接续远端轮询不创建新的采集 run；轮询不等于“到时间自动重跑”。

### HTTP 接口

`service` 必须通过 `BANK_COLLECTOR_URL` 和 `BANK_COLLECTOR_TOKEN`（如启用）连接此 API。即使是本地开发，也先运行 `cd collector && npm start`，再在 service 中设置 `BANK_COLLECTOR_URL=http://127.0.0.1:9110`；默认 loopback collector 不启用 token。API 只接受固定任务类型、服务端允许的教材 ID 和页数上限，不接受 SQL、脚本路径、数据库路径或任意命令。主要接口为：

- `POST /v1/jobs`、`GET /v1/jobs/:id`、`POST /v1/jobs/:id/cancel`；
- `POST /v1/metadata/validate`、`GET /v1/metadata/snapshot`；
- `GET /v1/candidates`、`GET /v1/catalog-progress`；
- `GET /v1/runs/{runId}/catalogs`、`GET /v1/runs/{runId}/questions`、`GET /v1/runs/{runId}/questions/{externalId}`：运行范围内的目录、题目分页和单题读取；
- `GET /v1/runs/{runId}/snapshot-page`：按 `collection`、`cursor`、`pageSize` 和 `textbookExternalId` 读取一个不可变运行快照页；`collection` 只能是 `catalogs`、`questions`、`questionCatalogs`、`tags` 或 `assets`，响应会受行数和字节上限约束，并返回 `nextCursor`；
- `GET /v1/runs/{runId}/assets/{sha256}`：按素材 SHA-256 和可选的 `textbookExternalId` 下载素材字节；collector 会校验快照归属、路径安全性、文件大小及实际 SHA-256 后才开始传输；
- `GET /health` 用于无敏感信息存活检查，`GET /v1/health` 需要认证。

`BANK_COLLECTOR_TIMEOUT_SECONDS` 控制 Service 单次 Collector 请求超时。日志尾部用于诊断，运行 ID、计数和错误码以结构化字段为准。

## 独立部署边界

`collector` 自持 `data/` 和 `.cache/`，独立部署时应对这两个目录做持久化。`service` 不挂载 collector SQLite，`collector` 也不连接 MySQL；service 只通过上述 HTTP API 分页读取已封存快照。素材不会把 collector 宿主路径交给 service：collector 通过 `/assets/{sha256}` 传输经校验的字节，service 再校验 SHA-256 并保存到自己的 `BANK_ASSET_ROOT`（生产 Compose 使用持久化的 `/app/runtime/bank`）。

进度缓存、数据库持久化及退出顺序见[采集存储与进程退出说明](../docs/collector-runtime-storage.md)。

## 采集数据及字段原则

- 题目保留来源和外部 ID，同题跨目录保留多对多关系；新增学科后的完整身份范围按实施规格迁移。
- 目录显示父子关系采用嵌套结构，来源原始 parentId 作为证据保存，不混作显示父节点。
- 普通知识目录和知识点请求分别映射 `categoryId`、`catelogTokpointId`；隐藏筛选默认“全部”，避免静默缩小范围。
- 保留题干、完整题型、难度与系数、来源、引用信息、标签、图片/公式引用和原始 gzip。`qdid/qyid` 不是本地字典主键或排序号；规范化正式字段时保留原始代码。
- 题目出现在某查询结果，不等于来源声明该题的固有标签，查询证据与来源声明分别保留。
- 基础同步不额外进行全量筛选归属扫描；答案/解析标记 `not_collected`，不伪造 `detailFetched`。
- 来源 total、唯一题数、出现次数和扫描进度分别统计；失败页或素材记录不应使已成功保存的数据丢失。

## 正式入库与离线发布

现有采集完成本身不触发正式覆盖，正式写入有两条既有路径：

1. Service 任务应用：读取绑定快照，检查完整性、范围和并发状态，传输并核验素材，再写正式表。
2. qbpkg/Publisher：离线包校验、影子表装载、二次校验、数据集切换与回退。

另有受限的 [大快照首次入库工具](../service/plugins/bank/service/large_initial_apply.py)，只支持此前为空的来源题库，不能替代非空库的增量更新。新流程要求的部分合格成果分批自动入库仍属于重构事项，不能用既有工具执行成功代替该项验收。

从 `collector` 目录查询离线工具用法：

```bash
node qbpkg.cjs --help
cd ../service
python -m plugins.bank.publisher.cli --help
```

Publisher 提供 `verify/register/process/publish/rollback/recover/run-pending/cleanup`；数据库参数使用 `BANK_MYSQL_*`，素材使用 `BANK_ASSET_ROOT`。管理端发布请求需要消费者执行，不能仅凭页面提交成功断言生产消费者已部署。

包包含 `manifest.json`、`snapshot.sqlite3`、`diff-report.json`、`validation.json`、`checksums.sha256` 及必要素材。七张业务影子表和 `qb_dataset_meta` 参与数据集切换，`qb_sync_batch` 保留审计；格式背景见[发布包历史设计](../docs/archive/计划2-题库后端前端实现.md)，实际兼容性以当前工具为准。不能给部分数据强行打完整标记，离线发布也不是新普通同步流程的强制步骤。

## 排障与验证

先按 `taskId/jobId/runId` 定位运行，再看具体目录、页结果、原始错误与快照完整性。SQLite ExperimentalWarning、浏览器最小化警告和 CLI 最后一行帮助文字都不能单独证明采集失败原因。

`npm test` 是离线测试入口，不代表生产整册采集成功；容器退出验证见运行存储说明。新问题和实际验证写入[实施任务清单](../docs/实施任务清单.md)对应项及证据，历史复现只查归档，不再维护旧进度台账。
