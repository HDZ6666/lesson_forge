from uuid import uuid4

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
    event,
    inspect,
    update,
)
from sqlalchemy.dialects.mysql import DATETIME, LONGTEXT
from sqlalchemy.orm import Session, attributes

from config.database import Base


class QbSubject(Base):
    __tablename__ = 'qb_subject'
    __table_args__ = (
        Index('uk_qb_subject_stage_code', 'stage_code', 'subject_code', unique=True),
        Index('uk_qb_subject_source_profile', 'source_profile', unique=True),
        {'comment': '学段学科及经过验证的采集来源映射'},
    )

    subject_id = Column(BigInteger, primary_key=True, autoincrement=True)
    stage_code = Column(String(30), nullable=False)
    subject_code = Column(String(30), nullable=False)
    subject_name = Column(String(50), nullable=False)
    source_profile = Column(String(64), nullable=True)
    sort_order = Column(Integer, nullable=False, server_default='0')
    status = Column(CHAR(1), nullable=False, server_default='0')
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbTextbookVersion(Base):
    __tablename__ = 'qb_textbook_version'
    __table_args__ = (
        Index('uk_qb_version_provider_external', 'source_provider', 'subject_id', 'external_version_id', unique=True),
        Index('idx_qb_version_subject', 'subject_id', 'status'),
        Index('idx_qb_version_status', 'status'),
        {'comment': '题库版本当前数据'},
    )

    version_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    subject_id = Column(BigInteger, nullable=False, server_default='1')
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
        Index('uk_qb_textbook_provider_external', 'source_provider', 'subject_id', 'external_textbook_id', unique=True),
        Index('idx_qb_textbook_subject', 'subject_id', 'status'),
        Index('idx_qb_textbook_version', 'version_id'),
        Index('idx_qb_textbook_status', 'status'),
        {'comment': '题库教材当前数据'},
    )

    textbook_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    subject_id = Column(BigInteger, nullable=False, server_default='1')
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
        Index('uk_qb_catalog_provider_external', 'source_provider', 'subject_id', 'textbook_id', 'external_node_id', unique=True),
        Index('idx_qb_catalog_subject', 'subject_id', 'status'),
        Index('idx_qb_catalog_parent', 'textbook_id', 'parent_id'),
        Index('idx_qb_catalog_status', 'status'),
        {'comment': '题库目录节点当前数据'},
    )

    catalog_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    subject_id = Column(BigInteger, nullable=False, server_default='1')
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
        Index('uk_qb_question_provider_external', 'source_provider', 'subject_id', 'external_question_id', unique=True),
        Index('idx_qb_question_subject', 'subject_id', 'status'),
        Index('idx_qb_question_grade_term', 'grade', 'term'),
        Index('idx_qb_question_type_difficulty', 'question_type', 'difficulty'),
        Index('idx_qb_question_status', 'status'),
        Index('idx_qb_question_coverage', 'question_id', 'subject_id', 'status', 'readiness_revision',
              'source_provider', 'external_question_id', 'content_hash'),
        {'comment': '题库题目当前数据'},
    )

    question_id = Column(BigInteger, primary_key=True, autoincrement=True, nullable=False)
    subject_id = Column(BigInteger, nullable=False, server_default='1')
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
    # A cache revision covers stem and asset changes even when content_hash
    # is missing (manual questions) or an image changes without new HTML.
    readiness_revision = Column(CHAR(32), nullable=True, default=lambda: uuid4().hex)
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
        Index('idx_qb_question_catalog_lookup', 'catalog_id', 'relation_type', 'question_id'),
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
        Index('idx_qb_question_asset_download_hash', 'download_status', 'file_hash'),
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


