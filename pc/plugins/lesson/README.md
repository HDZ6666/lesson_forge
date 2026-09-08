# 教案生成前端插件

页面能力与验收记录见 [计划 4：教案抽题与生成](../../../docs/计划4-教案抽题与生成.md)。

单页 `views/plan/index.vue`：左侧版本/教材与可勾选目录树，中间课型偏好与规则表（模拟候选题量），右侧生成预览（文字可编辑、换一题、重新生成、导出 Word）与历史抽屉。菜单与组件路径由后端 `plugins/lesson/plugin.yaml` 声明。

- `api/lesson.js`：`/lesson/plan/*` 接口；导出与题图走带鉴权头的二进制请求。
- `utils/plan.js`：目录勾选到知识点、规则行与请求体互转、标签文案（纯函数，有 node:assert 测试）。
- `utils/html.js`：题干 HTML 白名单清洗，图片只允许 Blob URL 或本插件素材接口地址。

测试：`npm run test:plugin`（`tests/plugins/lesson/plan.test.js`）。
