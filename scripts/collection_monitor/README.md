# 学科采集监测（服务器侧）

用途：记录整个学科轮次发生过什么，区分采集防护、资源门槛、人工停止、入库失败和慢接口。与业务进程分开运行；不会创建采集任务、恢复来源控制、访问来源网站、重启容器或修改业务数据库。只向自己的 `/var/lib/lesson-forge-monitor` 写入监测数据。依赖服务器 Python 3.10+、Docker；容器内复用已有 Python/pymysql 和 Node SQLite。

## 安装与查看

将本目录的 `monitor.py`、`mysql_probe.py`、`collector_probe.cjs` 安装到服务器 `/opt/lesson-forge-monitor/`，权限 644、所有者 root；将 `deploy/production/monitor/lesson-forge-monitor.{service,timer}` 安装到 `/etc/systemd/system/`。执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now lesson-forge-monitor.timer
sudo systemctl start lesson-forge-monitor.service
sudo systemctl status lesson-forge-monitor.timer
sudo cat /var/lib/lesson-forge-monitor/report.md
sudo journalctl -u lesson-forge-monitor.service -n 20
```

默认每次结束 60 秒后采样，实际间隔约 64 秒。独立 timer 随服务器启动，与当前 release 无关，不需要暂停采集或重新发布应用。停止监测：`sudo systemctl disable --now lesson-forge-monitor.timer`。timer 的 root 权限用于读取 Docker、容器数据库和内核日志；不新增公网端口。目录 700、输出 600，不纳入项目备份。

## 输出与统计口径

- `latest.json`：最新一次探针结果。仅工作流元数据，不含题干、答案、Cookie、密码或数据库连接配置。
- `report.md` / `report.json`：本轮目标、逐本最新执行结果、正在执行、部分／完整入库、历史异常、慢请求、内核资源故障、最近状态变化。
- `monitor.sqlite3`：每分钟资源 `samples`、只在状态变化时追加的 `events`、当前事件阶段 `states`、长期每小时资源极值 `hourly`。
- 关联后台任务号、Collector 运行号、教材来源 ID、计划／轮次、分页并发、错误代码、阶段、子进程 RSS 峰值。采集器每日预算的使用量、内存／磁盘门槛、容器占用、系统换页累计量和 PSI 随采样保存。
- 同一暂停的重复检查不会累计为多次故障；从“暂停”变“恢复”时记录上一个状态持续时间。首次读取只建立基线，不假装从那时开始发生故障。终止事件按 Collector run 去重；正常 SIGTERM／人工停止与防护分开。
- 防护间隔只统计已确认的题目运行防护终止；历史教材发现错误单列。`waitingSince` 存在时采用首次等待时间，否则采用同类型错误时间／终止记录，并标注 `timeBasis`。间隔包含不采集的时间，不能解释为网站固定封禁周期。一分钟内发生又恢复、且未留持久化错误的验证可能无法捕获。
- 全轮统计按每本教材最新执行；包含本轮自动任务及轮次开始后关联同计划的单本手动任务，独立统计“部分入库”。“轮次处理结束”不等于“全部完整入库”。MySQL 的轮次/入库时间为 UTC；旧任务开始/创建时间按部署时区 Asia/Shanghai 解读，Collector 带时区时间直接转换。
- 资源数据是采样值，历史没有记录的故障时刻精确内存不能补造；两次采样间的瞬时尖峰也可能漏掉。保留实际故障记录 + 前后采样，并区分时刻和观察时刻。宿主机水位与容器健康接口水位同时保留，不将主机数值冒充受限 cgroup 数值。
- 慢接口阈值 3 秒，另收集 5xx；排除正常 101 WebSocket 长连接，并隐藏人工浏览器临时访问 token。Nginx 每轮最多读取 5000 行，超出明确记录截断；只能读取当前容器仍保留的日志。采样失败也会记录，不视为正常或恢复。
- 原始分钟采样默认保留 30 天，`--sample-days N` 可调整；小时极值和事件不自动删除，长轮次仍保留全程问题和资源趋势。监测库只保存诊断元数据，不复制 9 GiB 的采集库。全量原始历史日志此次保存于本地忽略目录，服务器没有新建数据库备份。

## 验证

```sh
python3 -m unittest discover -s scripts/collection_monitor -p 'test_*.py' -v
node --check scripts/collection_monitor/collector_probe.cjs
```

离线回放：`python3 scripts/collection_monitor/monitor.py --input latest.json --state-dir /tmp/lesson-monitor-replay`。不要把生产 `latest.json` 或原始日志加入 Git；对外保存的证据只摘取必要的统计与故障信息。

## 2026-10-12 事件级日志

应用新增两处压缩日志目录：Collector `/data/zujuan/diagnostics`，Service `/app/runtime/logs/bank-events`。`COLLECTOR_DIAGNOSTICS_DIR` / `BANK_DIAGNOSTICS_DIR` 可改目录；未设置时沿用现有生产数据／日志根目录。每条记录是一个独立 gzip member，直接追加到 `events-日期-PID.jsonl.gz`；完整任务输出另存 `job-任务UUID.jsonl.gz`，不受页面 160 行尾部上限影响。日志不自动覆盖，分钟监测记录压缩日志总占用。

字段包括 UTC 时间、eventId、后台 taskId/importId、Collector jobId/runId、请求 requestId、尝试次数、目录/页、白名单参数、HTTP 状态、重试等待时长、错误类型，以及各阶段 spanId/耗时。后台到 Collector 使用同一个 `X-Lesson-Request-Id`。浏览器网络记录覆盖请求开始、结束和失败；列表接口额外保存分类结果、验证发现和成功解析后的恢复事件。页面未显示挑战只记 `verification_page_clear`，不会冒充 API 已恢复。每次防护等待及重试均直接记录，不依赖一分钟轮询。

资源事件保存保护判定值、阈值、该值的采样时刻/年龄，及触发时所在容器的进程 RSS、宿主机内存/Swap。入库按快照摘要、下载、核验、批次读取、素材准备、MySQL 提交分别记录开始/结束、耗时和游标。日志不保存请求/响应正文、Cookie、密码或令牌；仅选定定位参数与响应头。

`diagnostic_reader.py` 在宿主机按文件偏移增量读取 gzip members；异常、重试、验证和入库阶段进入 monitor.sqlite3，成功请求保留在压缩原件并按采样统计数量。只有完整读取的 member 才推进游标，写入中断的尾部留待下一次。游标在监测事务提交后保存，重复读取按 eventId 去重。原始压缩日志读取例子：`gzip -cd events-*.jsonl.gz`。默认使用 Compose 命名卷路径；Docker 数据根目录不同时，给 monitor.py 添加 `--diagnostic-root`。

HTTP 汇总已改为全部 4xx/5xx 或 >=3 秒请求（不含正常 101 长连接）。旧日志缺失部分无法倒补；事件级记录从新版本部署后开始。
