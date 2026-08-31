# collector

组卷网采集工程，与 `pc/`、`service/` 并列。只把公开题库页面写入本目录的 SQLite 和本地素材，**不写 MySQL**。发布进教案系统、以及是否把图片放到 MinIO，要等候选库审核后再做。

## 目录

```
collector/
  zujuan_sync.cjs              题目采集
  zujuan_metadata_sync.cjs     版本 / 教材发现
  server.cjs                   受控 HTTP API 和任务编排
  lib/api_store.cjs            候选快照的只读查询边界
  qbpkg.cjs                    离线包构建（审核发布时用）
  lib/qbpkg/                   qbpkg 实现
  tests/                       Node 测试
  data/zujuan.sqlite3          候选库
  data/zujuan/assets/          题图和公式（同步 MySQL 前放这里）
  data/zujuan/raw/             页面 gzip 快照
  .cache/zujuan-sync-profile   Chrome 专用持久配置
```

默认路径都相对本目录，不再写到仓库根的 `data/`。

## 运行

需要本机 Node 22+ 和已安装的 Google Chrome。

```bash
cd collector
npm ci
npm test
npm start
node zujuan_sync.cjs --catalog-progress --acknowledge-source-policy
node zujuan_sync.cjs --acknowledge-source-policy --headful \
  --version-name 北师大版 --textbook-name 九年级上册
```

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
- `COLLECTOR_HEADFUL`：部署侧是否显示 Chrome 窗口（`true/false`，默认 `false`）；任务请求不能覆盖此配置。

`service` 通过 `BANK_COLLECTOR_URL` 和 `BANK_COLLECTOR_TOKEN` 连接此 API。API 只接受固定任务类型、服务端允许的教材 ID 和页数上限，不接受 SQL、脚本路径、数据库路径或任意命令。主要接口为：

- `POST /v1/jobs`、`GET /v1/jobs/:id`、`POST /v1/jobs/:id/cancel`；
- `POST /v1/metadata/validate`、`GET /v1/metadata/snapshot`；
- `GET /v1/candidates`、`GET /v1/catalog-progress`；
- `GET /health` 用于无敏感信息存活检查，`GET /v1/health` 需要认证。

## 独立部署边界

`collector` 自持 `data/` 和 `.cache/`，独立部署时应对这两个目录做持久化。`service` 不需要挂载 collector SQLite，`collector` 也不需要连接 MySQL。当 `BANK_COLLECTOR_URL` 为空时，`service` 仅为本地开发兼容保留同机脚本/SQLite 模式，正式的分离部署应显式配置 API 地址和令牌。
