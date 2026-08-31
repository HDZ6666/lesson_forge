# 同步任务模块收口进度

更新时间：2026-08-28

## 2026-08-28 恢复执行基线

主会话已重新读取本地 Codex JSONL、当前源码、测试结果和专用验收数据库，并建立持久目标。完整剩余工作、冻结接口、并行分工和完成定义见 `docs/sync-task-completion-plan.md`。

本轮由主 agent 维护本文件并负责最终验收；三个子 agent 使用 `gpt-5.6-luna`、`max` 推理强度，按目录隔离并行实现：

| 工作包 | 负责人 | 状态 | 当前结论 |
|---|---|---|---|
| Collector 快照与接口 | 主 agent 已完成代码审核 | 代码与测试通过，待真实采集 | 主 agent 独立执行全量 Node 语法检查和 67 个测试，全部通过；内容与元数据终态快照均受数据库写保护 |
| Service 任务主链路 | 主 agent 审核，Service 子 agent 实现 | 代码审查完成，服务已启动 | 新 Controller、任务编排、scope、取消、重试、持续恢复和对比接口已接通；交叉审计 P1 已修复 |
| PC 与插件菜单 | 主 agent 已完成代码审核 | 代码与构建通过，PC 已启动 | 8 个插件测试文件和生产构建成功；菜单/API/scope/原同步中心哈希通过，浏览器点击由用户执行 |
| 三端审核与联调 | 主 agent | 代码审查完成 | 006 已应用且幂等；Service 生命周期及 PC–Service–Collector 契约两路交叉审计问题均已处理 |
| 启动与健康检查 | 主 agent | 完成 | PC 8080、Service 9099、Collector 9110 均在监听；三个 HTTP 存活检查通过 |

恢复执行前的只读检查结果：

- Collector：`58/58` 旧测试通过；合成快照烟雾检查通过；新 `/v1/runs/*` 尚无专门自动化覆盖。
- Service：bank 测试 `114 passed, 4 failed`；相关文件 Ruff 有 24 项；新任务 Controller 不存在。
- PC：8 个插件测试文件通过；测试以源码断言为主；最新页面源码晚于当前 `dist`。
- 数据库：bank 源码版本 0.6.0，专用库仍为 0.5.0；`enabled='0'` 在本项目中表示已启用；006 和 `qb_sync_job_scope` 尚未应用。
- 原同步中心文件哈希仍与此前基线一致。
- 历史 migration 漂移：004/005 曾被后续 Ruff 格式化，当前内容校验值与专用库记录不一致；主 agent 已从本地 Codex 会话恢复出精确原内容，待 Service 工作包结束后恢复文件并执行插件升级 dry-run。目标 SHA256 分别为 `bbcb08f4cc04293b419790104e08a66cedeefc0d151b96e332511f16bdaa78d2` 和 `5314d7902ceb9412310883ca6ad623a7bed8086d53e7b6e61e7d9965c5b70e46`。

## 本轮实现与主验收记录

### PC 与插件菜单

- 子 agent：`/root/pc_plugin_completion`。
- 已增加“同步题库”菜单，并为同步教材/题库增加 query、add、cancel、retry 权限；保留旧 list/center/run 兼容。
- 创建教材任务只发送 `acknowledgeSourcePolicy`；创建题库任务只发送 `versionId` 和去重后的 `textbookIds`。
- 修正题库 scope 映射：父任务 `runId` 不再被误当成教材 `collectorRunId`。
- 主 agent 独立复跑 `npm run test:plugin`：8 个测试文件通过。
- 主 agent 独立复跑 `npm run build:prod`：成功，只有第三方 Rollup PURE 注释警告。
- 原同步中心 SHA256 仍为 `3eb9d9e8df6449b1640140d36f5b26efba725b68c02a0d339642f02d41798813`。
- 尚未完成：安装后真实 API 联调；页面创建/停止/重试与详情对比由用户按最终清单点击验收。

### Collector 快照与接口

- 子 agent：`/root/collector_completion`。
- `run_snapshots.cjs` 支持从旧 SQLite 增量升级，并为历史终态运行回填锁定标记；运行记录和三类内容快照表的增删改均有数据库触发器约束。
- 元数据运行也已增加独立版本/教材快照表、历史回填和终态写保护；连续两次采集不会改变旧任务的教材对比结果。
- `/v1/runs/{runId}/catalogs`、`questions`和题目详情已注册，具备认证、服务端分页、教材范围校验、筛选及 404/409 错误语义。
- 多教材 content job 按教材串行采集，每本教材返回独立 `collectorRunId`、统计、时间和错误；单本失败会保留已完成 scope，未开始 scope 不会被误标成成功。
- 取消或子进程异常时会封存遗留的 `running` 快照；`SIGINT`/`SIGTERM` 在采集脚本中落为 `cancelled`。
- `COLLECTOR_HEADFUL` 只能由部署配置控制，任务请求无法覆盖。
- 主 agent 独立执行所有 `.cjs` 的 `node --check`：通过。
- 主 agent 独立执行 `npm test`：`67 passed, 0 failed`。
- 尚未完成：用验收 SQLite 做受控真实题库采集，并由 Service/PC 读取该运行快照。

