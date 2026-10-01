# 采集进度存储与进程退出修复

保留为当前代码的运行约束参考，2026-10-01 静态核对了缓存、落库节奏、容器配置与退出实现。新自动同步需求见[实施规格](重构实施规格.md)，实际验证和后续改造见[任务清单](实施任务清单.md)；下面的验证命令不表示本轮全部运行过。

关键入口：[实时缓存](../service/plugins/bank/service/live_progress_cache.py)、[任务运行服务](../service/plugins/bank/service/sync_run_service.py)、[容器启动器](../collector/container-entrypoint.cjs)、[生产 Compose](../deploy/production/docker-compose.yml)。

## 数据边界

- MySQL 保留任务配置、身份、状态、计数和同步验收结果。实时目录树不再写入 `qb_sync_job.options_json`。
- SQLite 继续保存真实的目录、页级进度、题目和运行快照；Redis 不是恢复或同步的可信数据源。
- 实时展示使用 Redis 短期缓存（15 秒 TTL）与有界进程缓存，缓存失效后通过采集 API 重建，同进程并发请求合并。
- 计数变化最多每 5 秒落库一次；没有变化时每 10 秒续写心跳，低于现有 30 秒失联阈值。关键状态/教材切换立即写，最终范围计数不受节流阻挡。
- 对正在执行且已获取新实时投影的旧任务，锁定任务行后只移除旧实时字段一次，保留分页开关、续采配置及其他选项。历史终态任务暂不自动清理，原有回退数据显示仍兼容。
- 缓存/采集 API 不可用时标记 `progressStale`，保留数据库已保存的值，不伪造零进度。审阅基线与题目排除表不变。

## 容器退出

- 使用 `deploy/production/collector.Dockerfile` 中的新启动命令 `node container-entrypoint.cjs`，不能仅复制业务 JS 后继续运行旧的 `Xvfb ... & exec node` 命令。
- Compose 设置 `init: true` 和 `stop_grace_period: 90s`；单独 `docker run` 的测试采集器也必须使用 `--init --stop-timeout 90`。
- 启动器自行 spawn 并等待 Xvfb/API，两者均可被正确回收。Xvfb 使用 `-displayfd` 选择可用显示号，确认就绪后将实际 `DISPLAY` 传给 API；不盲删旧的 X99 锁。
- 浏览器有头/无头策略此次保持原样，包括元数据采集的有头回退，不能因配置中有 `HEADFUL=false` 就移除 Xvfb。
- 管理器停止接单，发停止信号并等待子进程真正退出及快照结算，再释放占用和关闭数据库。用户取消仍为取消，部署中断仍按可续采数据决定 interrupted/failed。
- 内部采集停止宽限 60 秒，外层 API 宽限 75 秒，随后最多 5 秒关闭 Xvfb；外部容器保留 90 秒。强制清理只针对任务后代，Linux 使用 PID 与启动时间防止误伤 PID 复用后的进程。
- Xvfb 启动失败不启动 API；运行中退出会关闭 API并返回失败。init 负责回收被收养的孤儿后代。

## 本地验证

```sh
cd service
.venv/bin/python -m pytest tests/plugins/bank/test_progress_storage.py tests/plugins/bank/test_sync_run_service.py tests/plugins/bank/test_sync_task_service.py tests/plugins/bank/test_question_review_service.py tests/plugins/bank/test_question_apply_service.py -q
```

在仓库根目录：

```sh
node --test collector/tests/*.test.cjs
node --test pc/tests/plugins/bank/*.test.js
docker build -t lesson-collector-lifecycle-test:local -f collector/tests/lifecycle.Dockerfile collector/tests
docker run --rm --init --shm-size=512m --mount "type=bind,src=$PWD/collector,dst=/work,readonly" lesson-collector-lifecycle-test:local node --test tests/container_lifecycle.test.cjs
```

容器验证使用本地 Chromium 和合成页面，不访问题库来源网站，不连接线上数据库。正式上线时须同时更新正式与测试采集容器；binlog 保留配置和历史日志清理不包含在本次代码变更中。
