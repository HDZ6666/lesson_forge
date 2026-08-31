-- 同步候选审核记录。
-- 该表只保存候选快照及审核决定；正式题库仍须通过 qbpkg + Publisher 发布。
CREATE TABLE IF NOT EXISTS qb_sync_review (
    sync_review_id       BIGINT NOT NULL AUTO_INCREMENT COMMENT '审核记录主键',
    entity_type          VARCHAR(20) NOT NULL COMMENT 'version/textbook/catalog/question',
    source_provider      VARCHAR(64) NOT NULL COMMENT '来源提供方',
    external_id          VARCHAR(128) NOT NULL COMMENT '来源实体 ID',
    staged_hash          CHAR(64) NOT NULL COMMENT '候选摘要 SHA-256',
    staged_data_json     JSON NOT NULL COMMENT '审核时保存的候选安全快照',
    current_local_id     BIGINT DEFAULT NULL COMMENT '匹配到的正式表本地主键',
    comparison_status    VARCHAR(20) NOT NULL COMMENT 'new/changed/unchanged/conflict',
    review_status        VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/approved/rejected/stale',
    review_comment       VARCHAR(1000) DEFAULT NULL COMMENT '审核意见',
    reviewed_by          VARCHAR(64) DEFAULT NULL COMMENT '审核人',
    reviewed_at          DATETIME DEFAULT NULL COMMENT '审核时间',
    create_time          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (sync_review_id),
    UNIQUE KEY uk_qb_sync_review_identity (entity_type, source_provider, external_id),
    KEY idx_qb_sync_review_status (entity_type, review_status),
    KEY idx_qb_sync_review_hash (staged_hash),
    CONSTRAINT chk_qb_sync_review_entity_type CHECK (entity_type IN ('version', 'textbook', 'catalog', 'question')),
    CONSTRAINT chk_qb_sync_review_comparison_status CHECK (comparison_status IN ('new', 'changed', 'unchanged', 'conflict')),
    CONSTRAINT chk_qb_sync_review_review_status CHECK (review_status IN ('pending', 'approved', 'rejected', 'stale'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题库同步候选审核记录';
