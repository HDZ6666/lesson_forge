# 教案生成插件

新选题编辑流程的规则、模型和接口见[实施规格第 8 节](../../../docs/重构实施规格.md#8-教案选题与编辑)，状态见[任务清单](../../../docs/实施任务清单.md)。下文描述可复用的旧实现；自动放宽与教学文字模板不属于新流程目标。旧版实施证据见[计划 4 归档](../../../docs/archive/计划4-教案抽题与生成.md)。

现有 `lesson` 只读 `bank` 插件的正式题库表（`qb_textbook`、`qb_catalog_node`、`qb_question`、`qb_question_catalog`、`qb_question_asset`），写入自己的四张表 `lp_scheme`、`lp_pick_rule`、`lp_generation`、`lp_generation_item`，依赖 `python-docx`。版本及迁移声明以 `plugin.yaml` 为准；新草稿格式按规格实施。

当前工作区版本为 0.1.1，已声明 `002_generation_snapshot.py`，增加方案和题目快照；规则和素材路径也随生成记录保存。此处是源码说明，不证明任一运行环境已执行该迁移。旧记录缺快照时仍会回读当前题库，新编辑格式的兼容规则尚需实施。

模块分工：

- `service/templates.py`：课型、环节、默认规则与文字初稿模板（纯数据）。
- `service/pick_engine.py`：确定性抽题（硬过滤、0～3 级放宽、评分、seed 抖动、换题），不访问数据库。
- `service/lesson_service.py`：模拟、生成、重新生成、换题、文字保存、详情与历史。
- `service/word_export.py`：`.docx` 导出，题图从 `BANK_ASSET_ROOT` 嵌入；必要素材缺失/格式错误时返回失败。当前模板仍含教学文字，改成题目版属于本轮增量。
- `controller/lesson_controller.py`：`/lesson/plan/*` 接口，权限前缀 `lesson:plan:`。

导出已使用 `asyncio.to_thread` 执行 Word 构建，复用现有快照素材读取；草稿 revision、双入口选题、严格筛选分页和自由内容分组尚未实现。不要从旧版通过的测试推导这些新功能已经完成。

测试：`.venv/bin/python -m pytest tests/plugins/lesson`。
