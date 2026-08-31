from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
)
from sqlalchemy.dialects.mysql import LONGTEXT

from config.database import Base


class QbTextbookVersion(Base):
    __tablename__ = 'qb_textbook_version'
    __table_args__ = (
        Index('uk_qb_version_provider_external', 'source_provider', 'external_version_id', unique=True),
        Index('idx_qb_version_status', 'status'),
        {'comment': '题库版本当前数据'},
    )

    version_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    source_provider = Column(String(64), nullable=False)
    external_version_id = Column(String(64), nullable=True)
    version_name = Column(String(100), nullable=False)
    source_url = Column(String(500), nullable=True)
    is_new = Column(CHAR(1), nullable=True)
    sort_order = Column(Integer, nullable=False, server_default='0')
    status = Column(CHAR(1), nullable=False, server_default='0')
    last_sync_batch_id = Column(BigInteger, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbTextbook(Base):
    __tablename__ = 'qb_textbook'
    __table_args__ = (
        Index('uk_qb_textbook_provider_external', 'source_provider', 'external_textbook_id', unique=True),
        Index('idx_qb_textbook_version', 'version_id'),
        Index('idx_qb_textbook_status', 'status'),
        {'comment': '题库教材当前数据'},
    )

    textbook_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    version_id = Column(BigInteger, nullable=False)
    source_provider = Column(String(64), nullable=False)
    external_textbook_id = Column(String(64), nullable=True)
    textbook_name = Column(String(100), nullable=False)
    grade = Column(String(20), nullable=True)
    volume = Column(String(20), nullable=True)
    source_url = Column(String(500), nullable=True)
    sort_order = Column(Integer, nullable=False, server_default='0')
    status = Column(CHAR(1), nullable=False, server_default='0')
    last_sync_batch_id = Column(BigInteger, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbCatalogNode(Base):
    __tablename__ = 'qb_catalog_node'
    __table_args__ = (
        Index('uk_qb_catalog_provider_external', 'source_provider', 'external_node_id', unique=True),
        Index('idx_qb_catalog_parent', 'textbook_id', 'parent_id'),
        Index('idx_qb_catalog_status', 'status'),
        {'comment': '题库目录节点当前数据'},
    )

    catalog_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    textbook_id = Column(BigInteger, nullable=False)
    parent_id = Column(BigInteger, nullable=True)
    source_provider = Column(String(64), nullable=False)
    external_node_id = Column(String(64), nullable=True)
    node_name = Column(String(300), nullable=False)
    node_type = Column(String(20), nullable=False)
    source_url = Column(String(500), nullable=True)
    sort_order = Column(Integer, nullable=False, server_default='0')
    status = Column(CHAR(1), nullable=False, server_default='0')
    last_sync_batch_id = Column(BigInteger, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestion(Base):
    __tablename__ = 'qb_question'
    __table_args__ = (
        Index('uk_qb_question_provider_external', 'source_provider', 'external_question_id', unique=True),
        Index('idx_qb_question_grade_term', 'grade', 'term'),
        Index('idx_qb_question_type_difficulty', 'question_type', 'difficulty'),
        Index('idx_qb_question_status', 'status'),
        {'comment': '题库题目当前数据'},
    )

    question_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    source_provider = Column(String(64), nullable=False)
    external_question_id = Column(String(64), nullable=True)
    source_url = Column(String(500), nullable=True)
    source_question_no = Column(String(64), nullable=True)
    source_text = Column(String(500), nullable=True)
    paper_name = Column(String(500), nullable=True)
    academic_year = Column(String(20), nullable=True)
    year = Column(SmallInteger, nullable=True)
    grade = Column(String(20), nullable=True)
    term = Column(String(20), nullable=True)
    province = Column(String(50), nullable=True)
    city = Column(String(100), nullable=True)
    district = Column(String(100), nullable=True)
    school_name = Column(String(300), nullable=True)
    exam_type = Column(String(50), nullable=True)
    question_type = Column(String(100), nullable=True)
    difficulty = Column(String(20), nullable=True)
    difficulty_coefficient = Column(Numeric(6, 4), nullable=True)
    score = Column(Numeric(8, 2), nullable=True)
    content_html = Column(LONGTEXT, nullable=True)
    plain_text = Column(LONGTEXT, nullable=True)
    answer_html = Column(LONGTEXT, nullable=True)
    analysis_html = Column(LONGTEXT, nullable=True)
    answer_status = Column(String(20), nullable=False, server_default='unknown')
    subquestion_count = Column(SmallInteger, nullable=True)
    website_time_text = Column(String(50), nullable=True)
    external_updated_at = Column(DateTime, nullable=True)
    assemble_count = Column(Integer, nullable=True)
    reference_count = Column(Integer, nullable=True)
    reference_papers_json = Column(JSON, nullable=True)
    is_fresh = Column(CHAR(1), nullable=True)
    content_hash = Column(CHAR(64), nullable=True)
    raw_data_json = Column(JSON, nullable=True)
    last_sync_batch_id = Column(BigInteger, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    status = Column(CHAR(1), nullable=False, server_default='0')
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestionCatalog(Base):
    __tablename__ = 'qb_question_catalog'
    __table_args__ = (
        Index(
            'uk_qb_question_catalog',
            'question_id',
            'catalog_id',
            'relation_type',
            'evidence_type',
            unique=True,
        ),
        Index('idx_qb_question_catalog_catalog', 'catalog_id', 'question_id'),
        CheckConstraint(
            "relation_type IN ('query_catalog', 'knowledge')", name='chk_qb_question_catalog_relation_type'
        ),
        CheckConstraint(
            "evidence_type IN ('query_membership', 'provider_asserted')",
            name='chk_qb_question_catalog_evidence_type',
        ),
        {'comment': '题目目录当前关系'},
    )

    relation_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    question_id = Column(BigInteger, nullable=False)
    catalog_id = Column(BigInteger, nullable=False)
    relation_type = Column(String(30), nullable=False, server_default='query_catalog')
    evidence_type = Column(String(30), nullable=False, server_default='query_membership')
    sort_order = Column(Integer, nullable=False, server_default='0')
    last_sync_batch_id = Column(BigInteger, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestionTag(Base):
    __tablename__ = 'qb_question_tag'
    __table_args__ = (
        Index(
            'uk_qb_question_tag',
            'question_id',
            'tag_type',
            'tag_name',
            'relation_type',
            'evidence_type',
            unique=True,
        ),
        Index('idx_qb_question_tag_type', 'tag_type', 'tag_name'),
        CheckConstraint(
            "evidence_type IN ('query_membership', 'provider_asserted')",
            name='chk_qb_question_tag_evidence_type',
        ),
        {'comment': '题目标签当前关系'},
    )

    tag_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    question_id = Column(BigInteger, nullable=False)
    tag_type = Column(String(30), nullable=False)
    tag_name = Column(String(100), nullable=False)
    # The collector distinguishes tag relationships (for example knowledge
    # facets versus provider labels). Keep that provenance in the formal row
    # instead of collapsing otherwise equal labels during apply/rollback.
    relation_type = Column(String(120), nullable=False, server_default='provider_asserted')
    evidence_type = Column(String(30), nullable=False, server_default='provider_asserted')
    sort_order = Column(Integer, nullable=False, server_default='0')
    last_sync_batch_id = Column(BigInteger, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestionAsset(Base):
    __tablename__ = 'qb_question_asset'
    __table_args__ = (
        Index('uk_qb_question_asset', 'question_id', 'asset_key', unique=True),
        Index('idx_qb_question_asset_file_hash', 'file_hash'),
        Index('idx_qb_question_asset_status', 'download_status'),
        {'comment': '题目素材当前数据'},
    )

    asset_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    question_id = Column(BigInteger, nullable=False)
    source_provider = Column(String(64), nullable=False)
    asset_key = Column(String(100), nullable=False)
    asset_type = Column(String(30), nullable=False)
    source_url = Column(String(1000), nullable=True)
    storage_path = Column(String(1000), nullable=True)
    mime_type = Column(String(100), nullable=True)
    file_name = Column(String(255), nullable=True)
    file_hash = Column(CHAR(64), nullable=True)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    sort_order = Column(Integer, nullable=False, server_default='0')
    download_status = Column(String(20), nullable=False, server_default='pending')
    error_message = Column(String(1000), nullable=True)
    last_sync_batch_id = Column(BigInteger, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbSyncBatch(Base):
    __tablename__ = 'qb_sync_batch'
    __table_args__ = (
        Index('uk_qb_sync_batch_no', 'batch_no', unique=True),
        Index('idx_qb_sync_batch_status', 'status'),
        CheckConstraint("batch_type IN ('full', 'rollback')", name='chk_qb_sync_batch_type'),
        CheckConstraint(
            "status IN ('building', 'validating', 'validated', 'approval_pending', 'approved', 'publishing', 'published', 'failed', 'archived', 'rolled_back')",
            name='chk_qb_sync_batch_status',
        ),
        {'comment': '题库发布批次元数据'},
    )

    batch_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    batch_no = Column(String(128), nullable=False)
    batch_type = Column(String(20), nullable=False)
    source_provider = Column(String(64), nullable=False)
    schema_version = Column(String(64), nullable=False)
    artifact_uri = Column(String(1000), nullable=True)
    artifact_sha256 = Column(CHAR(64), nullable=True)
    status = Column(String(30), nullable=False, server_default='building')
    previous_batch_id = Column(BigInteger, nullable=True)
    restored_from_batch_id = Column(BigInteger, nullable=True)
    question_count = Column(Integer, nullable=False, server_default='0')
    catalog_count = Column(Integer, nullable=False, server_default='0')
    tag_count = Column(Integer, nullable=False, server_default='0')
    asset_count = Column(Integer, nullable=False, server_default='0')
    validation_report_json = Column(JSON, nullable=True)
    diff_report_json = Column(JSON, nullable=True)
    error_message = Column(String(2000), nullable=True)
    approved_by = Column(String(64), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    started_at = Column(DateTime, nullable=True)
    validated_at = Column(DateTime, nullable=True)
    published_at = Column(DateTime, nullable=True)
    archived_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbDatasetMeta(Base):
    __tablename__ = 'qb_dataset_meta'
    __table_args__ = (
        Index('idx_qb_dataset_meta_provider', 'source_provider'),
        Index('idx_qb_dataset_meta_current_batch', 'current_batch_id'),
        {'comment': '题库数据集发布元数据'},
    )

    scope_key = Column(String(128), primary_key=True, nullable=False)
    source_provider = Column(String(64), nullable=False)
    current_batch_id = Column(BigInteger, nullable=True)
    previous_batch_id = Column(BigInteger, nullable=True)
    schema_version = Column(String(64), nullable=False)
    dataset_hash = Column(CHAR(64), nullable=True)
    published_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbSyncReview(Base):
    """审核同步候选的工作表。

    这张表不是题库正式数据表：它只记录候选摘要、审核快照和审核
    决策。审核通过后仍需由 qbpkg/Publisher 负责把候选发布到正式表。
    """

    __tablename__ = 'qb_sync_review'
    __table_args__ = (
        Index(
            'uk_qb_sync_review_identity',
            'entity_type',
            'source_provider',
            'external_id',
            unique=True,
        ),
        Index('idx_qb_sync_review_status', 'entity_type', 'review_status'),
        Index('idx_qb_sync_review_hash', 'staged_hash'),
        CheckConstraint(
            "entity_type IN ('version', 'textbook', 'catalog', 'question')",
            name='chk_qb_sync_review_entity_type',
        ),
        CheckConstraint(
            "comparison_status IN ('new', 'changed', 'unchanged', 'conflict')",
            name='chk_qb_sync_review_comparison_status',
        ),
        CheckConstraint(
            "review_status IN ('pending', 'approved', 'rejected', 'stale')",
            name='chk_qb_sync_review_review_status',
        ),
        {'comment': '题库同步候选审核记录'},
    )

    sync_review_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    entity_type = Column(String(20), nullable=False)
    source_provider = Column(String(64), nullable=False)
    external_id = Column(String(128), nullable=False)
    staged_hash = Column(CHAR(64), nullable=False)
    staged_data_json = Column(JSON, nullable=False)
    current_local_id = Column(BigInteger, nullable=True)
    comparison_status = Column(String(20), nullable=False)
    review_status = Column(String(20), nullable=False, server_default='pending')
    review_comment = Column(String(1000), nullable=True)
    reviewed_by = Column(String(64), nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbSyncJob(Base):
    """Persistent state for the backend-triggered source crawler."""

    __tablename__ = 'qb_sync_job'
    __table_args__ = (
        Index('uk_qb_sync_job_active_slot', 'active_slot', unique=True),
        Index('idx_qb_sync_job_status', 'status'),
        Index('idx_qb_sync_job_create_time', 'create_time'),
        Index('idx_qb_sync_job_module', 'task_module', 'run_id'),
        Index('idx_qb_sync_job_source_task', 'source_task_id'),
        Index('idx_qb_sync_job_retry_of', 'retry_of_run_id'),
        Index('idx_qb_sync_job_collector_job', 'collector_job_id'),
        CheckConstraint(
            "status IN ('queued', 'starting', 'running', 'cancelling', 'completed', 'failed', 'blocked', 'cancelled', 'interrupted')",
            name='chk_qb_sync_job_status',
        ),
        CheckConstraint(
            "phase IN ('metadata', 'catalogs_questions', 'completed', 'failed', 'blocked', 'cancelled', 'interrupted')",
            name='chk_qb_sync_job_phase',
        ),
        CheckConstraint("acknowledge_source_policy IN ('Y', 'N')", name='chk_qb_sync_job_ack'),
        CheckConstraint("run_type IN ('metadata', 'content')", name='chk_qb_sync_job_run_type'),
        CheckConstraint(
            "task_module IN ('center', 'textbook', 'question')",
            name='chk_qb_sync_job_task_module',
        ),
        {'comment': '题库来源同步后台任务'},
    )

    run_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    run_type = Column(String(20), nullable=False, server_default='metadata')
    task_module = Column(String(20), nullable=False, server_default='center')
    status = Column(String(20), nullable=False, server_default='queued')
    phase = Column(String(30), nullable=False, server_default='metadata')
    acknowledge_source_policy = Column(CHAR(1), nullable=False, server_default='N')
    metadata_run_id = Column(BigInteger, nullable=True)
    source_task_id = Column(BigInteger, nullable=True)
    retry_of_run_id = Column(BigInteger, nullable=True)
    collector_job_id = Column(String(64), nullable=True)
    options_json = Column(JSON, nullable=False)
    total_versions = Column(Integer, nullable=False, server_default='0')
    completed_versions = Column(Integer, nullable=False, server_default='0')
    new_version_count = Column(Integer, nullable=False, server_default='0')
    total_textbooks = Column(Integer, nullable=False, server_default='0')
    completed_textbooks = Column(Integer, nullable=False, server_default='0')
    new_textbook_count = Column(Integer, nullable=False, server_default='0')
    catalog_count = Column(Integer, nullable=False, server_default='0')
    new_catalog_count = Column(Integer, nullable=False, server_default='0')
    changed_catalog_count = Column(Integer, nullable=False, server_default='0')
    question_count = Column(Integer, nullable=False, server_default='0')
    new_question_count = Column(Integer, nullable=False, server_default='0')
    changed_question_count = Column(Integer, nullable=False, server_default='0')
    question_catalog_count = Column(Integer, nullable=False, server_default='0')
    question_tag_count = Column(Integer, nullable=False, server_default='0')
    question_asset_count = Column(Integer, nullable=False, server_default='0')
    snapshot_complete = Column(SmallInteger, nullable=False, server_default='0')
    snapshot_locked_at = Column(DateTime, nullable=True)
    current_textbook_id = Column(String(128), nullable=True)
    current_textbook_name = Column(String(300), nullable=True)
    progress_percent = Column(Numeric(6, 2), nullable=False, server_default='0')
    log_tail = Column(LONGTEXT, nullable=True)
    error_message = Column(String(2000), nullable=True)
    process_id = Column(BigInteger, nullable=True)
    worker_token = Column(String(64), nullable=True)
    active_slot = Column(CHAR(1), nullable=True)
    created_by = Column(String(64), nullable=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbSyncJobScope(Base):
    """Immutable local/external task scope plus per-textbook run status."""

    __tablename__ = 'qb_sync_job_scope'
    __table_args__ = (
        Index(
            'uk_qb_sync_scope_identity',
            'run_id',
            'source_provider',
            'external_textbook_id',
            unique=True,
        ),
        Index('idx_qb_sync_scope_run', 'run_id', 'scope_id'),
        Index('idx_qb_sync_scope_local_textbook', 'local_textbook_id', 'run_id'),
        Index('idx_qb_sync_scope_metadata_run', 'metadata_run_id'),
        Index('idx_qb_sync_scope_collector_run', 'collector_run_id'),
        Index(
            'idx_qb_sync_scope_resume_run',
            'resume_from_collector_run_id',
            'source_provider',
            'external_textbook_id',
        ),
        CheckConstraint(
            "status IN ('queued', 'starting', 'running', 'completed', 'failed', 'blocked', 'cancelled', 'interrupted')",
            name='chk_qb_sync_scope_status',
        ),
        {'comment': '同步任务教材范围与 collector 运行绑定'},
    )

    scope_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    run_id = Column(BigInteger, nullable=False)
    local_version_id = Column(BigInteger, nullable=True)
    local_textbook_id = Column(BigInteger, nullable=True)
    version_name_snapshot = Column(String(100), nullable=True)
    textbook_name_snapshot = Column(String(100), nullable=True)
    source_provider = Column(String(64), nullable=False)
    external_version_id = Column(String(128), nullable=True)
    external_textbook_id = Column(String(128), nullable=True)
    metadata_run_id = Column(BigInteger, nullable=True)
    collector_job_id = Column(String(64), nullable=True)
    collector_run_id = Column(BigInteger, nullable=True)
    resume_from_collector_run_id = Column(BigInteger, nullable=True)
    status = Column(String(20), nullable=False, server_default='queued')
    catalog_count = Column(Integer, nullable=False, server_default='0')
    question_count = Column(Integer, nullable=False, server_default='0')
    new_catalog_count = Column(Integer, nullable=False, server_default='0')
    changed_catalog_count = Column(Integer, nullable=False, server_default='0')
    new_question_count = Column(Integer, nullable=False, server_default='0')
    changed_question_count = Column(Integer, nullable=False, server_default='0')
    question_catalog_count = Column(Integer, nullable=False, server_default='0')
    question_tag_count = Column(Integer, nullable=False, server_default='0')
    question_asset_count = Column(Integer, nullable=False, server_default='0')
    snapshot_complete = Column(SmallInteger, nullable=False, server_default='0')
    snapshot_locked_at = Column(DateTime, nullable=True)
    error_message = Column(String(2000), nullable=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbTextbookApplyState(Base):
    """Current formally applied textbook snapshot for one provider."""

    __tablename__ = 'qb_textbook_apply_state'
    __table_args__ = (
        Index('idx_qb_textbook_apply_state_task', 'current_task_id'),
        Index('idx_qb_textbook_apply_state_run', 'current_metadata_run_id'),
        {'comment': '正式教材当前快照状态'},
    )

    source_provider = Column(String(64), primary_key=True, nullable=False)
    current_task_id = Column(BigInteger, nullable=True)
    current_metadata_run_id = Column(BigInteger, nullable=True)
    snapshot_hash = Column(CHAR(64), nullable=True)
    applied_by = Column(String(64), nullable=True)
    applied_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbTextbookApplyHistory(Base):
    """Append-only audit row for each non-idempotent textbook application."""

    __tablename__ = 'qb_textbook_apply_history'
    __table_args__ = (
        Index('idx_qb_textbook_apply_history_provider_time', 'source_provider', 'applied_at'),
        Index('idx_qb_textbook_apply_history_task', 'source_provider', 'task_id'),
        Index('idx_qb_textbook_apply_history_hash', 'source_provider', 'snapshot_hash'),
        CheckConstraint("action IN ('apply', 'rollback', 'restore')", name='chk_qb_textbook_apply_history_action'),
        {'comment': '正式教材快照应用历史'},
    )

    history_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    source_provider = Column(String(64), nullable=False)
    task_id = Column(BigInteger, nullable=False)
    metadata_run_id = Column(BigInteger, nullable=False)
    snapshot_hash = Column(CHAR(64), nullable=False)
    action = Column(String(20), nullable=False)
    previous_task_id = Column(BigInteger, nullable=True)
    previous_metadata_run_id = Column(BigInteger, nullable=True)
    change_stats_json = Column(JSON, nullable=False)
    applied_by = Column(String(64), nullable=True)
    applied_at = Column(DateTime, nullable=False)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestionApplyState(Base):
    """Current formally applied content snapshot for one textbook scope."""

    __tablename__ = 'qb_question_apply_state'
    __table_args__ = (
        Index('idx_qb_question_apply_state_task', 'current_task_id'),
        Index('idx_qb_question_apply_state_run', 'current_collector_run_id'),
        {'comment': '正式题库教材 scope 当前快照状态'},
    )

    source_provider = Column(String(64), primary_key=True, nullable=False)
    external_textbook_id = Column(String(128), primary_key=True, nullable=False)
    current_task_id = Column(BigInteger, nullable=True)
    current_collector_run_id = Column(BigInteger, nullable=True)
    snapshot_hash = Column(CHAR(64), nullable=True)
    state_token = Column(CHAR(64), nullable=True)
    applied_by = Column(String(64), nullable=True)
    applied_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestionApplyHistory(Base):
    """Append-only audit row for each applied question scope snapshot."""

    __tablename__ = 'qb_question_apply_history'
    __table_args__ = (
        Index('idx_qb_question_apply_history_scope_time', 'source_provider', 'external_textbook_id', 'applied_at'),
        Index('idx_qb_question_apply_history_task', 'source_provider', 'task_id'),
        Index('idx_qb_question_apply_history_hash', 'source_provider', 'snapshot_hash'),
        CheckConstraint("action IN ('apply', 'rollback', 'restore')", name='chk_qb_question_apply_history_action'),
        {'comment': '正式题库 scope 快照应用历史'},
    )

    history_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    source_provider = Column(String(64), nullable=False)
    external_textbook_id = Column(String(128), nullable=False)
    task_id = Column(BigInteger, nullable=False)
    collector_run_id = Column(BigInteger, nullable=False)
    snapshot_hash = Column(CHAR(64), nullable=False)
    state_token = Column(CHAR(64), nullable=False)
    action = Column(String(20), nullable=False)
    previous_task_id = Column(BigInteger, nullable=True)
    previous_collector_run_id = Column(BigInteger, nullable=True)
    previous_snapshot_hash = Column(CHAR(64), nullable=True)
    change_stats_json = Column(JSON, nullable=False)
    applied_by = Column(String(64), nullable=True)
    applied_at = Column(DateTime, nullable=False)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)