class QbQuestionReadiness(Base):
    __tablename__ = 'qb_question_readiness'
    __table_args__ = (Index('idx_qb_readiness_status', 'status', 'question_id'),)

    question_id = Column(BigInteger, primary_key=True, nullable=False)
    subject_id = Column(BigInteger, nullable=False)
    source_provider = Column(String(64), nullable=False)
    external_question_id = Column(String(64), nullable=True)
    question_revision = Column(CHAR(32), nullable=False)
    content_hash = Column(CHAR(64), nullable=True)
    stem_hash = Column(CHAR(64), nullable=False)
    asset_signature = Column(CHAR(64), nullable=False)
    has_image = Column(SmallInteger, nullable=False)
    has_table = Column(SmallInteger, nullable=False)
    stem_valid = Column(SmallInteger, nullable=False)
    assets_ready = Column(SmallInteger, nullable=False)
    status = Column(String(20), nullable=False)
    reason = Column(String(500), nullable=True)
    checked_at = Column(DATETIME(fsp=6), nullable=False)


class QbQuestionReadinessSweep(Base):
    __tablename__ = 'qb_question_readiness_sweep'

    sweep_id = Column(Integer, primary_key=True, nullable=False)
    last_question_id = Column(BigInteger, nullable=False, server_default='0')
    worker_token = Column(CHAR(32), nullable=True)
    lease_until = Column(DATETIME(fsp=6), nullable=True)
    next_check_at = Column(DATETIME(fsp=6), nullable=True)


@event.listens_for(Session, 'before_flush')
def _invalidate_stem_readiness(session, _flush_context, _instances):
    """No file IO: ORM stem/asset edits invalidate cached facts in the same transaction.

    Core initial inserts have no existing facts. Publisher resets candidate
    revisions before table swaps; Core deletes remove their derived facts.
    """
    stem_fields = ('content_html', 'plain_text', 'content_hash', 'subject_id',
                   'source_provider', 'external_question_id')
    asset_fields = ('question_id', 'asset_key', 'asset_type', 'file_hash', 'storage_path',
                    'download_status', 'mime_type', 'width', 'height', 'source_provider')
    asset_question_ids = set()
    objects = session.new | session.dirty | session.deleted
    for row in objects:
        state = inspect(row)
        if isinstance(row, QbQuestion) and row in session.dirty:
            if any(state.attrs[name].history.has_changes() for name in stem_fields):
                row.readiness_revision = uuid4().hex
        elif isinstance(row, QbQuestionAsset) and (
            row in session.new or row in session.deleted
            or any(state.attrs[name].history.has_changes() for name in asset_fields)
        ):
            asset_question_ids.update(value for value in (
                row.question_id, *state.attrs.question_id.history.deleted,
            ) if value is not None)
    if not asset_question_ids:
        return
    loaded = {row.question_id: row for row in session.identity_map.values() if isinstance(row, QbQuestion)}
    loaded.update({row.question_id: row for row in session.new if isinstance(row, QbQuestion)})
    ids = sorted(asset_question_ids)
    for offset in range(0, len(ids), 1000):
        chunk, token = ids[offset:offset + 1000], uuid4().hex
        session.connection().execute(update(QbQuestion.__table__).where(
            QbQuestion.question_id.in_(chunk),
        ).values(readiness_revision=token))
        for value in chunk:
            if value in loaded:
                attributes.set_committed_value(loaded[value], 'readiness_revision', token)


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


class QbQuestionTaskReview(Base):
    __tablename__ = 'qb_question_task_review'

    task_id = Column(BigInteger, primary_key=True)
    baseline_json = Column(JSON, nullable=False)
    excluded_json = Column(JSON, nullable=False)
    revision = Column(Integer, nullable=False, default=0)
    captured_at = Column(DateTime, nullable=False)


