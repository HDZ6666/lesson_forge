# 题库管理插件

目标行为见[实施规格](../../../docs/重构实施规格.md)，进度和验证边界见[任务清单](../../../docs/实施任务清单.md)。本页说明当前源码的接口和配置，保留旧任务应用/审核及离线发布能力；旧审核决定不等于新单本增量入库，也不要求新流程逐题人工审核。

`bank` 是题库的完整全栈插件，版本与迁移声明以 `plugin.yaml` 为准。

管理端菜单包含：

- 学科管理、版本管理、教材管理、目录管理、题目管理；
- 教材浏览和发布批次；
- 同步中心的总览、教材发现、单本同步任务；自动计划和问题处理仍按任务清单实施，旧路由保留兼容；
- 同步教材（最新抓取快照与当前正式版本/教材的全量只读对比）。

## 数据流

```text
来源站点 -> 独立 collector -> 不可变快照
                             ^
                             | HTTP API
service 持久任务 ------------+      同步管理对比/审核
                              |
                    已通过（仅待发布决定）
                              |
                              v
                  .qbpkg -> Publisher -> 发布批次
                              |
                              v
                         MySQL 正式题库
```

独立部署时，同步审核接口通过 collector API 读取候选快照，只写入 `qb_sync_review`。点击“通过”不会直接修改正式题库。正式写入可以通过任务详情的 apply 服务校验后事务性完成，也可以通过可验证的 `.qbpkg` 和 Publisher 影子表发布；两条路径的状态与操作不能混用。

旧题库任务保留 `qb_question_task_review`（012 迁移），用于任务对比基线、排除选择及 revision，旧 apply 仍要求完整成功快照。新单本 v2 使用持久待办、封存核验和后台增量入库：终态自动登记和核验，已封存的合格部分每批最多 100 题短事务合并，坏题保留原因和批次记录。详情只读本地状态及分页结果，不重新计算全库资格；同教材在核验/入库结束前保持预约。既有人工题、禁用决定、可信答案和其他教材关系受保护，缺席不删除。

## 数据表

- 七张正式业务表：版本、教材、目录、题目、题目目录关系、标签、素材；
- `qb_sync_batch` 和 `qb_dataset_meta`：发布批次与数据集切换元数据；
- `qb_sync_review`：候选快照、对比状态与审核决定。
- 任务、教材 scope、教材/题库应用状态与应用历史，以及学科、增量入库/批次、终态核验、可用事实及回填游标；完整定义以当前 ORM 和 plugin.yaml 声明的 001–020 迁移为准，以上列表不是全部表。

MySQL 迁移均使用 InnoDB/`utf8mb4`，采用幂等建表和种子脚本。

## 同步中心约定

- 新任务一次只接受一本教材；旧多本 v1 记录保留真实范围及旧恢复契约。原中心接口保留两个阶段：
  1. “刷新版本与教材”只启动一个元数据任务，一次发现来源中的全部版本和教材；
  2. 内容启动最多提交一个来源教材 ID；新同步任务页从正式教材选择 `textbookId`，由服务端解析固定来源范围并生成单本 v2 待办。
- 元数据任务完成后，教材选择绑定到明确的 `metadataRunId` 快照；刷新元数据不会静默改写用户已经提交的内容任务范围；
- 任务支持持久化进度、有限日志、恢复查询和停止。目录和题目共享同一个任务状态和取消边界，采集结果保留在 collector 的不可变快照中；
- 可保存多个单本待办，领取时才占全局采集执行槽；同教材重复请求返回原待办，等待不会访问 Collector。新题库任务使用其既有 `bank:sync:question:*` 权限，原中心入口沿用 `bank:sync:run`；
- 独立部署通过 `BANK_COLLECTOR_URL` 和 `BANK_COLLECTOR_TOKEN` 连接 collector，令牌不会写入任务记录；
- `BANK_COLLECTOR_TIMEOUT_SECONDS` 控制单次 API 请求超时；候选快照和日志均有服务端上限；
- 大型快照通过 collector 的 `GET /v1/runs/{runId}/snapshot-page` 分页读取，参数为 `collection`、`cursor`、`pageSize`、`textbookExternalId`；service 校验运行封存标记、教材范围、集合计数和游标推进后才合并结果，不把整库或 SQLite 文件搬入 service；
- 素材通过 `GET /v1/runs/{runId}/assets/{sha256}` 按内容摘要传输。collector 校验文件后返回字节，service 再校验 SHA-256，并按 `assets/<前两位>/<sha256>.<扩展名>` 保存到 `BANK_ASSET_ROOT`；生产环境配置为 `/app/runtime/bank`，由 `service_runtime` 持久化，数据库中不得保存 collector 宿主绝对路径；
- `BANK_COLLECTOR_URL` 为必需配置；未配置或不可用时同步、快照和素材操作均失败关闭。服务不会读取 collector 数据库、执行 collector 脚本或持久化 collector 宿主路径；
- 请求参数不能指定脚本、命令、SQL、collector 数据库或任意 collector 文件路径；
- 稳定身份是 `subject_id + source_provider + external_id`；当前只启用已验证的初中数学来源映射；
- 对比状态为 `new/changed/unchanged/conflict`；
- 审核状态为 `pending/approved/rejected/stale`；
- 审核时服务端会重新读取候选并校验 `stagedHash`，防止审核后候选已被替换。

