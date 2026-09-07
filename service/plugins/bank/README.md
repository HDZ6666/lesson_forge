# 题库管理插件

最新实现、待办和验证边界见 [后端进度](../../../docs/进度/后端进度.md)。本插件当前有“任务应用”和“离线包发布”两条正式写入路径；下方同步中心的审核决定不等于任务应用。

`bank` 是题库的完整全栈插件，当前版本为 `0.8.1`。

管理端菜单包含：

- 版本管理、教材管理、目录管理、题目管理；
- 教材浏览和发布批次；
- 同步中心（版本/教材元数据、目录/题目内容的选择和审核）；
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

## 数据表

- 七张正式业务表：版本、教材、目录、题目、题目目录关系、标签、素材；
- `qb_sync_batch` 和 `qb_dataset_meta`：发布批次与数据集切换元数据；
- `qb_sync_review`：候选快照、对比状态与审核决定。
- 任务、教材 scope、教材/题库应用状态与应用历史表；完整定义以当前 ORM 和 001–011 迁移为准，以上列表不是全部表。

MySQL 迁移均使用 InnoDB/`utf8mb4`，采用幂等建表和种子脚本。

## 同步中心约定

- 原“同步中心”保持原有单一工作流入口，分成两个由用户主动触发的阶段：
  1. “刷新版本与教材”只启动一个元数据任务，一次发现来源中的全部版本和教材；
  2. 用户在版本分组下用左右穿梭框选择教材后，点击“同步所选教材内容”，只创建一个内容任务。该任务把所选教材作为一个整体范围，由独立 collector 负责采集；不会为每本教材创建独立任务。
- 元数据任务完成后，教材选择绑定到明确的 `metadataRunId` 快照；刷新元数据不会静默改写用户已经提交的内容任务范围；
- 任务支持持久化进度、有限日志、恢复查询和停止。目录和题目共享同一个任务状态和取消边界，采集结果保留在 collector 的不可变快照中；
- 同一时间只允许一个同步任务，启动与停止需要 `bank:sync:run`，任务状态允许任一同步列表权限读取；
- 独立部署通过 `BANK_COLLECTOR_URL` 和 `BANK_COLLECTOR_TOKEN` 连接 collector，令牌不会写入任务记录；
- `BANK_COLLECTOR_TIMEOUT_SECONDS` 控制单次 API 请求超时；候选快照和日志均有服务端上限；
- 大型快照通过 collector 的 `GET /v1/runs/{runId}/snapshot-page` 分页读取，参数为 `collection`、`cursor`、`pageSize`、`textbookExternalId`；service 校验运行封存标记、教材范围、集合计数和游标推进后才合并结果，不把整库或 SQLite 文件搬入 service；
- 素材通过 `GET /v1/runs/{runId}/assets/{sha256}` 按内容摘要传输。collector 校验文件后返回字节，service 再校验 SHA-256，并按 `assets/<前两位>/<sha256>.<扩展名>` 保存到 `BANK_ASSET_ROOT`；生产环境配置为 `/app/runtime/bank`，由 `service_runtime` 持久化，数据库中不得保存 collector 宿主绝对路径；
- `BANK_COLLECTOR_URL` 为必需配置；未配置或不可用时同步、快照和素材操作均失败关闭。服务不会读取 collector 数据库、执行 collector 脚本或持久化 collector 宿主路径；
- 请求参数不能指定脚本、命令、SQL、collector 数据库或任意 collector 文件路径；
- 稳定身份是 `source_provider + external_id`；
- 对比状态为 `new/changed/unchanged/conflict`；
- 审核状态为 `pending/approved/rejected/stale`；
- 审核时服务端会重新读取候选并校验 `stagedHash`，防止审核后候选已被替换。

主要接口：

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

内容任务请求必须提供成功的 `metadataRunId` 和去重后的 `textbookExternalIds`。服务端会再次校验这些教材确实属于该元数据快照且有真实入口章节；客户端不能传入脚本命令、路径或任意采集参数。
