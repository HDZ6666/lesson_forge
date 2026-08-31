# 文档中心

本目录存放方案、计划、同步说明和 Word 题库规范。进度结论必须来自当前代码、测试或运行结果，不能由方案文档推断。计划文档中的接口、目录、迁移和命令只有在代码与测试实际存在后，才能改写为已实现。

| 内容 | 入口 | 作用 |
| --- | --- | --- |
| Word 题库规范 | [`word/规范.md`](word/规范.md) | 目录层级、题块字段、文件边界 |
| 题库与抽题设计 | [`简化版题库数据库与教案抽题设计方案.md`](简化版题库数据库与教案抽题设计方案.md) | 抽题规则和业务目标 |
| 题库后端前端计划 | [`计划2-题库后端前端实现.md`](计划2-题库后端前端实现.md) | `bank` 插件、发布包、MySQL 影子表和验收契约 |
| 组卷网同步 | [`题库同步脚本说明.md`](题库同步脚本说明.md) | 独立 `collector` 工程、HTTP API 和采集边界 |
| 同步任务完成计划 | [`sync-task-completion-plan.md`](sync-task-completion-plan.md) | 同步教材/同步题库冻结契约、剩余工作、并行分工和完成定义 |
| 同步任务执行进度 | [`sync-task-progress.md`](sync-task-progress.md) | 当前代码、测试、迁移和联调的事实记录 |

## 当前事实边界

- 当前已实现独立采集器、SQLite 运行库、schema 2 `.qbpkg` build/verify、`bank` 全栈插件和 MySQL 影子表 Publisher。
- 当前验收数据是 220 个目录、2 道题的烟测集；全册采集、素材下载及生产调度/归档仍需部署。
- 第一版发布契约固定为 MySQL 8/InnoDB/一个 schema；七张当前业务表、`qb_sync_batch` 和 `qb_dataset_meta` 的字段边界见计划 2。

## 权威源文件

- 题库 Word：`docs/word/*.docx`，共 7 份，体积大，不提交 Git。
- 采集工程：`../collector/`（独立 Node 服务，包含采集脚本、受控 HTTP API 和测试）。
- 同步运行数据：`../collector/data/` 和 `../collector/.cache/`（SQLite、gzip 原始页、素材、Chrome 配置），不提交。
- 插件实现：`../service/plugins/bank/` 与 `../pc/plugins/bank/`；插件规范参考 `../service/docs/plugin_development.md`。

## 目录约定

项目文档放根目录 `docs/`，端内文档在 `pc/docs/`、`service/docs/`；采集代码和运行数据均封装在 `collector/` 工程内。
