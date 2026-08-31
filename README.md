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
| Word 题库规范 | [`docs/word/规范.md`](docs/word/规范.md) |
| 题库与抽题设计 | [`docs/简化版题库数据库与教案抽题设计方案.md`](docs/简化版题库数据库与教案抽题设计方案.md) |
| 组卷网同步脚本 | [`docs/题库同步脚本说明.md`](docs/题库同步脚本说明.md) |

## 同步工具与管理端入口

组卷网采集器是 `collector/` 下的独立 Node 服务，不作为 Python 模块导入，也不直接写 MySQL。`service` 通过受控 HTTP API 启动和停止采集任务，并读取有界的候选快照；两个工程不再依赖共享脚本或 SQLite 文件。本地开发仍保留未配置 `BANK_COLLECTOR_URL` 时的同机兼容模式。

题库插件的“同步中心”分两阶段：先刷新版本与教材，再由用户选择教材后提交内容同步。采集结果只进入 `collector/data/zujuan.sqlite3` 候选库，须审核并经发布批次处理后才会进入正式题库。

管理端链路：

```text
pc -> service /bank/sync/*
   -> collector HTTP API /v1/jobs
      -> zujuan_metadata_sync.cjs（版本/教材）
      -> zujuan_sync.cjs --all-catalogs（目录/题目）
      -> collector/data/zujuan.sqlite3
   <- collector HTTP API 候选快照/进度
   -> MySQL 对比/审核/发布批次
```

直接调试采集器仍可使用：

```bash
cd collector
npm install
npm test
npm run sync:zujuan -- --acknowledge-source-policy --chapter-id 261314 --max-pages 1 --limit 1 --headful
```

详细参数见同步脚本说明。默认结果写入 `collector/data/zujuan.sqlite3`。
