# 同步教材与同步题库任务模块完成计划

更新时间：2026-08-28

## 1. 目标

在保留现有“同步中心”和 `/bank/sync/run/*` 接口行为不变的前提下，完成两个独立任务模块：

1. **同步教材**：创建一次全量版本/教材采集任务，任务绑定不可变 `metadataRunId`；详情页左侧展示该任务抓取到的全部版本和教材，右侧展示当前正式版本和教材，并标识新增、已有和变化。
2. **同步题库**：创建任务时必须从当前正式数据中选择一个版本和多本教材；Collector 按教材分别采集目录和题目，每本教材绑定不可变 `collectorRunId`；详情页按教材展示抓取快照和当前正式目录/题目的全量对比。

第一阶段只负责采集、保存快照和对比，不直接覆盖或发布到正式题库。正式数据仍通过既有发布批次/qbpkg 流程处理。

## 2. 不可变边界

- 不删除、不替换原同步中心。
- 不改变 `/bank/sync/run/*` 的公开请求和响应契约。
- 重试必须创建新任务，旧任务和旧快照保持不变。
- Collector 运行进入 `completed`、`failed`、`cancelled` 等终态后，运行快照不可修改。
- 远程 Collector 的 URL、命令、脚本路径由 Service 配置控制，不允许前端提交。
- 同步题库只接受当前正式版本和属于该版本的正式教材 ID。
- 所有列表和对比接口必须服务端分页；不得依赖浏览器一次载入全部题目。
- HTML 题干、答案和解析只能经过现有安全渲染工具展示。
- 已执行的 004、005 migration 内容必须恢复并保持专用库记录的 SHA256；新变化只允许放入 006 或后续 migration。

## 3. 恢复执行时基线

以下表格记录 2026-08-28 恢复历史会话时的状态，用于说明剩余工作来源；实时结果以 `docs/sync-task-progress.md` 为准。

| 模块 | 已存在 | 当前主要缺口 |
|---|---|---|
| PC | 两个任务列表、详情、双栏对比、API 调用、详情兜底路由 | Service 接口尚不可用；同步题库无菜单；最新源码未生产构建；仅静态测试 |
| Service | 006 草稿、ORM/VO/DAO、CollectorClient、`SyncTaskService` 草稿 | Controller 未注册；`_create_job` 契约不兼容；scope 未完整持久化/轮询；测试和 Ruff 未通过 |
| Collector | 内容快照表、终态写保护、运行快照查询 API、教材 scope | 新能力缺少自动化测试；真实内容采集和多教材生命周期未验收 |
| 验收环境 | MySQL/Redis 测试容器、已启用的 bank 0.5.0、元数据采集快照 | 006 未应用；源码/安装版本不一致；三端未运行；没有内容运行快照 |

### 3.1 当前执行状态

| 阶段 | 状态 | 已验证结果 |
|---|---|---|
| Collector 实现 | 完成 | 内容与元数据不可变快照、运行查询 API、多教材 scope；`67 passed` |
| PC 实现 | 完成 | 两个任务模块、菜单、权限与详情路由；8 个插件测试文件及生产构建通过 |
| Service 主链路 | 代码审查完成 | 新接口和任务编排已接通，交叉审计 P1 已修复；最近完整结果 bank `138 passed`、全量 `1368 passed, 4 skipped`，最终定点文件 `23 passed` |
| 数据库升级 | 完成 | bank 0.6.0，006 已应用；二次 dry-run 确认 001–006 校验值一致且无菜单冲突 |
| 三端启动 | 完成 | PC 8080、Service 9099、Collector 9110 均已启动且存活检查通过；真实任务和 UI 流程按用户要求留作手工验证 |

> 2026-08-28 范围调整：用户取消主 agent 的浏览器点击、真实任务及最终全量回归，要求代码审查完成后启动三端即可。当前三端已启动且健康检查通过；业务流程由用户手工验证，详细交接见 `docs/sync-task-progress.md`。

## 4. 冻结的 HTTP 契约

