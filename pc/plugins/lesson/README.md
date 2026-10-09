# 教案生成前端插件

业务规范见[重构实施规格第8节](../../../docs/重构实施规格.md#8-教案选题与编辑)，进度只维护在[实施任务清单](../../../docs/实施任务清单.md)。

- 当前菜单仍为 `/lesson/plan`，由后端 `plugins/lesson/plugin.yaml` 指向 `views/editor/index.vue`。
- `views/editor/index.vue`：选择学科/版本/教材创建草稿；“按教学内容配题”和“直接筛题”共享一份草稿。支持分组和规则编辑、分页候选、已选位置、局部补齐、上下排序、移动归属、换题、移出撤销、保存状态、失败操作重试、分页历史及复制。
- `components/QuestionFilter.vue`：共用目录、题型、难度/易度、年份、地区、额外知识点、小问数量、图片和表格条件。
- `components/QuestionStem.vue`：候选及草稿题干共用白名单渲染和鉴权图片加载；不显示答案、解析或教学引导。
- 网页预览和Word使用已保存revision，分组题与待整理题均按同一顺序输出；关闭存在未保存操作的页面会提示。

原 `views/plan/index.vue`、`api/lesson.js`、`utils/plan.js` 保留旧接口兼容；菜单不再展示旧固定教学环节入口。旧教案在新页面只读，需要编辑时复制成新草稿。

验证：`npm run test:plugin`、`npm run build:prod`；新编辑器的实际登录态交互与Word下载证据见任务清单。
