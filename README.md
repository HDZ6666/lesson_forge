# 教案生成系统

面向自己或少量教师备课：先建立后台逐本采集、分批入库和循环补齐的题库，再提供按条件选题、内容分组、网页编辑和 Word 导出。先接入数学，保留其他学科扩展边界；教案只展示题目及必要素材。

项目的三个核心工程为 `pc/`、`service/` 和 `collector/`，可分别安装依赖、启动和部署。

```text
016教案生成系统/
├── pc/                 # 管理端（若依 Vue3，来自 002 模板）
├── mobile/             # 移动端骨架
├── service/            # 后端（若依 FastAPI，来自 002 模板）
├── collector/          # 采集服务（独立 Node 工程，自持 SQLite/素材/浏览器配置）
├── docs/               # 接手文档、历史归档、Word 规范与题库源文件
├── back/               # 备份骨架
└── logs/               # 运行日志骨架
```

## 文档入口

其他模型或开发者接手时，只需从下面三份文档开始。旧方案和进度已归档，不再作为当前实施入口。

| 内容 | 路径 |
| --- | --- |
| 接手顺序与交接提示 | [开发接手入口](docs/README.md) |
| 唯一需求与实施契约 | [重构实施规格](docs/重构实施规格.md) |
| 当前任务与验收证据 | [实施任务清单](docs/实施任务清单.md) |

## 已有同步工具与管理端入口

下面描述重构前已有的代码基础，目标行为与完成状态分别以实施规格和任务清单为准。运行参数见[Collector 运行说明](collector/README.md)，先核对隔离配置。

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

详细参数见 [Collector 运行说明](collector/README.md)。默认结果写入 `collector/data/zujuan.sqlite3`。