### 4.1 同步教材

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/bank/sync/textbook/tasks` | 创建全量版本/教材同步任务 |
| `GET` | `/bank/sync/textbook/tasks` | 分页查询任务 |
| `GET` | `/bank/sync/textbook/tasks/{taskId}` | 查询任务状态、日志和统计 |
| `GET` | `/bank/sync/textbook/tasks/{taskId}/comparison` | 查询该任务元数据快照和当前正式数据的全量双栏对比 |
| `POST` | `/bank/sync/textbook/tasks/{taskId}/cancel` | 停止运行中的任务 |
| `POST` | `/bank/sync/textbook/tasks/{taskId}/retry` | 以旧任务为来源创建新任务 |

创建请求继续使用 `acknowledgeSourcePolicy`。成功创建后返回完整任务对象，至少包含 `taskId`、`taskNo`、`taskModule`、`status`、`phase`、`progressPercent` 和 `metadataRunId`。

### 4.2 同步题库

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/bank/sync/question/options` | 返回当前正式版本及其正式教材 |
| `POST` | `/bank/sync/question/tasks` | 使用 `versionId` 和 `textbookIds` 创建任务 |
| `GET` | `/bank/sync/question/tasks` | 分页查询任务 |
| `GET` | `/bank/sync/question/tasks/{taskId}` | 查询任务及每本教材 scope 状态 |
| `GET` | `/bank/sync/question/tasks/{taskId}/catalog-comparison` | 查询指定教材的抓取目录和当前目录对比 |
| `GET` | `/bank/sync/question/tasks/{taskId}/question-comparison` | 服务端分页查询题目对比 |
| `GET` | `/bank/sync/question/tasks/{taskId}/questions/{externalId}` | 查询一道题目的左右详情 |
| `POST` | `/bank/sync/question/tasks/{taskId}/cancel` | 停止任务及远程 Collector job |
| `POST` | `/bank/sync/question/tasks/{taskId}/retry` | 复制原选择范围并创建新任务 |

题库创建请求严格限制为：

```json
{
  "versionId": 1,
  "textbookIds": [1, 2]
}
```

