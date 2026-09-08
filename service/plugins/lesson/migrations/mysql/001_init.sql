-- 教案生成插件第一版 MySQL schema。
-- lp_* 表只引用 qb_* 的主键，不建外键约束，与题库表保持一致，由应用层校验。

CREATE TABLE IF NOT EXISTS lp_scheme (
    scheme_id             BIGINT NOT NULL AUTO_INCREMENT COMMENT '方案主键',
    scheme_name           VARCHAR(200) NOT NULL COMMENT '方案名称，默认取课题名',
    textbook_id           BIGINT NOT NULL COMMENT '教材主键 qb_textbook.textbook_id',
    lesson_type           VARCHAR(20) NOT NULL DEFAULT 'new' COMMENT '课型：new 新授课，practice 习题课，review 复习课',
    duration_minutes      SMALLINT NOT NULL DEFAULT 45 COMMENT '课时长度（分钟）',
    recent_years          SMALLINT NOT NULL DEFAULT 3 COMMENT '近几年题目优先',
    preferred_province    VARCHAR(50) DEFAULT NULL COMMENT '偏好省份',
    preferred_city        VARCHAR(100) DEFAULT NULL COMMENT '偏好城市',
    preferred_exam_types  JSON DEFAULT NULL COMMENT '偏好考试类型列表',
    prefer_real_exam      CHAR(1) NOT NULL DEFAULT 'Y' COMMENT '真题名校优先：Y 是，N 否',
    remark                VARCHAR(500) DEFAULT NULL COMMENT '备注',
    status                CHAR(1) NOT NULL DEFAULT '0' COMMENT 'sys_normal_disable：0 正常，1 停用',
    create_by             VARCHAR(64) DEFAULT NULL COMMENT '创建者',
    create_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_by             VARCHAR(64) DEFAULT NULL COMMENT '更新者',
    update_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (scheme_id),
    KEY idx_lp_scheme_textbook (textbook_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教案抽题方案';

CREATE TABLE IF NOT EXISTS lp_pick_rule (
    rule_id               BIGINT NOT NULL AUTO_INCREMENT COMMENT '规则主键',
    scheme_id             BIGINT NOT NULL COMMENT '方案主键',
    sort_no               INT NOT NULL DEFAULT 0 COMMENT '规则顺序',
    phase                 VARCHAR(20) NOT NULL COMMENT '教学环节：intro/example/practice/extend/homework',
    rule_name             VARCHAR(200) DEFAULT NULL COMMENT '规则名称',
    catalog_ids           JSON NOT NULL COMMENT '知识点目录主键列表 qb_catalog_node.catalog_id',
    question_count        SMALLINT NOT NULL DEFAULT 1 COMMENT '需要题数',
    question_types        JSON DEFAULT NULL COMMENT '允许题型列表，空为不限',
    ease_min              DECIMAL(5,4) DEFAULT NULL COMMENT '易度系数下限',
    ease_max              DECIMAL(5,4) DEFAULT NULL COMMENT '易度系数上限',
    max_extra_points      SMALLINT NOT NULL DEFAULT 1 COMMENT '允许额外知识点数',
    max_subquestion_count SMALLINT DEFAULT NULL COMMENT '最大小问数，空为不限',
    allow_image           CHAR(1) NOT NULL DEFAULT 'Y' COMMENT '允许含图：Y/N',
    allow_table           CHAR(1) NOT NULL DEFAULT 'Y' COMMENT '允许含表格：Y/N',
    create_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    PRIMARY KEY (rule_id),
    KEY idx_lp_pick_rule_scheme (scheme_id, sort_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教案抽题规则';

CREATE TABLE IF NOT EXISTS lp_generation (
    generation_id         BIGINT NOT NULL AUTO_INCREMENT COMMENT '生成主键',
    scheme_id             BIGINT NOT NULL COMMENT '方案主键',
    seed                  BIGINT NOT NULL COMMENT '抽题随机种子，同种子同数据可复现',
    status                VARCHAR(20) NOT NULL DEFAULT 'ready' COMMENT 'ready 全部满足，partial 存在题量不足的规则',
    rule_snapshot_json    JSON DEFAULT NULL COMMENT '生成时的规则快照',
    summary_json          JSON DEFAULT NULL COMMENT '每条规则的需要数、得到数、放宽级别与提示',
    lesson_json           JSON DEFAULT NULL COMMENT '教案标题、文字部分与环节顺序',
    create_by             VARCHAR(64) DEFAULT NULL COMMENT '创建者',
    create_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_by             VARCHAR(64) DEFAULT NULL COMMENT '更新者',
    update_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (generation_id),
    KEY idx_lp_generation_scheme (scheme_id),
    KEY idx_lp_generation_create_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教案生成结果';

CREATE TABLE IF NOT EXISTS lp_generation_item (
    item_id                   BIGINT NOT NULL AUTO_INCREMENT COMMENT '条目主键',
    generation_id             BIGINT NOT NULL COMMENT '生成主键',
    rule_id                   BIGINT NOT NULL COMMENT '规则主键',
    phase                     VARCHAR(20) NOT NULL COMMENT '教学环节',
    sort_no                   INT NOT NULL DEFAULT 0 COMMENT '环节内顺序',
    question_id               BIGINT NOT NULL COMMENT '题目主键 qb_question.question_id',
    score                     DECIMAL(8,3) DEFAULT NULL COMMENT '排序得分',
    relax_level               TINYINT NOT NULL DEFAULT 0 COMMENT '选中时的放宽级别 0~3',
    matched_catalog_ids       JSON DEFAULT NULL COMMENT '命中的知识点目录主键',
    evidence_type             VARCHAR(30) DEFAULT NULL COMMENT '命中关系证据：provider_asserted 或 query_membership',
    replaced_from_question_id BIGINT DEFAULT NULL COMMENT '换题前的题目主键',
    create_time               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (item_id),
    UNIQUE KEY uk_lp_generation_question (generation_id, question_id),
    KEY idx_lp_generation_item_rule (generation_id, rule_id, sort_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教案生成题目条目';
