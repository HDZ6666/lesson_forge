# 教案生成系统

围绕北师大版九年级上册数学题库，先把题目结构化，再按规则抽题、组题、生成教案。当前阶段不生成新题、不生成答案、不生成解析。

项目的三个核心工程为 `pc/`、`service/` 和 `collector/`，可分别安装依赖、启动和部署。

```text
016教案生成系统/
├── pc/                 # 管理端（若依 Vue3，来自 002 模板）
├── mobile/             # 移动端骨架
├── service/            # 后端（若依 FastAPI，来自 002 模板）
├── collector/          # 采集服务（独立 Node 工程，自持 SQLite/素材/浏览器配置）
├── docs/               # 方案、Word 规范与题库源文件
├── back/               # 备份骨架
└── logs/               # 运行日志骨架
```

## 文档入口

完整索引见 [`docs/README.md`](docs/README.md)。

| 内容 | 路径 |
| --- | --- |
| 最新三端进度 | [项目进度总览](docs/sync-task-progress.md) |
| 真实采集问题 | [采集端实际问题](docs/采集端实际问题.md) |
| Word 题库规范 | [`docs/word/规范.md`](docs/word/规范.md) |
| 题库与抽题设计 | [`docs/简化版题库数据库与教案抽题设计方案.md`](docs/简化版题库数据库与教案抽题设计方案.md) |
| 组卷网同步脚本 | [`docs/题库同步脚本说明.md`](docs/题库同步脚本说明.md) |

## 同步工具与管理端入口

组卷网采集器是 `collector/` 下的独立 Node 服务，不作为 Python 模块导入，也不直接写 MySQL。`service` 通过受控 HTTP API 启动和停止采集任务，并读取有界的候选快照；两个工程不依赖共享脚本或 SQLite 文件，`BANK_COLLECTOR_URL` 是必需配置。本地开发也统一使用服务形式：先启动 collector（默认监听 loopback 且不启用 token），再让 service 通过 HTTP 连接。

```bash
cd collector && npm start
```

然后在 service 的环境配置中设置：

```bash
BANK_COLLECTOR_URL=http://127.0.0.1:9110
```

生产部署必须配置 `BANK_COLLECTOR_URL` 和 `BANK_COLLECTOR_TOKEN`；collector 对外绑定非本机地址时也必须配置 `COLLECTOR_API_TOKEN`。

题库插件保留“同步中心”两阶段流程，并提供独立的“同步教材”“同步题库”任务。来源为无需登录的公开页面和接口。采集结果先进入 Collector 候选快照，不自动覆盖正式题库。正式写入有任务应用与离线 qbpkg/Publisher 两条路径；任务应用通过 HTTP 读取完整快照并校验、下载素材后，再事务性写入正式表。

管理端链路：

```text
pc -> service /bank/sync/*
   -> collector HTTP API /v1/jobs
      -> zujuan_metadata_sync.cjs（版本/教材）
      -> zujuan_question_sync.cjs（当前目录/题目入口）
      -> collector/data/zujuan.sqlite3
   <- collector HTTP API 候选快照/进度
   -> 对比、任务应用 / 离线包发布 -> MySQL 正式题库
```

直接调试采集器仍可使用：

```bash
cd collector
npm install
npm test
npm run sync:zujuan:questions -- --help
```

详细参数见同步脚本说明。默认结果写入 `collector/data/zujuan.sqlite3`。