### Service 任务主链路

- 已注册同步教材与同步题库的创建、列表、详情、停止、重试及三类对比接口，并保留旧 `/bank/sync/run/*` 路由。
- 题库任务只接受当前正式版本及其正式教材；每本教材 scope 独立保存 `collectorRunId`、状态、统计、时间和错误。
- 重试创建新任务，取消会转发到 Collector；服务重启后会恢复未终态任务的远程轮询。
- 教材对比绑定任务的 `metadataRunId`；题库目录、题目列表和题目详情按 scope 的内容运行快照读取。
- 主 agent 独立执行 bank 模块测试：`125 passed`。
- 主 agent 独立执行 Ruff check 与 format check：全部通过；为保持历史 migration 校验值，004/005 明确排除格式化检查。
- 尚未完成：真实进程、真实 Collector 和 HTTP 状态机验收；浏览器交互不再由主 agent 执行。

## 工作分工

- 主 agent：负责冻结三端契约、审核全部实现、修复跨端问题、维护计划/进度文档、统一测试、迁移、HTTP/数据库联调和 UI 手工验收清单。
- Collector 子 agent：`/root/collector_completion`，使用 `gpt-5.6-luna`、`max`，只修改 `collector/`。
- Service 子 agent：`/root/service_completion`，使用 `gpt-5.6-luna`、`max`，只修改 Service Python、迁移和测试，不修改 `plugin.yaml`。
- PC/插件子 agent：`/root/pc_plugin_completion`，使用 `gpt-5.6-luna`、`max`，只修改 `pc/` 和 `service/plugins/bank/plugin.yaml`。

子 agent 的代码必须经过主 agent 审核后才算完成；自动验收以真实 HTTP/数据库/采集链路为准，浏览器点击由用户执行。

## 当前目标

保留原同步中心和 `/bank/sync/run/*`，新增：

- 同步教材任务：抓取全部版本/教材，绑定不可变 `metadataRunId`，与当前正式数据双栏对比。
- 同步题库任务：选择一个正式版本和多本正式教材，抓取目录/题目，按教材绑定不可变 `collectorRunId`，服务端分页对比。
- 第一阶段只采集和对比，不直接写正式题库；题库后续通过 qbpkg/发布批次应用。

## 已落盘内容

### Collector

- `lib/run_snapshots.cjs`：运行快照表和终态不可变触发器。
- `zujuan_sync.cjs`：内容运行写入目录、题目和题目目录关系快照，并输出快照数量。
- `lib/api_store.cjs`：已有运行快照读取函数草稿，包括目录分页、题目分页和题目详情。

收口时必须确认：读取函数已导出、`server.cjs` 已注册 `/v1/runs/*`、`/v1/jobs/:id` 已返回每本教材的 scope/`collectorRunId`，并支持部署侧 headful 配置。

### Service

- `migrations/mysql/006_sync_task_modules.py`：新增任务模块字段、统计字段和 `qb_sync_job_scope`。
- `entity/do/bank_do.py`：已有 `QbSyncJob` 扩展和 `QbSyncJobScope`。
- `entity/vo/bank_vo.py`：已有独立任务请求、状态、scope 和对比查询模型。
- `dao/sync_task_dao.py`：已开始增加任务和 scope 访问方法。
- `service/collector_client.py`：已开始增加运行快照请求方法。

收口时必须确认：Controller、任务编排服务、scope 持久化、重试新任务、全量对比、取消/恢复、菜单和权限全部接通，且旧同步中心契约不变。

### PC

- `plugins/bank/views/sync-textbook/`：任务列表、任务详情、双栏对比。
- `plugins/bank/views/sync-question/`：任务列表、版本单选/教材多选、目录和题目详情对比。
- `plugins/bank/api/bank.js`：新任务接口调用。
- `plugins/bank/utils/sync-task.js`、`sync-question.js`：响应归一化、分页和安全 HTML 对比。
- `src/router/index.js`：详情路由兜底。
- 已修正教材双栏定位优先使用 `sourceProvider + externalId`，并补充 scope 名称/统计字段兼容。
- `tests/plugins/bank/syncTextbookOverview.test.js` 已改为分别校验任务列表和双栏详情；新增 `syncTaskModules.test.js`。

## 验收环境

- MySQL 容器：`lesson-bank-mysql-test`，宿主端口 `33306`。
- Redis 容器：`lesson-bank-redis-test`，宿主端口 `36379`。
- 专用数据库：`ruoyi_sync_tasks_e2e_20260827`。
  - bank 已安装并启用（该项目使用 `enabled='0'` 表示启用），源码及安装版本均为 0.6.0。
  - 006 migration 已成功应用，任务扩展字段、`qb_sync_job_scope`、三个菜单及新增权限均已核对。
  - 004/005 已恢复为数据库历史记录对应的精确 SHA256，006 的 SHA256 为 `2454f4d0e8d0817274a0473051b01aa0ae6db5eacb98f920d5fa51d7ea3929b5`。
  - 当前有 1 个正式版本、1 本教材、220 个目录节点。
