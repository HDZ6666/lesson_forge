-- 题库插件字典种子。
-- 每一条写入都按 dict_type + dict_value 检查，兼容没有全局唯一约束的 sys_dict_data。

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '教材册次', 'qb_volume', '0', 'admin', NOW(), 'admin', NOW(), '题库教材册次'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_volume');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '年级', 'qb_grade', '0', 'admin', NOW(), 'admin', NOW(), '题库年级'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_grade');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '学期', 'qb_term', '0', 'admin', NOW(), 'admin', NOW(), '题库学期'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_term');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '目录节点类型', 'qb_catalog_node_type', '0', 'admin', NOW(), 'admin', NOW(), '题库目录节点类型'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_catalog_node_type');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '题型', 'qb_question_type', '0', 'admin', NOW(), 'admin', NOW(), '题库题型'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_question_type');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '难度', 'qb_difficulty', '0', 'admin', NOW(), 'admin', NOW(), '题库难度'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_difficulty');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '考试类型', 'qb_exam_type', '0', 'admin', NOW(), 'admin', NOW(), '题库考试类型'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_exam_type');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '答案状态', 'qb_answer_status', '0', 'admin', NOW(), 'admin', NOW(), '题库答案获取状态'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_answer_status');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '场景', 'qb_scene', '0', 'admin', NOW(), 'admin', NOW(), '题库场景标签'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_scene');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '分类', 'qb_category', '0', 'admin', NOW(), 'admin', NOW(), '题库分类标签'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_category');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '考法', 'qb_exam_method', '0', 'admin', NOW(), 'admin', NOW(), '题库考法标签'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_exam_method');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '来源特征', 'qb_source_feature', '0', 'admin', NOW(), 'admin', NOW(), '题库来源特征标签'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_source_feature');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '素材类型', 'qb_asset_type', '0', 'admin', NOW(), 'admin', NOW(), '题库素材类型'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_asset_type');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '素材状态', 'qb_asset_status', '0', 'admin', NOW(), 'admin', NOW(), '题库素材下载状态'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_asset_status');

