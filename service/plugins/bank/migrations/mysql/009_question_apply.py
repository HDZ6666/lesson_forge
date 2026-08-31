"""Create scope-aware question snapshot application state and history."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

SHOW_INDEX_KEY_NAME = 2
SHOW_INDEX_COLUMN_NAME = 4

_STATE_SQL = """
CREATE TABLE IF NOT EXISTS qb_question_apply_state (
    source_provider          VARCHAR(64) NOT NULL COMMENT '来源提供方',
    external_textbook_id     VARCHAR(128) NOT NULL COMMENT '来源教材 ID（正式 scope）',
    current_task_id          BIGINT DEFAULT NULL COMMENT '当前正式题库任务 ID',
    current_collector_run_id BIGINT DEFAULT NULL COMMENT '当前正式 collector run ID',
    snapshot_hash            CHAR(64) DEFAULT NULL COMMENT '当前 scope 快照规范化摘要',
    state_token               CHAR(64) DEFAULT NULL COMMENT '乐观并发状态 token',
    applied_by               VARCHAR(64) DEFAULT NULL COMMENT '最近应用操作者',
    applied_at               DATETIME DEFAULT NULL COMMENT '最近应用时间',
    create_time              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (source_provider, external_textbook_id),
    KEY idx_qb_question_apply_state_task (current_task_id),
    KEY idx_qb_question_apply_state_run (current_collector_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='正式题库教材 scope 当前快照状态';
"""

_HISTORY_SQL = """
CREATE TABLE IF NOT EXISTS qb_question_apply_history (
    history_id                  BIGINT NOT NULL AUTO_INCREMENT COMMENT '应用历史主键',
    source_provider              VARCHAR(64) NOT NULL COMMENT '来源提供方',
    external_textbook_id         VARCHAR(128) NOT NULL COMMENT '来源教材 ID（正式 scope）',
    task_id                      BIGINT NOT NULL COMMENT '目标题库任务 ID',
    collector_run_id             BIGINT NOT NULL COMMENT '目标 collector run ID',
    snapshot_hash                CHAR(64) NOT NULL COMMENT '目标 scope 快照摘要',
    state_token                  CHAR(64) NOT NULL COMMENT '应用后状态 token',
    action                      VARCHAR(20) NOT NULL COMMENT 'apply/rollback/restore',
    previous_task_id             BIGINT DEFAULT NULL COMMENT '应用前任务 ID',
    previous_collector_run_id    BIGINT DEFAULT NULL COMMENT '应用前 collector run ID',
    previous_snapshot_hash       CHAR(64) DEFAULT NULL COMMENT '应用前 scope 快照摘要',
    change_stats_json            JSON NOT NULL COMMENT '正式表 insert/update/disable/relation/tag/asset 统计',
    applied_by                  VARCHAR(64) DEFAULT NULL COMMENT '应用操作者',
    applied_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '应用时间',
    create_time                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (history_id),
    CONSTRAINT chk_qb_question_apply_history_action
        CHECK (action IN ('apply', 'rollback', 'restore')),
    KEY idx_qb_question_apply_history_scope_time (source_provider, external_textbook_id, applied_at),
    KEY idx_qb_question_apply_history_task (source_provider, task_id),
    KEY idx_qb_question_apply_history_hash (source_provider, snapshot_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='正式题库教材 scope 快照应用历史';
"""

# 009 is still unpublished, so it also carries the small additive projection
# columns needed by the question task status contract.  Existing 006/008 rows
# remain valid through zero/NULL defaults.
_JOB_COLUMNS = {
    'question_catalog_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN question_catalog_count INT NOT NULL DEFAULT 0 '
        "COMMENT '题库快照目录关系数量' AFTER changed_question_count"
    ),
    'question_tag_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN question_tag_count INT NOT NULL DEFAULT 0 '
        "COMMENT '题库快照标签数量' AFTER question_catalog_count"
    ),
    'question_asset_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN question_asset_count INT NOT NULL DEFAULT 0 '
        "COMMENT '题库快照素材数量' AFTER question_tag_count"
    ),
    'snapshot_complete': (
        'ALTER TABLE qb_sync_job ADD COLUMN snapshot_complete TINYINT(1) NOT NULL DEFAULT 0 '
        "COMMENT '题库快照是否完整' AFTER question_asset_count"
    ),
    'snapshot_locked_at': (
        'ALTER TABLE qb_sync_job ADD COLUMN snapshot_locked_at DATETIME DEFAULT NULL '
        "COMMENT '题库快照锁定时间' AFTER snapshot_complete"
    ),
}

_SCOPE_COLUMNS = {
    'question_catalog_count': (
        'ALTER TABLE qb_sync_job_scope ADD COLUMN question_catalog_count INT NOT NULL DEFAULT 0 '
        "COMMENT '该教材快照目录关系数量' AFTER changed_question_count"
    ),
    'question_tag_count': (
        'ALTER TABLE qb_sync_job_scope ADD COLUMN question_tag_count INT NOT NULL DEFAULT 0 '
        "COMMENT '该教材快照标签数量' AFTER question_catalog_count"
    ),
    'question_asset_count': (
        'ALTER TABLE qb_sync_job_scope ADD COLUMN question_asset_count INT NOT NULL DEFAULT 0 '
        "COMMENT '该教材快照素材数量' AFTER question_tag_count"
    ),
    'snapshot_complete': (
        'ALTER TABLE qb_sync_job_scope ADD COLUMN snapshot_complete TINYINT(1) NOT NULL DEFAULT 0 '
        "COMMENT '该教材快照是否完整' AFTER question_asset_count"
    ),
    'snapshot_locked_at': (
        'ALTER TABLE qb_sync_job_scope ADD COLUMN snapshot_locked_at DATETIME DEFAULT NULL '
        "COMMENT '该教材快照锁定时间' AFTER snapshot_complete"
    ),
}

_TAG_RELATION_COLUMN_SQL = (
    'ALTER TABLE qb_question_tag ADD COLUMN relation_type VARCHAR(120) NOT NULL '
    "DEFAULT 'provider_asserted' COMMENT '标签关系类型' AFTER tag_name"
)
_TAG_RELATION_INDEX_SQL = (
    'ALTER TABLE qb_question_tag DROP INDEX uk_qb_question_tag, '
    'ADD UNIQUE KEY uk_qb_question_tag '
    '(question_id, tag_type, tag_name, relation_type, evidence_type)'
)
_TAG_RELATION_INDEX_CREATE_SQL = (
    'ALTER TABLE qb_question_tag ADD UNIQUE KEY uk_qb_question_tag '
    '(question_id, tag_type, tag_name, relation_type, evidence_type)'
)


async def run(query_db: Any) -> None:
    """Create additive state/history tables for question task applications."""

    await query_db.execute(text(_STATE_SQL))
    await query_db.execute(text(_HISTORY_SQL))

    result = await query_db.execute(text('SHOW COLUMNS FROM qb_sync_job'))
    existing_job_columns = {str(row[0]) for row in result.fetchall()}
    for name, statement in _JOB_COLUMNS.items():
        if name not in existing_job_columns:
            await query_db.execute(text(statement))

    result = await query_db.execute(text('SHOW COLUMNS FROM qb_sync_job_scope'))
    existing_scope_columns = {str(row[0]) for row in result.fetchall()}
    for name, statement in _SCOPE_COLUMNS.items():
        if name not in existing_scope_columns:
            await query_db.execute(text(statement))

    result = await query_db.execute(text('SHOW COLUMNS FROM qb_question_tag'))
    existing_tag_columns = {str(row[0]) for row in result.fetchall()}
    if 'relation_type' not in existing_tag_columns:
        await query_db.execute(text(_TAG_RELATION_COLUMN_SQL))

    indexes = await query_db.execute(text('SHOW INDEX FROM qb_question_tag'))
    index_rows = indexes.fetchall()
    relation_index_rows = [
        row
        for row in index_rows
        if len(row) > SHOW_INDEX_COLUMN_NAME and str(row[SHOW_INDEX_KEY_NAME]) == 'uk_qb_question_tag'
    ]
    relation_index_columns = [
        str(row[SHOW_INDEX_COLUMN_NAME])
        for row in sorted(relation_index_rows, key=lambda value: int(value[3]))
    ]
    expected_index_columns = ['question_id', 'tag_type', 'tag_name', 'relation_type', 'evidence_type']
    if relation_index_columns != expected_index_columns:
        await query_db.execute(
            text(_TAG_RELATION_INDEX_SQL if relation_index_rows else _TAG_RELATION_INDEX_CREATE_SQL)
        )
