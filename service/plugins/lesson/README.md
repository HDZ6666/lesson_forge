# 教案生成插件

计划、规则口径、接口与验收记录见 [计划 4：教案抽题与生成](../../../docs/计划4-教案抽题与生成.md)。

`lesson` 只读 `bank` 插件的正式题库表（`qb_textbook`、`qb_catalog_node`、`qb_question`、`qb_question_catalog`、`qb_question_asset`），只写自己的四张表 `lp_scheme`、`lp_pick_rule`、`lp_generation`、`lp_generation_item`。当前版本 `0.1.0`，依赖 `python-docx`。

模块分工：

- `service/templates.py`：课型、环节、默认规则与文字初稿模板（纯数据）。
- `service/pick_engine.py`：确定性抽题（硬过滤、0～3 级放宽、评分、seed 抖动、换题），不访问数据库。
- `service/lesson_service.py`：模拟、生成、重新生成、换题、文字保存、详情与历史。
- `service/word_export.py`：`.docx` 导出，题图从 `BANK_ASSET_ROOT` 嵌入。
- `controller/lesson_controller.py`：`/lesson/plan/*` 接口，权限前缀 `lesson:plan:`。

测试：`.venv/bin/python -m pytest tests/plugins/lesson`。
