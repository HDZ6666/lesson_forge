# 题库管理前端插件

目标行为见[实施规格](../../../docs/重构实施规格.md)，待办和验收边界见[任务清单](../../../docs/实施任务清单.md)。下面描述已有页面基础，不代表新菜单与单本自动同步流程已经完成。

题库管理前端插件提供版本教材、题库浏览、发布批次、同步中心、同步教材任务和同步题库任务入口。菜单和组件路径由后端
`plugins/bank/plugin.yaml` 声明，页面源码放在 `plugins/bank/views` 下。

页面组件：

```text
plugin/bank/textbook/index -> plugins/bank/views/textbook/index.vue
plugin/bank/question/index -> plugins/bank/views/question/index.vue
plugin/bank/batch/index -> plugins/bank/views/batch/index.vue
plugin/bank/sync/index -> plugins/bank/views/sync/index.vue
plugin/bank/sync-textbook/index -> plugins/bank/views/sync-textbook/index.vue
plugin/bank/sync-textbook/detail -> plugins/bank/views/sync-textbook/detail.vue
plugin/bank/sync-question/index -> plugins/bank/views/sync-question/index.vue
plugin/bank/sync-question/detail -> plugins/bank/views/sync-question/detail.vue
```

同步中心采用两阶段交互：

- 点击“刷新版本与教材”只同步一次完整的版本和教材元数据；
- 在版本分组下用左右穿梭框把需要的教材移到右侧，再点击“同步所选教材内容”；
- 每次内容提交只创建一个任务，所选教材的目录和题目在该任务中一起同步，不会自动为每本教材创建任务。

“同步教材任务”独立抓取全部版本和教材，详情只读取任务绑定的 metadataRunId 快照，与当前正式数据进行双栏对比。

“同步题库任务”从当前正式数据中选择一个版本和多本教材，详情按教材读取该任务绑定的 collectorRunId 快照，提供目录树和服务端分页题目对比。采集完成不等于应用或发布；任务详情已提供显式应用操作，由后端校验快照完整性与并发状态后写正式数据。离线发布批次是另一条流程。扫描 100% 可以仍有数据异常，应用资格以服务端返回为准。