主要接口：

- `POST /bank/sync/question/tasks`：`versionId`、单个 `textbookId`，快速保存/复用待办；
- `GET /bank/sync/question/tasks/{id}`：轻量状态，区分采集、等待、核验、入库及覆盖；
- `POST /bank/sync/question/tasks/{id}/import`、`/import-intake/retry`：重试入库断点或封存核验，复用固定身份；
- `GET /bank/sync/question/tasks/{id}/imports`、`/imports/{importId}/batches`、`/imports/{importId}/issues`：已提交结果分页；
- `POST /bank/sync/run/metadata/start`：同步全部版本与教材元数据；
- `POST /bank/sync/run/content/start`：按 `metadataRunId` 和用户选择的教材 ID 创建一个目录+题目内容任务；
- `GET /bank/sync/run/current`
- `GET /bank/sync/run/list`
- `GET /bank/sync/run/{run_id}`
- `POST /bank/sync/run/{run_id}/cancel`
- `GET /bank/sync/metadata/snapshot`
- `GET /bank/sync/metadata/textbook-overview`：返回抓取侧与当前侧的全量版本/教材树，仅按稳定来源身份标记“新增/已有”；
- `GET /bank/sync/{entity_type}/compare`
- `POST /bank/sync/{entity_type}/review`

`entity_type` 仅允许 `version` / `textbook` / `catalog` / `question`。

原中心内容接口仍需成功的 `metadataRunId` 和单元素 `textbookExternalIds`；新题库任务页只提交正式教材编号，不能指定 Collector 运行、URL、脚本或文件路径。

## 后台保护配置

`BANK_MIN_DISK_FREE_MIB`、`BANK_MIN_MEMORY_FREE_MIB` 分别配置题库存储的可用空间和主机/容器可用内存保留水位。`BANK_SYNC_MAX_PENDING_IMPORTS` 限制新内容派发前未结束入库加待核验/重试核验的积压数量，ready 核验不重复计算。均为非负整数，缺失或 `0` 表示未配置该保护；不预设真实服务器参数。

内容派发遇到低水位或积压时保持原待办、不占执行槽，30 秒后再检查。增量入库在准备/批次安全点遇到资源压力重新排队，释放租约，保留暂存、已提交游标和统计。配置错误不会让有效入库永久失败或悄悄取消保护。

插件启动的单写者标志仅控制即时启动恢复；每个进程都会启动本地派发、入库、可用事实及延迟恢复循环。后端复用 ready 标记重启时也能继续处理；数据库执行槽、租约及所有者检查防止重复执行。自动计划使用同一提交与派发路径，支持动态教材轮次、刷新和部分补采；`BANK_AUTOMATIC_SYNC_ENABLED` 默认为0，开启前需配置部署预算与资源水位。Collector共享请求/教材启动/时长/下载配额及资源配置见[采集程序说明](../../../collector/README.md#共享配额与资源水位)。

## 新版补采与问题处理

公开v2补采创建关联新任务，原任务及日志保留；系统短期恢复沿用当前任务。旧成果缺少可继承的目录/题目/关系时，新任务重新扫描。Collector刷新首屏并用当前边界题ID核对后继续尾段，未连续核对的范围保持不完整，后续循环继续核对。题目质量问题只由同题的合格入库关闭，教材范围问题需匹配的完整扫描证据。任务归档后问题及出现任务仍可查。