class QbSyncJob(Base):
    """Persistent state for the backend-triggered source crawler."""

    __tablename__ = 'qb_sync_job'
    subject_id = Column(BigInteger, nullable=False, server_default='1')
    __table_args__ = (
        Index('uk_qb_sync_job_active_slot', 'active_slot', unique=True),
        Index('idx_qb_sync_job_status', 'status'),
        Index('idx_qb_sync_job_create_time', 'create_time'),
        Index('idx_qb_sync_job_module', 'task_module', 'run_id'),
        Index('idx_qb_sync_job_source_task', 'source_task_id'),
        Index('idx_qb_sync_job_retry_of', 'retry_of_run_id'),
        Index('idx_qb_sync_job_logical_task', 'logical_task_id', 'run_id'),
        Index('idx_qb_sync_job_collector_job', 'collector_job_id'),
        Index('uk_qb_sync_job_dispatch_book', 'dispatch_book_key', unique=True),
        Index('idx_qb_sync_job_dispatch_due', 'status', 'active_slot', 'dispatch_not_before', 'run_id'),
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
    logical_task_id = Column(BigInteger, nullable=True)
    retry_of_run_id = Column(BigInteger, nullable=True)
    collector_job_id = Column(String(64), nullable=True)
    dispatch_priority = Column(BigInteger, nullable=False, server_default='0')
    dispatch_rank = Column(Integer, nullable=False, server_default='0')
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
    # A pending single-book task has no active_slot. The book key remains
    # reserved through intake/import and bounded automatic resume.
    dispatch_book_key = Column(CHAR(64), nullable=True)
    dispatch_job_id = Column(CHAR(36), nullable=True)
    dispatch_not_before = Column(DateTime().with_variant(DATETIME(fsp=6), 'mysql'), nullable=True)
    dispatch_error = Column(String(500), nullable=True)
    created_by = Column(String(64), nullable=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbSyncJobScope(Base):
    """Immutable local/external task scope plus per-textbook run status."""

    __tablename__ = 'qb_sync_job_scope'
    subject_id = Column(BigInteger, nullable=False, server_default='1')
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
    snapshot_locked_at = Column(DateTime().with_variant(DATETIME(fsp=6), 'mysql'), nullable=True)
    error_message = Column(String(2000), nullable=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestionImportIntake(Base):
    """Recoverable verification of one terminal Collector run, before QC."""

    __tablename__ = 'qb_question_import_intake'
    __table_args__ = (
        Index('uk_qb_import_intake_scope_run', 'scope_id', 'collector_run_id', unique=True),
        Index('idx_qb_import_intake_due', 'status', 'next_attempt_at', 'lease_until'),
        Index('idx_qb_import_intake_task', 'task_id', 'intake_id'),
        CheckConstraint(
            "status IN ('pending','probing','retry','ready','blocked','discarded')",
            name='chk_qb_import_intake_status',
        ),
        {'comment': '采集终态封存核验与自动入库提交'},
    )

    intake_id = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id = Column(BigInteger, nullable=False)
    scope_id = Column(BigInteger, nullable=False)
    collector_run_id = Column(BigInteger, nullable=False)
    binding_hash = Column(CHAR(64), nullable=False)
    status = Column(String(20), nullable=False)
    attempt_count = Column(Integer, nullable=False, server_default='0')
    attempt_limit = Column(Integer, nullable=False, server_default='3')
    next_attempt_at = Column(DateTime, nullable=True)
    worker_token = Column(CHAR(64), nullable=True)
    lease_until = Column(DateTime, nullable=True)
    error_kind = Column(String(32), nullable=True)
    error_message = Column(String(2000), nullable=True)
    import_id = Column(BigInteger, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestionImport(Base):
    """One durable incremental import of a sealed task scope."""

    __tablename__ = 'qb_question_import'
    __table_args__ = (
        Index('uk_qb_question_import_scope_run', 'scope_id', 'collector_run_id', unique=True),
        Index('idx_qb_question_import_task', 'task_id', 'import_id'),
        Index('idx_qb_question_import_lease', 'status', 'lease_until'),
        Index('uk_qb_question_import_source_slot', 'active_source_slot', unique=True),
        CheckConstraint("status IN ('queued','preparing','running','completed','partial','failed','paused','cancelled')", name='chk_qb_question_import_status'),
        CheckConstraint('committed_cursor >= 0 AND committed_cursor <= question_count', name='chk_qb_question_import_cursor'),
        {'comment': '封存题库结果的增量入库断点与租约'},
    )

    import_id = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id = Column(BigInteger, nullable=False)
    scope_id = Column(BigInteger, nullable=False)
    subject_id = Column(BigInteger, nullable=False)
    source_provider = Column(String(64), nullable=False)
    local_textbook_id = Column(BigInteger, nullable=False)
    external_textbook_id = Column(String(64), nullable=False)
    collector_run_id = Column(BigInteger, nullable=False)
    snapshot_locked_at = Column(DateTime().with_variant(DATETIME(fsp=6), 'mysql'), nullable=False)
    snapshot_complete = Column(SmallInteger, nullable=False)
    quality_hash = Column(CHAR(64), nullable=True)
    run_coverage_json = Column(JSON, nullable=True)
    identity_hash = Column(CHAR(64), nullable=False)
    question_count = Column(Integer, nullable=False)
    cursor = Column('committed_cursor', Integer, nullable=False, server_default='0')
    batch_no = Column(Integer, nullable=False, server_default='0')
    accepted_count = Column(Integer, nullable=False, server_default='0')
    quarantined_count = Column(Integer, nullable=False, server_default='0')
    stats_json = Column(JSON, nullable=False)
    status = Column(String(20), nullable=False)
    stage = Column(String(20), nullable=False, server_default='importing')
    active_source_slot = Column(String(64), nullable=True)
    worker_token = Column(CHAR(64), nullable=True)
    lease_until = Column(DateTime, nullable=True)
    error_message = Column(String(2000), nullable=True)
    finished_at = Column(DateTime, nullable=True)
    create_time = Column(DateTime, nullable=False)
    update_time = Column(DateTime, nullable=False)


class QbQuestionImportBatch(Base):
    __tablename__ = 'qb_question_import_batch'
    __table_args__ = (
        Index('uk_qb_import_batch_cursor', 'import_id', 'start_cursor', unique=True),
        {'comment': '与正式题目同事务提交的增量批次结果'},
    )

    import_id = Column(BigInteger, primary_key=True)
    batch_no = Column(Integer, primary_key=True)
    start_cursor = Column(Integer, nullable=False)
    next_cursor = Column(Integer, nullable=False)
    batch_hash = Column(CHAR(64), nullable=False)
    accepted_count = Column(Integer, nullable=False)
    quarantined_count = Column(Integer, nullable=False)
    stats_json = Column(JSON, nullable=False)
    issues_json = Column(JSON, nullable=False)
    create_time = Column(DateTime, nullable=False)


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


class QbSyncControl(Base):
    __tablename__ = 'qb_sync_control'
    control_id = Column(Integer, primary_key=True)
    paused = Column(SmallInteger, nullable=False, server_default='0')
    reason = Column(String(500), nullable=True)
    revision = Column(Integer, nullable=False, server_default='1')
    issue_cursor = Column(BigInteger, nullable=False, server_default='0')
    updated_by = Column(String(64), nullable=True)
    update_time = Column(DateTime, nullable=False)


class QbSyncPlan(Base):
    __tablename__ = 'qb_sync_plan'
    __table_args__ = (Index('uk_qb_sync_plan_subject', 'subject_id', unique=True),)
    plan_id = Column(BigInteger, primary_key=True, autoincrement=True)
    subject_id = Column(BigInteger, nullable=False)
    auto_update = Column(SmallInteger, nullable=False, server_default='1')
    control_state = Column(String(20), nullable=False, server_default='active')
    cycle_state = Column(String(20), nullable=False, server_default='idle')
    cycle_finished_at = Column(DateTime, nullable=True)
    next_cycle_at = Column(DateTime, nullable=True)
    textbook_order = Column(JSON, nullable=True)
    list_concurrency = Column(Integer, nullable=False, server_default='8')
    catalog_page_limit = Column(Integer, nullable=False, server_default='1000')
    plan_name = Column(String(100), nullable=False, server_default='')
    cycle_name = Column(String(180), nullable=True)
    enabled = Column(SmallInteger, nullable=False, server_default='0')
    refresh_days = Column(Integer, nullable=False, server_default='7')
    refill_hours = Column(Integer, nullable=False, server_default='24')
    discovery_days = Column(Integer, nullable=False, server_default='7')
    cycle_no = Column(Integer, nullable=False, server_default='0')
    cycle_targets = Column(JSON, nullable=False)
    cycle_started_at = Column(DateTime, nullable=True)
    next_check_at = Column(DateTime, nullable=True)
    discovery_task_id = Column(BigInteger, nullable=True)
    discovery_processed_task_id = Column(BigInteger, nullable=False, server_default='0')
    discovery_next_at = Column(DateTime, nullable=True)
    discovery_error = Column(String(500), nullable=True)
    worker_token = Column(CHAR(32), nullable=True)
    lease_until = Column(DateTime, nullable=True)
    revision = Column(Integer, nullable=False, server_default='1')
    update_time = Column(DateTime, nullable=False)


class QbSyncCycle(Base):
    __tablename__ = 'qb_sync_cycle'
    __table_args__ = (Index('uk_qb_sync_cycle', 'plan_id', 'cycle_no', unique=True),)
    cycle_id = Column(BigInteger, primary_key=True, autoincrement=True)
    plan_id = Column(BigInteger, nullable=False)
    cycle_no = Column(Integer, nullable=False)
    cycle_name = Column(String(180), nullable=False)
    status = Column(String(20), nullable=False)
    targets = Column(JSON, nullable=False)
    summary_json = Column(JSON, nullable=True)
    started_at = Column(DateTime, nullable=False)
    finished_at = Column(DateTime, nullable=True)


class QbSyncBookState(Base):
    __tablename__ = 'qb_sync_book_state'
    __table_args__ = (Index('uk_qb_sync_book_state', 'plan_id', 'textbook_id', unique=True),)
    state_id = Column(BigInteger, primary_key=True, autoincrement=True)
    plan_id = Column(BigInteger, nullable=False)
    textbook_id = Column(BigInteger, nullable=False)
    enabled = Column(SmallInteger, nullable=False, server_default='1')
    exception_kind = Column(String(30), nullable=True)
    operator_note = Column(String(500), nullable=True)
    last_manual_task_id = Column(BigInteger, nullable=True)
    last_task_id = Column(BigInteger, nullable=True)
    last_cycle_no = Column(Integer, nullable=False, server_default='0')
    next_due_at = Column(DateTime, nullable=True)
    last_finished_at = Column(DateTime, nullable=True)
    revision = Column(Integer, nullable=False, server_default='1')


class QbSyncIssue(Base):
    __tablename__ = 'qb_sync_issue'
    __table_args__ = (
        Index('uk_qb_sync_issue_identity', 'identity_key', unique=True),
        Index('idx_qb_sync_issue_book_status', 'textbook_id', 'status', 'issue_id'),
    )
    issue_id = Column(BigInteger, primary_key=True, autoincrement=True)
    identity_key = Column(CHAR(64), nullable=False)
    subject_id = Column(BigInteger, nullable=False)
    source_provider = Column(String(64), nullable=False)
    textbook_id = Column(BigInteger, nullable=False)
    object_kind = Column(String(30), nullable=False)
    object_key = Column(String(100), nullable=False)
    error_type = Column(String(50), nullable=False)
    status = Column(String(20), nullable=False, server_default='open')
    reason = Column(String(2000), nullable=False)
    first_task_id = Column(BigInteger, nullable=False)
    latest_task_id = Column(BigInteger, nullable=False)
    resolved_task_id = Column(BigInteger, nullable=True)
    attempts = Column(Integer, nullable=False, server_default='1')
    evidence_json = Column(JSON, nullable=False)
    operator_note = Column(String(500), nullable=True)
    revision = Column(Integer, nullable=False, server_default='1')
    first_seen_at = Column(DateTime, nullable=False)
    last_seen_at = Column(DateTime, nullable=False)
    resolved_at = Column(DateTime, nullable=True)


class QbSyncIssueTask(Base):
    __tablename__ = 'qb_sync_issue_task'
    issue_id = Column(BigInteger, primary_key=True)
    task_id = Column(BigInteger, primary_key=True)
    evidence_json = Column(JSON, nullable=False)
    observed_at = Column(DateTime, nullable=False)
