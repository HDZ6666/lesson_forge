# 教案生成插件

当前版本 `0.2.0`，迁移001～003。产品规则以[重构实施规格](../../../docs/重构实施规格.md#8-教案选题与编辑)为准，验证及交付状态只维护在[实施任务清单](../../../docs/实施任务清单.md)。

## 当前代码入口

- `controller/editor_controller.py`：`/lesson/plan` 下的草稿创建、详情、候选、条件、fill/pick/replace、命令、复制、删除、素材和 Word。沿用既有权限，草稿还核对创建者/管理员；素材必须属于可访问快照。
- `service/editor_filter.py`：正式教材范围、启用目录展开、当前可用事实、严格筛选和有界匹配。计数与候选共用谓词，未知字段按显式条件排除，不自动放宽。
- `service/editor_service.py`：草稿revision与请求去重、分组/条件归属、手选/局部配题/换题、移动排序、移出撤销、历史分页。选入时保存题干及必要素材；正式题库更新不会替换已选快照。
- `entity/vo/editor_vo.py`：请求契约和有界数量。`migrations/mysql/003_draft_editor.py`：在原四表追加编辑字段，并增加操作去重表。
- `service/word_export.py`：题目版打印模型与DOCX；保留段落、上下标、表格和必要图片，SVG转换需要CairoSVG/libcairo，生产镜像提供中文字体。导出绑定保存revision，缺必要素材明确失败。

旧 `lesson_controller.py`、`lesson_service.py`、DAO及固定环节抽题保留兼容。旧教案在新编辑器只读，复制时使用已有历史快照；缺失快照需明确标注当前内容重建，不冒充当年的题目。旧教学文字和答案不进入新题目预览/导出。

## 素材与撤销保留

`BANK_ASSET_ROOT/lesson/snapshots` 按内容摘要保存不可变必要素材。`LESSON_UNDO_MINUTES` 默认30；操作请求摘要和结果墓碑长期保留，撤销过期不会再次执行原操作。草稿软删除仍保留条目与素材，不影响已经开始的导出。

离线清理先停止Service和Collector写入，在使用部署环境的service目录执行：

```bash
python -m plugins.lesson.service.snapshot_maintenance
python -m plugins.lesson.service.snapshot_maintenance --apply --quiesced --grace-days 7
```

第一条只报告；第二条清除过期的大体积撤销载荷及超过保留期的无引用教案素材。所有草稿/历史条目及有效撤销引用受到保护；不清理题源快照、问题证据或请求墓碑。Service运行中不可执行实际清理。

验证入口：`python -m pytest tests/plugins/lesson`，编辑流程在 `test_draft_editor.py`；MySQL隔离运行方法见任务清单。整套备份/恢复使用仓库 `scripts/refactor_backup.py`，默认仅允许本地重构环境和独立恢复目标。
