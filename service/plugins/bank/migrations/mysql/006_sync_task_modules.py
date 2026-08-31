"""Add independent textbook/question task modules and durable task scopes.

The migration is deliberately additive.  Rows created by the original sync
centre remain ``center`` tasks and keep using the existing ``run_type``
contract.  The scope table stores immutable task selection metadata and the
collector run identities required to read collector-owned snapshots later.
No foreign keys are used so plugin uninstall/restore tooling can keep its
existing table-order guarantees.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

_JOB_COLUMNS = {
    'task_module': (
        "ALTER TABLE qb_sync_job ADD COLUMN task_module VARCHAR(20) NOT NULL DEFAULT 'center' "
        "COMMENT '任务模块：center/textbook/question' AFTER run_type"
    ),
    'source_task_id': (
        'ALTER TABLE qb_sync_job ADD COLUMN source_task_id BIGINT DEFAULT NULL '
        "COMMENT '题库任务绑定的成功教材任务 ID' AFTER metadata_run_id"
    ),
    'retry_of_run_id': (
        'ALTER TABLE qb_sync_job ADD COLUMN retry_of_run_id BIGINT DEFAULT NULL '
        "COMMENT '重试来源任务 ID；重试始终创建新任务' AFTER source_task_id"
    ),
    'collector_job_id': (
        'ALTER TABLE qb_sync_job ADD COLUMN collector_job_id VARCHAR(64) DEFAULT NULL '
        "COMMENT '远程 collector 任务 ID' AFTER retry_of_run_id"
    ),
    'new_version_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN new_version_count INT NOT NULL DEFAULT 0 '
        "COMMENT '对比得到的新增版本数' AFTER completed_versions"
    ),
    'new_textbook_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN new_textbook_count INT NOT NULL DEFAULT 0 '
        "COMMENT '对比得到的新增教材数' AFTER completed_textbooks"
    ),
    'new_catalog_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN new_catalog_count INT NOT NULL DEFAULT 0 '
        "COMMENT '对比得到的新增目录数' AFTER catalog_count"
    ),
    'changed_catalog_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN changed_catalog_count INT NOT NULL DEFAULT 0 '
        "COMMENT '对比得到的变化目录数' AFTER new_catalog_count"
    ),
    'new_question_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN new_question_count INT NOT NULL DEFAULT 0 '
        "COMMENT '对比得到的新增题目数' AFTER question_count"
    ),
    'changed_question_count': (
        'ALTER TABLE qb_sync_job ADD COLUMN changed_question_count INT NOT NULL DEFAULT 0 '
        "COMMENT '对比得到的变化题目数' AFTER new_question_count"
    ),
}

_SCOPE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS qb_sync_job_scope (
    scope_id                 BIGINT NOT NULL AUTO_INCREMENT COMMENT '任务范围主键',
    run_id                   BIGINT NOT NULL COMMENT 'service 同步任务 ID',
    local_version_id         BIGINT DEFAULT NULL COMMENT '创建任务时的本地版本 ID',
    local_textbook_id        BIGINT DEFAULT NULL COMMENT '创建任务时的本地教材 ID',
    version_name_snapshot    VARCHAR(100) DEFAULT NULL COMMENT '创建任务时的版本名称快照',
    textbook_name_snapshot   VARCHAR(100) DEFAULT NULL COMMENT '创建任务时的教材名称快照',
    source_provider          VARCHAR(64) NOT NULL COMMENT '来源提供方',
    external_version_id      VARCHAR(128) DEFAULT NULL COMMENT '稳定外部版本 ID',
    external_textbook_id     VARCHAR(128) DEFAULT NULL COMMENT '稳定外部教材 ID',
    metadata_run_id          BIGINT DEFAULT NULL COMMENT '绑定的 collector 元数据运行 ID',
    collector_job_id         VARCHAR(64) DEFAULT NULL COMMENT '远程 collector 任务 ID',
    collector_run_id         BIGINT DEFAULT NULL COMMENT '该教材对应的 collector 内容运行 ID',
    status                   VARCHAR(20) NOT NULL DEFAULT 'queued' COMMENT 'queued/starting/running/completed/failed/blocked/cancelled',
    catalog_count            INT NOT NULL DEFAULT 0 COMMENT '该教材快照目录数',
    question_count           INT NOT NULL DEFAULT 0 COMMENT '该教材快照题目数',
    new_catalog_count        INT NOT NULL DEFAULT 0 COMMENT '新增目录数',
    changed_catalog_count    INT NOT NULL DEFAULT 0 COMMENT '变化目录数',
    new_question_count       INT NOT NULL DEFAULT 0 COMMENT '新增题目数',
    changed_question_count   INT NOT NULL DEFAULT 0 COMMENT '变化题目数',
    error_message            VARCHAR(2000) DEFAULT NULL COMMENT '该教材采集错误',
    started_at               DATETIME DEFAULT NULL COMMENT '该教材开始时间',
    finished_at              DATETIME DEFAULT NULL COMMENT '该教材完成时间',
    create_time              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (scope_id),
    UNIQUE KEY uk_qb_sync_scope_identity (run_id, source_provider, external_textbook_id),
    KEY idx_qb_sync_scope_run (run_id, scope_id),
    KEY idx_qb_sync_scope_local_textbook (local_textbook_id, run_id),
    KEY idx_qb_sync_scope_metadata_run (metadata_run_id),
    KEY idx_qb_sync_scope_collector_run (collector_run_id),
    CONSTRAINT chk_qb_sync_scope_status CHECK (status IN ('queued', 'starting', 'running', 'completed', 'failed', 'blocked', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='同步任务教材范围与 collector 运行绑定';
"""


async def run(query_db: Any) -> None:
    """Extend the job table and create the task-scope table when absent."""

    result = await query_db.execute(text('SHOW COLUMNS FROM qb_sync_job'))
    existing = {str(row[0]) for row in result.fetchall()}
    for name, statement in _JOB_COLUMNS.items():
        if name not in existing:
            await query_db.execute(text(statement))

    indexes = await query_db.execute(text('SHOW INDEX FROM qb_sync_job'))
    index_names = {str(row[2]) for row in indexes.fetchall()}
    for name, columns in (
        ('idx_qb_sync_job_module', 'task_module, run_id'),
        ('idx_qb_sync_job_source_task', 'source_task_id'),
        ('idx_qb_sync_job_retry_of', 'retry_of_run_id'),
        ('idx_qb_sync_job_collector_job', 'collector_job_id'),
    ):
        if name not in index_names:
            await query_db.execute(text(f'CREATE INDEX {name} ON qb_sync_job ({columns})'))

    definition = await query_db.execute(text('SHOW CREATE TABLE qb_sync_job'))
    create_sql = str(definition.fetchone()[1])
    if 'chk_qb_sync_job_task_module' not in create_sql:
        await query_db.execute(
            text(
                'ALTER TABLE qb_sync_job ADD CONSTRAINT chk_qb_sync_job_task_module '
                "CHECK (task_module IN ('center', 'textbook', 'question'))"
            )
        )

    await query_db.execute(text(_SCOPE_TABLE_SQL))
