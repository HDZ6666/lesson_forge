"""Persist the current applied textbook snapshot and its audit history.

The tables intentionally do not reference ``qb_sync_job`` with a foreign key:
task deletion has historically been an explicit service operation and old
history must remain readable after a non-current task is removed.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

_STATE_SQL = """
CREATE TABLE IF NOT EXISTS qb_textbook_apply_state (
    source_provider       VARCHAR(64) NOT NULL COMMENT '来源提供方',
    current_task_id       BIGINT DEFAULT NULL COMMENT '当前正式教材快照对应任务 ID',
    current_metadata_run_id BIGINT DEFAULT NULL COMMENT '当前正式教材快照对应 metadata run ID',
    snapshot_hash         CHAR(64) DEFAULT NULL COMMENT '当前正式教材快照规范化摘要',
    applied_by            VARCHAR(64) DEFAULT NULL COMMENT '最近应用操作者',
    applied_at            DATETIME DEFAULT NULL COMMENT '最近应用时间',
    create_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (source_provider),
    KEY idx_qb_textbook_apply_state_task (current_task_id),
    KEY idx_qb_textbook_apply_state_run (current_metadata_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='正式教材当前快照状态';
"""

_HISTORY_SQL = """
CREATE TABLE IF NOT EXISTS qb_textbook_apply_history (
    history_id            BIGINT NOT NULL AUTO_INCREMENT COMMENT '应用历史主键',
    source_provider       VARCHAR(64) NOT NULL COMMENT '来源提供方',
    task_id               BIGINT NOT NULL COMMENT '目标教材任务 ID',
    metadata_run_id       BIGINT NOT NULL COMMENT '目标 metadata run ID',
    snapshot_hash         CHAR(64) NOT NULL COMMENT '目标教材快照规范化摘要',
    action                VARCHAR(20) NOT NULL COMMENT 'apply/rollback/restore',
    previous_task_id      BIGINT DEFAULT NULL COMMENT '应用前任务 ID',
    previous_metadata_run_id BIGINT DEFAULT NULL COMMENT '应用前 metadata run ID',
    change_stats_json     JSON NOT NULL COMMENT '版本与教材变更统计',
    applied_by            VARCHAR(64) DEFAULT NULL COMMENT '应用操作者',
    applied_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '应用时间',
    create_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (history_id),
    CONSTRAINT chk_qb_textbook_apply_history_action
        CHECK (action IN ('apply', 'rollback', 'restore')),
    KEY idx_qb_textbook_apply_history_provider_time (source_provider, applied_at),
    KEY idx_qb_textbook_apply_history_task (source_provider, task_id),
    KEY idx_qb_textbook_apply_history_hash (source_provider, snapshot_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='正式教材快照应用历史';
"""


async def run(query_db: Any) -> None:
    """Create the provider state and append-only application history tables."""

    await query_db.execute(text(_STATE_SQL))
    await query_db.execute(text(_HISTORY_SQL))
    # The collector provider is the only source currently accepted by the
    # textbook task contract.  A pre-created row gives every application a
    # stable row lock even on the first write.
    await query_db.execute(
        text(
            "INSERT INTO qb_textbook_apply_state (source_provider, create_time, update_time) "
            "VALUES ('zujuan', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) "
            "ON DUPLICATE KEY UPDATE source_provider = VALUES(source_provider)"
        )
    )