- Collector 验收 SQLite：`/tmp/lesson-bank-ui-acceptance/collector.sqlite3`。
  - 已有元数据运行：26 个版本、151 本教材。
  - 该运行已回填为 26 个版本、151 本教材的不可变元数据快照并锁定。
  - 内容运行快照尚未在该库实际产生。
- Collector 验收 Chrome profile：`/tmp/lesson-bank-ui-acceptance/profile`。
- 本地管理员：`admin`；密码只使用本地验收配置，不写入本文件。

## 统一验收顺序

1. 收取并处理 Service 生命周期、三端 HTTP 契约两路只读交叉审计结果。
2. 复核插件升级幂等性，并执行 Service 全量测试。
3. 启动 Collector、Service、PC，Service 指向验收 Collector 和专用 MySQL/Redis；测试配置限制 `maxPages`。
4. 通过真实 HTTP 创建“同步教材”任务，确认脚本调用、`metadataRunId`、任务详情和全量对比响应。
5. 通过真实 HTTP 创建“同步题库”任务，确认目录、题目分页、筛选和左右详情响应。
6. 通过真实 HTTP 停止、重试，并确认重试创建新任务、旧任务不变；回归原同步中心接口。
7. 发现问题后修改并从对应 HTTP 流程重新验证；最终输出 UI 手工验收清单。
8. 最后统一执行：

```bash
cd collector && npm test
cd ../service && .venv/bin/pytest -q && .venv/bin/ruff check . && .venv/bin/ruff format --check .
cd ../pc && npm run test:plugin && npm run build:prod
```

## 历史中间结果（不是最终验收）

- Collector 旧测试曾为 `58 passed`。
- Service 银行测试曾为 `117 passed, 1 failed`，失败是 migration 期望未更新；006 另有 import 排序问题。
- PC 插件测试曾为 `6 passed, 1 failed`，失败是旧教材页面标题断言；主 agent 已调整断言方向。

这些结果不能替代最终三端 HTTP/数据库联调；浏览器点击由用户按交付清单另行验收。

## 2026-08-28 最终交接状态

用户将本轮验收范围收紧为“完成代码审查并启动三端”，取消主 agent 的浏览器点击、真实同步任务和最终全量回归。因此本轮按以下边界交接：

- 关键审查结论：未遗留 P0/P1。元数据与内容快照均按运行 ID 不可变；教材 scope 完整提交后父任务才可完成；题库任务逐教材验证 `collectorRunId`；重启后有持续恢复监视；未分类 `solutionHtml` 不再被伪造成答案和解析两份。
- 主 agent 最后新增本地兼容路径的 fail-closed 校验，防止 scope 写入失败后父任务仍完成；相关 `test_sync_run_service.py` 定点执行 `23 passed`，Ruff check 与 format check 通过。
- 修改前的最近完整结果：Collector `67 passed`；Service bank `138 passed`、Service 全量 `1368 passed, 4 skipped`；PC 8 个插件测试文件通过且生产构建成功。按用户要求，最后一处定点修复后未再执行全量回归。
- 迁移：004、005、006 SHA256 均与数据库记录一致；bank 0.6.0 已安装启用，升级 dry-run 无待执行 migration、结构错误或菜单冲突。
- 当前运行地址：PC `http://127.0.0.1:8080/`，Service `http://127.0.0.1:9099/`，Swagger `http://127.0.0.1:9099/docs`，Collector 健康检查 `http://127.0.0.1:9110/health`。
- 存活结果：PC HTTP 200、Service Swagger HTTP 200、Collector 返回 `ok: true`；Service 启动日志确认 MySQL、Redis、插件 writer 和 bank 插件均就绪。
- 未由主 agent 执行：登录后的动态菜单点击、同步教材/同步题库任务创建、真实采集、停止、重试、双栏详情以及原同步中心页面回归；这些由用户自行验证。

用户手工验证建议顺序：登录后先确认“同步中心 / 同步教材 / 同步题库”三个菜单；创建并完成同步教材任务后查看全量左右对比；再从正式版本/教材创建同步题库任务，逐教材查看目录和题目；最后验证运行中停止、失败任务重试会产生新任务，以及原同步中心仍可进入。

### 运行时问题修复：创建任务返回 `list index out of range`

- 实际堆栈位于公共 `Log` 装饰器，请求尚未进入 `SyncTaskService`，因此本次失败没有创建任务或启动 Collector。
- `bank_controller.py` 使用 postponed annotations，`request: Request` 在运行时表现为字符串；旧日志辅助函数只支持直接类型比较，得到空列表后强取第一个元素而触发 `IndexError`。
- `common/annotation/log_annotation.py` 已兼容直接类型、`Annotated` 和 postponed string annotation；缺少必需类型时改为明确配置错误。
- 新增 `tests/common/test_log_annotation.py`；相关 Controller/任务服务定点回归 `16 passed`，Ruff 与 format check 通过。
- Service 已于 15:15 重启，四个创建/重试装饰路由均确认可识别 `request` 参数，Swagger HTTP 200；PC 与 Collector 未中断。