INSERT INTO sys_dict_type (dict_name, dict_type, status, create_by, create_time, update_by, update_time, remark)
SELECT '批次状态', 'qb_batch_status', '0', 'admin', NOW(), 'admin', NOW(), '题库同步发布批次状态'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_type WHERE dict_type = 'qb_batch_status');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '上册', '上册', 'qb_volume', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '教材上册'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_volume' AND dict_value = '上册');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '下册', '下册', 'qb_volume', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '教材下册'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_volume' AND dict_value = '下册');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '六年级', '六年级', 'qb_grade', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '六年级'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_grade' AND dict_value = '六年级');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '七年级', '七年级', 'qb_grade', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '七年级'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_grade' AND dict_value = '七年级');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '八年级', '八年级', 'qb_grade', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '八年级'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_grade' AND dict_value = '八年级');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '九年级', '九年级', 'qb_grade', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '九年级'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_grade' AND dict_value = '九年级');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '上学期', '上学期', 'qb_term', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '上学期'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_term' AND dict_value = '上学期');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '下学期', '下学期', 'qb_term', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '下学期'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_term' AND dict_value = '下学期');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '章节', 'chapter', 'qb_catalog_node_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '章节'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_catalog_node_type' AND dict_value = 'chapter');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '小节', 'section', 'qb_catalog_node_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '小节'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_catalog_node_type' AND dict_value = 'section');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '知识点', 'point', 'qb_catalog_node_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '知识点'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_catalog_node_type' AND dict_value = 'point');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '其他', 'other', 'qb_catalog_node_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '其他目录节点'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_catalog_node_type' AND dict_value = 'other');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '单选题', '单选题', 'qb_question_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '单选题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_question_type' AND dict_value = '单选题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '多选题', '多选题', 'qb_question_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '多选题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_question_type' AND dict_value = '多选题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '填空题', '填空题', 'qb_question_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '填空题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_question_type' AND dict_value = '填空题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '解答题', '解答题', 'qb_question_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '解答题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_question_type' AND dict_value = '解答题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 5, '判断题', '判断题', 'qb_question_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '判断题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_question_type' AND dict_value = '判断题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 6, '其他', '其他', 'qb_question_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '其他题型'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_question_type' AND dict_value = '其他');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '容易', '容易', 'qb_difficulty', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '容易'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_difficulty' AND dict_value = '容易');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '适中', '适中', 'qb_difficulty', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '适中'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_difficulty' AND dict_value = '适中');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '困难', '困难', 'qb_difficulty', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '困难'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_difficulty' AND dict_value = '困难');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '单元测', '单元测', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '单元测'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '单元测');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '阶段检测', '阶段检测', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '阶段检测'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '阶段检测');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '期中', '期中', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '期中'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '期中');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '期末', '期末', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '期末'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '期末');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 5, '开学考', '开学考', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '开学考'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '开学考');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 6, '模拟', '模拟', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '模拟'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '模拟');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 7, '真题', '真题', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '真题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '真题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 8, '学业考', '学业考', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '学业考'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '学业考');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 9, '竞赛', '竞赛', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '竞赛'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '竞赛');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 10, '自主招生', '自主招生', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '自主招生'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '自主招生');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 11, '其他', '其他', 'qb_exam_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '其他考试类型'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_type' AND dict_value = '其他');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '未知', 'unknown', 'qb_answer_status', '', '', 'Y', '0', 'admin', NOW(), 'admin', NOW(), '答案未知'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_answer_status' AND dict_value = 'unknown');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '已获取', 'available', 'qb_answer_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '答案已获取'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_answer_status' AND dict_value = 'available');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '权限受限', 'restricted', 'qb_answer_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '答案受权限限制'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_answer_status' AND dict_value = 'restricted');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '未提供', 'not_provided', 'qb_answer_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '来源未提供答案'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_answer_status' AND dict_value = 'not_provided');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '预习', '预习', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '预习'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '预习');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '作业', '作业', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '作业'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '作业');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '单元测', '单元测', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '单元测'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '单元测');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '阶段检测', '阶段检测', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '阶段检测'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '阶段检测');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 5, '期中', '期中', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '期中'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '期中');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 6, '期末', '期末', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '期末'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '期末');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 7, '开学考', '开学考', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '开学考'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '开学考');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 8, '模拟', '模拟', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '模拟'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '模拟');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 9, '真题', '真题', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '真题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '真题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 10, '学业考', '学业考', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '学业考'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '学业考');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 11, '假期', '假期', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '假期'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '假期');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 12, '竞赛', '竞赛', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '竞赛'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '竞赛');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 13, '自主招生', '自主招生', 'qb_scene', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '自主招生'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_scene' AND dict_value = '自主招生');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '典型题', '典型题', 'qb_category', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '典型题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_category' AND dict_value = '典型题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '压轴题', '压轴题', 'qb_category', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '压轴题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_category' AND dict_value = '压轴题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '同步题', '同步题', 'qb_category', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '同步题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_category' AND dict_value = '同步题');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '课本原题', '课本原题', 'qb_category', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '课本原题'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_category' AND dict_value = '课本原题');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '运算化简', '运算化简', 'qb_exam_method', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '运算化简'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_method' AND dict_value = '运算化简');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '正误判断', '正误判断', 'qb_exam_method', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '正误判断'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_method' AND dict_value = '正误判断');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '最值', '最值', 'qb_exam_method', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '最值'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_method' AND dict_value = '最值');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '规律探究', '规律探究', 'qb_exam_method', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '规律探究'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_method' AND dict_value = '规律探究');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 5, '比较大小', '比较大小', 'qb_exam_method', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '比较大小'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_exam_method' AND dict_value = '比较大小');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '名校', '名校', 'qb_source_feature', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '名校来源'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_source_feature' AND dict_value = '名校');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '公式图片', 'formula_image', 'qb_asset_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '公式图片'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_asset_type' AND dict_value = 'formula_image');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '题目配图', 'question_image', 'qb_asset_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '题目配图'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_asset_type' AND dict_value = 'question_image');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, 'SVG图形', 'svg', 'qb_asset_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), 'SVG图形'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_asset_type' AND dict_value = 'svg');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '其他素材', 'other', 'qb_asset_type', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '其他素材'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_asset_type' AND dict_value = 'other');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '待下载', 'pending', 'qb_asset_status', '', '', 'Y', '0', 'admin', NOW(), 'admin', NOW(), '素材待下载'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_asset_status' AND dict_value = 'pending');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '下载成功', 'downloaded', 'qb_asset_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '素材下载成功'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_asset_status' AND dict_value = 'downloaded');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '下载失败', 'failed', 'qb_asset_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '素材下载失败'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_asset_status' AND dict_value = 'failed');

INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 1, '构建中', 'building', 'qb_batch_status', '', '', 'Y', '0', 'admin', NOW(), 'admin', NOW(), '批次构建中'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'building');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 2, '校验中', 'validating', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次校验中'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'validating');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 3, '已校验', 'validated', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次已校验'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'validated');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 4, '待审批', 'approval_pending', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次待审批'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'approval_pending');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 5, '已批准', 'approved', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次已批准'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'approved');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 6, '发布中', 'publishing', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次发布中'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'publishing');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 7, '已发布', 'published', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次已发布'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'published');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 8, '失败', 'failed', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次失败'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'failed');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 9, '已归档', 'archived', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次已归档'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'archived');
INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, css_class, list_class, is_default, status, create_by, create_time, update_by, update_time, remark)
SELECT 10, '已回退', 'rolled_back', 'qb_batch_status', '', '', 'N', '0', 'admin', NOW(), 'admin', NOW(), '批次已回退'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sys_dict_data WHERE dict_type = 'qb_batch_status' AND dict_value = 'rolled_back');