### 4.3 Collector

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/v1/jobs` | 创建 metadata/content 采集任务 |
| `GET` | `/v1/jobs/{jobId}` | 查询任务及 `scopeItems` |
| `POST` | `/v1/jobs/{jobId}/cancel` | 停止任务 |
| `GET` | `/v1/runs/{runId}/catalogs` | 分页读取运行目录快照 |
| `GET` | `/v1/runs/{runId}/questions` | 分页、筛选读取运行题目快照 |
| `GET` | `/v1/runs/{runId}/questions/{externalId}` | 读取运行题目详情快照 |

每个题库 scope 至少返回：教材外部 ID、`collectorRunId`、状态、目录数、题目数、错误信息和开始/结束时间。

## 5. 并行工作包

### A. Collector（子 agent）

- 审核运行快照建表、升级兼容和终态不可变触发器。
- 审核运行目录、题目列表、题目详情 API 的认证、参数边界、404/409 错误和分页契约。
- 确认多教材任务的 `scopeItems`、每本教材 `collectorRunId`、统计、取消和失败状态正确。
- 确认 `COLLECTOR_HEADFUL` 只能由部署配置控制。
- 为新快照写入、读取、筛选、终态不可变、认证和多教材 scope 增加自动化测试。
- 执行 Node 语法检查和完整 `npm test`。
- 不修改 `pc/`、`service/` 和主进度文档。

### B. Service（子 agent）

- 注册全部同步教材和同步题库 Controller 路由、权限、限流和日志。
- 将 `SyncTaskService` 与 `SyncRunService` 正式接通；扩展 `_create_job` 时保持旧调用兼容。
- 持久化 `taskModule`、来源/重试关系、创建选项和每本教材 scope。
- 正确轮询远程 Collector job，把 `collectorRunId`、统计和错误同步到 scope 与任务。
- 完成创建、列表、详情、停止、重试新任务以及服务重启后的恢复逻辑。
- 教材任务绑定本次 metadata 快照；题库任务只能解析正式版本/教材和有效外部 ID。
- 完成目录/题目与正式 MySQL 数据的稳定标识对比和服务端分页。
- 修复缺失导入、旧同步测试回归和 Ruff 问题。
- 为新 Controller、任务编排、scope、取消、重试和对比增加测试。
- 不修改 `collector/`、`pc/`、`plugin.yaml` 和主进度文档。

### C. PC 与插件菜单（子 agent）

- 审核前端 API 与本文件冻结契约一致。
- 完成同步教材任务创建、任务列表、轮询、取消、重试和双栏全量展示。
- 完成同步题库版本单选、教材多选、任务列表、教材 scope、目录/题目分页与详情对比。
- 增加“同步题库”菜单，规范两个任务菜单 routeName、排序和权限。
- 补充任务查询、新增、停止、重试所需权限，同时保留旧权限兼容。
- 补充以响应契约和用户交互为核心的前端测试。
- 执行插件测试和生产构建，确认最新源码进入 `dist`。
- 只修改 `pc/` 和 `service/plugins/bank/plugin.yaml`；不修改 Service Python 和 Collector。

### D. 主 agent

- 维护本计划和 `docs/sync-task-progress.md`，记录每个工作包的完成、阻塞和验证结果。
- 审核所有子 agent 代码，不以子 agent 自报完成作为验收依据。
- 统一三端字段、状态机、分页、权限、错误响应和取消/重试语义。
- 修复跨目录契约问题及子 agent 未覆盖的问题。
- 执行完整自动化测试、迁移、HTTP/数据库联调和受控真实采集；整理 UI 手工验收清单交由用户点击验证。
- 最终确认原同步中心没有回归。

## 6. 主 agent 验收顺序

1. 审核 Collector、Service、PC/插件三路变更和测试。
2. 执行静态检查：Node 语法、Python 编译、Ruff、前端测试。
3. 先确认 004/005 与数据库历史校验值一致，再在专用 MySQL 应用 006，确认重复执行安全，并确认插件从 0.5.0 升级至 0.6.0。
4. 确认 bank 保持启用状态，启动 Collector、Service、PC。
5. 通过真实 HTTP 请求创建“同步教材”任务：验证任务记录、日志、`metadataRunId` 和版本/教材全量对比响应。
6. 通过真实 HTTP 请求创建“同步题库”任务：验证每本教材 scope、目录对比、题目分页筛选和题目详情响应。
7. 对运行中任务执行停止；对终态任务执行重试，确认生成新任务且旧任务/快照不变。
8. 回归 `/bank/sync/run/*` 旧接口，并提供同步教材、同步题库和原同步中心的 UI 手工验收清单；浏览器点击由用户执行。
9. 保留三端验收进程、可复核的数据库任务记录和测试结果，便于用户直接打开页面验证。

## 7. 必须通过的命令

```bash
cd collector
npm test

cd ../service
PYTHONDONTWRITEBYTECODE=1 .venv/bin/pytest -q -p no:cacheprovider tests/plugins/bank
.venv/bin/ruff check plugins/bank tests/plugins/bank \
  --extend-exclude plugins/bank/migrations/mysql/004_sync_job_compat.py \
  --extend-exclude plugins/bank/migrations/mysql/005_sync_job_v2.py
.venv/bin/ruff format --check plugins/bank tests/plugins/bank \
  --extend-exclude plugins/bank/migrations/mysql/004_sync_job_compat.py \
  --extend-exclude plugins/bank/migrations/mysql/005_sync_job_v2.py

cd ../pc
npm run test:plugin
npm run build:prod
```

需要额外执行 Service 全量测试；如果仓库已有与插件升级、启停、菜单或浏览器相关的验收脚本，也必须一并通过。

## 8. 完成定义

只有同时满足以下条件，目标才可标记完成：

- 三端冻结接口完全一致，不存在前端已调用但 Service 未注册的路径。
- 006 已在专用验收库成功应用，任务表和 scope 表结构正确。
- 同步教材、同步题库的创建、查看、停止和重试 HTTP 链路均通过；UI 点击由用户按交付清单手工确认。
- 教材元数据快照与题库内容快照都绑定到具体任务，终态后不可变。
- 双栏比较使用稳定来源标识，并正确区分新增、已有和变化。
- 自动化测试、静态检查和生产构建全部通过。
- 已完成至少一次受控真实采集及 HTTP/数据库验收；浏览器点击不属于主 agent 本轮完成条件。
- 原同步中心及 `/bank/sync/run/*` 回归验证通过。
- `docs/sync-task-progress.md` 已记录最终命令、结果、已知限制和验收时间。
