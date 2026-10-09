from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from common.vo import ResponseBaseModel

PageNumber = Annotated[int, Field(ge=1, le=100000)]
PageSize = Annotated[int, Field(ge=1, le=100)]
QuestionSort = Literal[
    'questionId',
    'sourceQuestionNo',
    'year',
    'difficultyCoefficient',
    'score',
    'assembleCount',
    'referenceCount',
    'createTime',
    'updateTime',
]
SortOrder = Literal['asc', 'desc']


class BankModel(BaseModel):
    # API payloads use camelCase while SQLAlchemy entities expose snake_case.
    # Accepting field names is required for ``model_validate(entity)`` and
    # also keeps direct service/DAO calls convenient in tests and workers.
    model_config = ConfigDict(alias_generator=to_camel, from_attributes=True, populate_by_name=True)


class BankPageQueryModel(BankModel):
    page_num: PageNumber = Field(default=1, description='页码')
    page_size: PageSize = Field(default=10, description='每页数量')


class ImportResultQueryModel(BankModel):
    cursor: str | None = Field(default=None, max_length=512)
    page_size: int = Field(default=20, ge=1, le=50)


class SubjectModel(BankModel):
    subject_id: int | None = Field(default=None, gt=0)
    stage_code: Literal['primary', 'junior', 'senior']
    subject_code: str = Field(min_length=1, max_length=30, pattern=r'^[a-z][a-z0-9_]*$')
    subject_name: str = Field(min_length=1, max_length=50)
    source_profile: str | None = Field(default=None, max_length=64)
    status: Literal['0', '1'] = '0'
    sort_order: int = Field(default=0, ge=0)


class SubjectQueryModel(BankModel):
    include_disabled: bool = False


class TextbookVersionModel(BankModel):
    subject_id: int | None = Field(default=None, gt=0)
    version_id: int | None = Field(default=None, description='版本主键')
    source_provider: str | None = Field(default=None, description='来源提供方')
    external_version_id: str | None = Field(default=None, description='来源版本 ID')
    version_name: str | None = Field(default=None, description='版本名称')
    source_url: str | None = Field(default=None, description='来源地址')
    is_new: Literal['Y', 'N'] | None = Field(default=None, description='是否新版本')
    sort_order: int | None = Field(default=None, description='显示顺序')
    status: Literal['0', '1'] | None = Field(default=None, description='状态')
    last_sync_batch_id: int | None = Field(default=None, description='最近同步批次')
    last_seen_at: datetime | None = Field(default=None, description='最近发现时间')
    create_time: datetime | None = Field(default=None, description='创建时间')
    update_time: datetime | None = Field(default=None, description='更新时间')
    textbook_count: int = Field(default=0, description='教材数量')


class TextbookVersionQueryModel(BankPageQueryModel):
    subject_id: int | None = Field(default=None, gt=0)
    version_name: str | None = Field(default=None, description='版本名称')
    source_provider: str | None = Field(default=None, description='来源提供方')
    status: Literal['0', '1'] | None = Field(default=None, description='显式状态筛选')
    include_disabled: bool = Field(default=False, alias='includeDisabled', description='是否包含停用版本')


class TextbookModel(BankModel):
    subject_id: int | None = Field(default=None, gt=0)
    textbook_id: int | None = Field(default=None, description='教材主键')
    version_id: int | None = Field(default=None, description='版本主键')
    source_provider: str | None = Field(default=None, description='来源提供方')
    external_textbook_id: str | None = Field(default=None, description='来源教材 ID')
    textbook_name: str | None = Field(default=None, description='教材名称')
    grade: str | None = Field(default=None, description='年级中文原值')
    volume: str | None = Field(default=None, description='册次中文原值')
    source_url: str | None = Field(default=None, description='来源地址')
    sort_order: int | None = Field(default=None, description='显示顺序')
    status: Literal['0', '1'] | None = Field(default=None, description='状态')
    last_sync_batch_id: int | None = Field(default=None, description='最近同步批次')
    last_seen_at: datetime | None = Field(default=None, description='最近发现时间')
    create_time: datetime | None = Field(default=None, description='创建时间')
    update_time: datetime | None = Field(default=None, description='更新时间')
    catalog_count: int = Field(default=0, description='目录数量')
    question_count: int = Field(default=0, description='题目数量')


class TextbookQueryModel(BankPageQueryModel):
    subject_id: int | None = Field(default=None, gt=0)
    version_id: int | None = Field(default=None, description='版本主键')
    textbook_name: str | None = Field(default=None, alias='textbookName', max_length=100, description='教材名称')
    grade: str | None = Field(default=None, max_length=20, description='年级中文原值')
    volume: str | None = Field(default=None, max_length=20, description='册次中文原值')
    source_provider: str | None = Field(default=None, alias='sourceProvider', max_length=64, description='来源提供方')
    status: Literal['0', '1'] | None = Field(default=None, description='显式状态筛选')
    include_disabled: bool = Field(default=False, alias='includeDisabled', description='是否包含停用教材')


class SourceObservationModel(BankModel):
    count: int = Field(ge=0, description='来源在整本教材入口报告的题数，不表示精确缺口')
    observed_at: datetime | None = Field(description='实际来源观察时刻；历史未记录时为 null')
    basis: Literal['textbook_root_probe']
    task_id: int = Field(gt=0)
    import_id: int = Field(gt=0)
    collector_run_id: int = Field(gt=0)
    snapshot_locked_at: datetime


class TextbookCoverageModel(TextbookModel):
    """Read projection only; management writes still use TextbookModel."""

    formal_question_count: int = Field(ge=0, description='按题目 ID 去重，包含停用题目和停用目录')
    active_question_count: int = Field(ge=0, description='启用题目在启用目录中的去重数量，不代表已检查可用')
    usable_question_count: int = Field(ge=0, description='启用范围内通过题干和必要素材检查的去重题数')
    unchecked_question_count: int = Field(ge=0, description='启用范围内尚无当前有效检查事实的去重题数')
    unusable_question_count: int = Field(ge=0, description='启用范围内当前检查不通过的去重题数')
    latest_source_observation: SourceObservationModel | None = None


class CatalogNodeModel(BankModel):
    subject_id: int | None = Field(default=None, gt=0)
    catalog_id: int | None = Field(default=None, description='目录主键')
    textbook_id: int | None = Field(default=None, description='教材主键')
    parent_id: int | None = Field(default=None, description='父节点主键')
    source_provider: str | None = Field(default=None, description='来源提供方')
    external_node_id: str | None = Field(default=None, description='来源节点 ID')
    node_name: str | None = Field(default=None, description='节点名称')
    node_type: str | None = Field(default=None, description='节点类型')
    source_url: str | None = Field(default=None, description='来源地址')
    sort_order: int | None = Field(default=None, description='显示顺序')
    status: Literal['0', '1'] | None = Field(default=None, description='状态')
    last_sync_batch_id: int | None = Field(default=None, description='最近同步批次')
    last_seen_at: datetime | None = Field(default=None, description='最近发现时间')
    create_time: datetime | None = Field(default=None, description='创建时间')
    update_time: datetime | None = Field(default=None, description='更新时间')
    direct_question_count: int = Field(default=0, description='直接题目数量')
    descendant_question_count: int = Field(default=0, description='含后代题目数量')


class CatalogTreeModel(CatalogNodeModel):
    direct_usable_question_count: int = Field(default=0, ge=0)
    descendant_usable_question_count: int = Field(default=0, ge=0)
    children: list['CatalogTreeModel'] = Field(default_factory=list, description='子节点')


class CatalogTreeQueryModel(BankModel):
    textbook_id: int = Field(alias='textbookId', gt=0, description='教材主键')
    include_disabled: bool = Field(
        default=False,
        alias='includeDisabled',
        description='管理页是否包含停用目录；教材浏览固定只请求启用目录',
    )


class CatalogPageQueryModel(BankPageQueryModel):
    subject_id: int | None = Field(default=None, gt=0)
    textbook_id: int | None = Field(default=None, alias='textbookId', gt=0, description='教材主键')
    node_name: str | None = Field(default=None, alias='nodeName', max_length=300, description='目录名称')
    source_provider: str | None = Field(default=None, alias='sourceProvider', max_length=64, description='来源提供方')
    status: Literal['0', '1'] | None = Field(default=None, description='显式状态筛选')
    include_disabled: bool = Field(default=False, alias='includeDisabled', description='是否包含停用目录')


class QuestionModel(BankModel):
    subject_id: int | None = Field(default=None, gt=0)
    question_id: int | None = Field(default=None, description='题目主键')
    source_provider: str | None = Field(default=None, description='来源提供方')
    external_question_id: str | None = Field(default=None, description='来源题目 ID')
    source_url: str | None = Field(default=None, description='来源地址')
    source_question_no: str | None = Field(default=None, description='来源题号')
    source_text: str | None = Field(default=None, description='来源原文')
    paper_name: str | None = Field(default=None, description='来源试卷')
    academic_year: str | None = Field(default=None, description='学年')
    year: int | None = Field(default=None, description='年份')
    grade: str | None = Field(default=None, description='年级中文原值')
    term: str | None = Field(default=None, description='学期中文原值')
    province: str | None = Field(default=None, description='省份')
    city: str | None = Field(default=None, description='城市')
    district: str | None = Field(default=None, description='区县')
    school_name: str | None = Field(default=None, description='学校名称')
    exam_type: str | None = Field(default=None, description='考试类型')
    question_type: str | None = Field(default=None, description='题型中文原值')
    difficulty: str | None = Field(default=None, description='难度中文原值')
    difficulty_coefficient: Decimal | None = Field(default=None, description='难度系数')
    score: Decimal | None = Field(default=None, description='分值')
    content_html: str | None = Field(default=None, description='题干 HTML')
    plain_text: str | None = Field(default=None, description='搜索文本')
    answer_status: str | None = Field(default=None, description='答案状态')
    subquestion_count: int | None = Field(default=None, description='子问题数量')
    website_time_text: str | None = Field(default=None, description='来源时间原文')
    external_updated_at: datetime | None = Field(default=None, description='来源更新时间')
    assemble_count: int | None = Field(default=None, description='组卷次数')
    reference_count: int | None = Field(default=None, description='引用数量')
    reference_papers_json: list[dict] | None = Field(default=None, description='引用试卷')
    is_fresh: Literal['Y', 'N'] | None = Field(default=None, description='是否新题')
    content_hash: str | None = Field(default=None, description='内容哈希')
    last_sync_batch_id: int | None = Field(default=None, description='最近同步批次')
    last_seen_at: datetime | None = Field(default=None, description='最近发现时间')
    status: Literal['0', '1'] | None = Field(default=None, description='状态')
    create_time: datetime | None = Field(default=None, description='创建时间')
    update_time: datetime | None = Field(default=None, description='更新时间')


class QuestionCatalogModel(BankModel):
    question_id: int
    catalog_id: int
    relation_type: Literal['query_catalog', 'knowledge']
    evidence_type: Literal['query_membership', 'provider_asserted']


class QuestionTagInputModel(BankModel):
    """A tag supplied by an operator for a manually managed question."""

    tag_type: str = Field(min_length=1, max_length=30, description='标签维度')
    tag_name: str = Field(min_length=1, max_length=100, description='标签名称')
    relation_type: str = Field(default='provider_asserted', min_length=1, max_length=120, description='标签关系类型')
    evidence_type: Literal['provider_asserted'] = Field(default='provider_asserted', description='人工关系证据类型')


class QuestionTagModel(BankModel):
    question_id: int
    tag_type: str
    tag_name: str
    relation_type: str = 'provider_asserted'
    evidence_type: Literal['query_membership', 'provider_asserted']


class QuestionDetailModel(QuestionModel):
    answer_html: str | None = Field(default=None, description='答案 HTML')
    analysis_html: str | None = Field(default=None, description='解析 HTML')
    catalog_ids: list[int] = Field(default_factory=list, description='题目所属目录')
    tags: list[QuestionTagModel] = Field(default_factory=list, description='题目标签')


class QuestionWriteModel(QuestionModel):
    """题目管理写入模型。

    Source identity and synchronization columns are accepted for response
    compatibility but are rejected by the service for all client writes.
    ``raw_data_json`` is deliberately not part of the public response model.
    """

    answer_html: str | None = Field(default=None, description='答案 HTML')
    analysis_html: str | None = Field(default=None, description='解析 HTML')
    raw_data_json: dict | list | None = Field(default=None, description='来源原始 JSON')
    catalog_ids: list[int] | None = Field(default=None, description='题目所属目录')
    tags: list[QuestionTagInputModel] | None = Field(default=None, description='题目标签')


class QuestionPageQueryModel(BankPageQueryModel):
    usable_only: bool = Field(default=False, alias="usableOnly", description="只查询启用范围内已检查可用题")
    subject_id: int | None = Field(default=None, gt=0)
    textbook_id: int | None = Field(default=None, alias='textbookId', gt=0, description='教材主键')
    catalog_id: int | None = Field(default=None, alias='catalogId', gt=0, description='目录主键')
    keyword: str | None = Field(default=None, max_length=200, description='关键词')
    question_type: str | None = Field(default=None, alias='questionType', max_length=100, description='题型')
    difficulty: str | None = Field(default=None, max_length=20, description='难度')
    difficulty_min: Decimal | None = Field(default=None, alias='difficultyMin', ge=Decimal('0'), le=Decimal('1'))
    difficulty_max: Decimal | None = Field(default=None, alias='difficultyMax', ge=Decimal('0'), le=Decimal('1'))
    year: int | None = Field(default=None, ge=1900, le=2200, description='年份')
    grade: str | None = Field(default=None, max_length=20, description='年级中文值')
    term: str | None = Field(default=None, max_length=20, description='学期中文值')
    province: str | None = Field(default=None, max_length=50)
    city: str | None = Field(default=None, max_length=100)
    exam_type: str | None = Field(default=None, alias='examType', max_length=50)
    source_provider: str | None = Field(default=None, alias='sourceProvider', max_length=64)
    status: Literal['0', '1'] | None = Field(default=None, description='显式状态筛选')
    include_disabled: bool = Field(default=False, alias='includeDisabled', description='是否包含停用题目')
    scene: list[str] = Field(default_factory=list, validation_alias=AliasChoices('scene', 'scene[]'))
    category: list[str] = Field(default_factory=list, validation_alias=AliasChoices('category', 'category[]'))
    exam_method: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices('examMethod', 'examMethod[]'),
    )
    sort: QuestionSort = Field(default='questionId', description='白名单排序字段')
    order: SortOrder = Field(default='desc', description='排序方向')


class QuestionAssetModel(BankModel):
    asset_id: int
    question_id: int
    source_provider: str
    asset_key: str
    asset_type: str
    source_url: str | None = None
    storage_path: str | None = None
    mime_type: str | None = None
    file_name: str | None = None
    file_hash: str | None = None
    width: int | None = None
    height: int | None = None
    sort_order: int = 0
    download_status: str
    error_message: str | None = None
    last_seen_at: datetime | None = None
    create_time: datetime | None = None
    update_time: datetime | None = None


BatchStatus = Literal[
    'building',
    'validating',
    'validated',
    'approval_pending',
    'approved',
    'publishing',
    'published',
    'failed',
    'archived',
    'rolled_back',
]


class BatchModel(BankModel):
    batch_id: int | None = None
    batch_no: str | None = None
    batch_type: Literal['full', 'rollback'] | None = None
    source_provider: str | None = None
    schema_version: str | None = None
    artifact_uri: str | None = None
    artifact_sha256: str | None = None
    status: BatchStatus | None = None
    previous_batch_id: int | None = None
    restored_from_batch_id: int | None = None
    question_count: int | None = None
    catalog_count: int | None = None
    tag_count: int | None = None
    asset_count: int | None = None
    validation_report_json: dict | list | None = None
    diff_report_json: dict | list | None = None
    error_message: str | None = None
    approved_by: str | None = None
    approved_at: datetime | None = None
    started_at: datetime | None = None
    validated_at: datetime | None = None
    published_at: datetime | None = None
    archived_at: datetime | None = None
    create_time: datetime | None = None
    update_time: datetime | None = None


class BatchPageQueryModel(BankPageQueryModel):
    batch_no: str | None = Field(default=None, alias='batchNo', max_length=128)
    batch_type: Literal['full', 'rollback'] | None = Field(default=None, alias='batchType')
    status: BatchStatus | None = None
    source_provider: str | None = Field(default=None, alias='sourceProvider', max_length=64)


# 同步管理只允许这四类候选进入审核流。不要把任意表名交给客户端，
# 这样服务端可以为每一种来源/正式表建立固定的字段白名单映射。
SyncEntityType = Literal['version', 'textbook', 'catalog', 'question']
SyncComparisonStatus = Literal['new', 'changed', 'unchanged', 'conflict']
SyncReviewStatus = Literal['pending', 'approved', 'rejected', 'stale']
SyncReviewAction = Literal['approve', 'reject', 'approved', 'rejected']


class SyncCompareQueryModel(BankPageQueryModel):
    keyword: str | None = Field(default=None, max_length=200, description='候选名称或来源 ID')
    comparison_status: SyncComparisonStatus | None = Field(
        default=None, alias='comparisonStatus', description='对比状态'
    )
    review_status: SyncReviewStatus | None = Field(default=None, alias='reviewStatus', description='审核状态')
    status: SyncReviewStatus | None = Field(default=None, description='审核状态兼容参数')
    source_provider: str | None = Field(default=None, alias='sourceProvider', max_length=64)
    version_external_id: str | None = Field(
        default=None, alias='versionExternalId', max_length=128, description='版本来源 ID'
    )
    textbook_external_id: str | None = Field(
        default=None, alias='textbookExternalId', max_length=128, description='教材来源 ID'
    )
    metadata_run_id: int | None = Field(default=None, alias='metadataRunId', gt=0, description='绑定的元数据运行 ID')


class SyncReviewItemModel(BankModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        from_attributes=True,
        populate_by_name=True,
        extra='forbid',
    )

    external_id: str = Field(alias='externalId', min_length=1, max_length=128)
    source_provider: str | None = Field(default=None, alias='sourceProvider', max_length=64)
    staged_hash: str = Field(alias='stagedHash', min_length=64, max_length=64, pattern=r'^[0-9a-fA-F]{64}$')
    action: SyncReviewAction | None = None
    review_status: Literal['approved', 'rejected'] | None = Field(default=None, alias='reviewStatus')
    status: Literal['approved', 'rejected'] | None = None
    review_comment: str | None = Field(
        default=None,
        alias='reviewComment',
        validation_alias=AliasChoices('reviewComment', 'comment'),
        max_length=1000,
    )


class SyncReviewRequestModel(BankModel):
    """单条或批量审核请求。

    单条请求填写 externalId/stagedHash/action；批量请求填写 items。两种
    形式共用同一接口，服务端会在写入前重新读取 collector 候选。
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        from_attributes=True,
        populate_by_name=True,
        extra='forbid',
    )

    external_id: str | None = Field(default=None, alias='externalId', min_length=1, max_length=128)
    source_provider: str | None = Field(default=None, alias='sourceProvider', max_length=64)
    staged_hash: str | None = Field(
        default=None,
        alias='stagedHash',
        min_length=64,
        max_length=64,
        pattern=r'^[0-9a-fA-F]{64}$',
    )
    action: SyncReviewAction | None = None
    review_status: Literal['approved', 'rejected'] | None = Field(default=None, alias='reviewStatus')
    status: Literal['approved', 'rejected'] | None = None
    review_comment: str | None = Field(
        default=None,
        alias='reviewComment',
        validation_alias=AliasChoices('reviewComment', 'comment'),
        max_length=1000,
    )
    textbook_external_id: str | None = Field(
        default=None,
        alias='textbookExternalId',
        max_length=128,
        description='可选的教材来源 ID；目录/题目审核时用于再次校验范围',
    )
    items: list[SyncReviewItemModel] = Field(default_factory=list, max_length=500)


class SyncPageModel(BankModel):
    page_num: int = Field(alias='pageNum', ge=1)
    page_size: int = Field(alias='pageSize', ge=1, le=100)
    total: int = Field(ge=0)
    has_next: bool = Field(alias='hasNext')


class SyncSummaryModel(BankModel):
    total: int = Field(default=0, ge=0)
    new_count: int = Field(default=0, alias='newCount', ge=0)
    changed_count: int = Field(default=0, alias='changedCount', ge=0)
    unchanged_count: int = Field(default=0, alias='unchangedCount', ge=0)
    conflict_count: int = Field(default=0, alias='conflictCount', ge=0)
    pending_count: int = Field(default=0, alias='pendingCount', ge=0)
    approved_count: int = Field(default=0, alias='approvedCount', ge=0)
    rejected_count: int = Field(default=0, alias='rejectedCount', ge=0)
    stale_count: int = Field(default=0, alias='staleCount', ge=0)


class SyncCompareRowModel(BankModel):
    external_id: str = Field(alias='externalId')
    source_provider: str = Field(alias='sourceProvider')
    staged_hash: str = Field(alias='stagedHash')
    comparison_status: SyncComparisonStatus = Field(alias='comparisonStatus')
    review_status: SyncReviewStatus = Field(alias='reviewStatus')
    current_local_id: int | None = Field(default=None, alias='currentLocalId')
    candidate: dict[str, object] = Field(default_factory=dict)
    current: dict[str, object] | None = None
    changed_fields: list[str] = Field(default_factory=list, alias='changedFields')
    review_comment: str | None = Field(default=None, alias='reviewComment')
    collected_at: str | None = Field(default=None, alias='collectedAt')
    reviewed_by: str | None = Field(default=None, alias='reviewedBy')
    reviewed_at: datetime | None = Field(default=None, alias='reviewedAt')


class SyncCompareResponseModel(ResponseBaseModel):
    """同步对比接口的业务载荷（外层仍由 ResponseUtil 添加 code/msg）。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    summary: SyncSummaryModel
    rows: list[SyncCompareRowModel]
    page: SyncPageModel
    source_available: bool = Field(alias='sourceAvailable')
    source_message: str | None = Field(default=None, alias='sourceMessage')


class SyncMetadataTextbookSnapshotModel(BankModel):
    """One textbook candidate in a metadata-run snapshot.

    ``candidate`` and ``current`` deliberately remain projected dictionaries:
    the snapshot is a read-only comparison surface and must not expose raw
    collector payloads or imply that selecting an item writes the formal bank.
    """

    source_provider: str = Field(alias='sourceProvider')
    external_id: str = Field(alias='externalId')
    textbook_name: str | None = Field(default=None, alias='textbookName')
    candidate: dict[str, object] | None = None
    current: dict[str, object] | None = None
    staged_hash: str = Field(alias='stagedHash')
    comparison_status: SyncComparisonStatus = Field(alias='comparisonStatus')
    review_status: SyncReviewStatus = Field(alias='reviewStatus')
    changed_fields: list[str] = Field(default_factory=list, alias='changedFields')
    collected_at: str | None = Field(default=None, alias='collectedAt')


class SyncMetadataVersionSnapshotModel(BankModel):
    """One version group and the textbooks discovered under it."""

    source_provider: str = Field(alias='sourceProvider')
    external_id: str = Field(alias='externalId')
    version_name: str | None = Field(default=None, alias='versionName')
    candidate: dict[str, object] | None = None
    current: dict[str, object] | None = None
    staged_hash: str = Field(alias='stagedHash')
    comparison_status: SyncComparisonStatus = Field(alias='comparisonStatus')
    review_status: SyncReviewStatus = Field(alias='reviewStatus')
    changed_fields: list[str] = Field(default_factory=list, alias='changedFields')
    collected_at: str | None = Field(default=None, alias='collectedAt')
    textbooks: list[SyncMetadataTextbookSnapshotModel] = Field(default_factory=list)


class SyncMetadataSnapshotModel(ResponseBaseModel):
    """Bounded, read-only source metadata snapshot for the transfer UI."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    source_available: bool = Field(alias='sourceAvailable')
    source_message: str | None = Field(default=None, alias='sourceMessage')
    metadata_run_id: int | None = Field(default=None, alias='metadataRunId')
    collected_at: str | None = Field(default=None, alias='collectedAt')
    version_count: int = Field(default=0, alias='versionCount', ge=0)
    textbook_count: int = Field(default=0, alias='textbookCount', ge=0)
    versions: list[SyncMetadataVersionSnapshotModel] = Field(default_factory=list)


SyncTextbookOverviewMatchStatus = Literal['new', 'existing']


class SyncTextbookOverviewSummaryModel(BankModel):
    """Counts used by the read-only source/current textbook comparison page."""

    fetched_version_count: int = Field(default=0, alias='fetchedVersionCount', ge=0)
    fetched_textbook_count: int = Field(default=0, alias='fetchedTextbookCount', ge=0)
    new_version_count: int = Field(default=0, alias='newVersionCount', ge=0)
    existing_version_count: int = Field(default=0, alias='existingVersionCount', ge=0)
    new_textbook_count: int = Field(default=0, alias='newTextbookCount', ge=0)
    existing_textbook_count: int = Field(default=0, alias='existingTextbookCount', ge=0)
    current_version_count: int = Field(default=0, alias='currentVersionCount', ge=0)
    current_textbook_count: int = Field(default=0, alias='currentTextbookCount', ge=0)


class SyncTextbookOverviewFetchedTextbookModel(BankModel):
    """A textbook fetched by the selected metadata run."""

    source_provider: str = Field(alias='sourceProvider')
    external_id: str = Field(alias='externalId')
    textbook_name: str | None = Field(default=None, alias='textbookName')
    grade: str | None = None
    volume: str | None = None
    match_status: SyncTextbookOverviewMatchStatus = Field(alias='matchStatus')
    current_local_id: int | None = Field(default=None, alias='currentLocalId')


class SyncTextbookOverviewFetchedVersionModel(BankModel):
    """A version fetched by the selected metadata run and its textbooks."""

    source_provider: str = Field(alias='sourceProvider')
    external_id: str = Field(alias='externalId')
    version_name: str | None = Field(default=None, alias='versionName')
    match_status: SyncTextbookOverviewMatchStatus = Field(alias='matchStatus')
    current_local_id: int | None = Field(default=None, alias='currentLocalId')
    textbook_count: int = Field(default=0, alias='textbookCount', ge=0)
    textbooks: list[SyncTextbookOverviewFetchedTextbookModel] = Field(default_factory=list)


class SyncTextbookOverviewCurrentTextbookModel(BankModel):
    """A textbook in the current formal bank, including manual rows."""

    current_local_id: int = Field(alias='currentLocalId', gt=0)
    source_provider: str = Field(alias='sourceProvider')
    external_id: str | None = Field(default=None, alias='externalId')
    textbook_name: str | None = Field(default=None, alias='textbookName')
    grade: str | None = None
    volume: str | None = None


class SyncTextbookOverviewCurrentVersionModel(BankModel):
    """A version in the current formal bank and all of its textbooks."""

    current_local_id: int = Field(alias='currentLocalId', gt=0)
    source_provider: str = Field(alias='sourceProvider')
    external_id: str | None = Field(default=None, alias='externalId')
    version_name: str | None = Field(default=None, alias='versionName')
    textbook_count: int = Field(default=0, alias='textbookCount', ge=0)
    textbooks: list[SyncTextbookOverviewCurrentTextbookModel] = Field(default_factory=list)


class SyncTextbookOverviewModel(ResponseBaseModel):
    """Full fetched-vs-current textbook tree for the separate sync page."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    source_available: bool = Field(alias='sourceAvailable')
    source_message: str | None = Field(default=None, alias='sourceMessage')
    metadata_run_id: int | None = Field(default=None, alias='metadataRunId')
    collected_at: str | None = Field(default=None, alias='collectedAt')
    summary: SyncTextbookOverviewSummaryModel
    fetched_versions: list[SyncTextbookOverviewFetchedVersionModel] = Field(
        default_factory=list, alias='fetchedVersions'
    )
    current_versions: list[SyncTextbookOverviewCurrentVersionModel] = Field(
        default_factory=list, alias='currentVersions'
    )


class SyncReviewResultModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    updated: int = Field(ge=0)
    items: list[dict[str, object]] = Field(default_factory=list)


SyncRunStatus = Literal[
    'queued',
    'starting',
    'running',
    'cancelling',
    'completed',
    'failed',
    'blocked',
    'cancelled',
    'interrupted',
]
SyncRunType = Literal['metadata', 'content']
SyncRunPhase = Literal[
    'metadata',
    'catalogs_questions',
    'completed',
    'failed',
    'blocked',
    'cancelled',
    'interrupted',
]

# Independent synchronization task modules.  ``center`` is retained for the
# original /bank/sync/run/* API; the two values below are the task pages that
# have immutable, module-specific scopes.
SyncTaskModule = Literal['center', 'textbook', 'question']


class SyncTaskCreateModel(BankModel):
    """Common acknowledgement payload for a textbook task.

    The question task intentionally uses ``QuestionTaskCreateModel`` below
    and does not inherit this model: its public contract is *only*
    ``versionId`` and ``textbookIds``.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra='forbid',
    )

    acknowledge_source_policy: bool = Field(
        default=False,
        alias='acknowledgeSourcePolicy',
        description='确认已核对来源站规则、授权范围和内容使用边界',
    )


class QuestionTaskCreateModel(BankModel):
    """Create a question task from one formal version and its textbooks.

    No collector identifiers, URLs, commands, or acknowledgement switches
    are accepted from the client.  The service resolves all source identity
    and the textbook snapshot currently applied to the formal database.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra='forbid',
    )

    version_id: int = Field(alias='versionId', gt=0)
    textbook_ids: list[Annotated[int, Field(gt=0)]] = Field(alias='textbookIds', min_length=1, max_length=1)

    @model_validator(mode='before')
    @classmethod
    def accept_single_textbook(cls, value):
        # Accept the old single-element payload while rejecting ambiguity.
        if isinstance(value, dict) and ('textbookId' in value or 'textbook_id' in value):
            value = dict(value)
            if 'textbookIds' in value or 'textbook_ids' in value:
                raise ValueError('只能提供 textbookId 或单元素 textbookIds，不能同时提供')
            value['textbookIds'] = [value.pop('textbookId', value.pop('textbook_id', None))]
        return value
    limit_to_1000_pages: bool = Field(
        default=False,
        alias='limitTo1000Pages',
        description='每个目录最多请求 1000 页；达到边界后按策略正常结束当前目录',
    )


class SyncTaskPageQueryModel(BankPageQueryModel):
    subject_id: int | None = Field(default=None, gt=0)
    """Filters shared by the two independent task list pages."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )

    task_no: str | None = Field(default=None, alias='taskNo', max_length=64)
    status: SyncRunStatus | None = None
    version_name: str | None = Field(default=None, alias='versionName', max_length=100)
    create_time_start: str | None = Field(default=None, alias='createTimeStart', max_length=40)
    create_time_end: str | None = Field(default=None, alias='createTimeEnd', max_length=40)


class SyncTaskScopeModel(BankModel):
    subject_id: int = 1
    """One immutable textbook scope belonging to a task."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )

    scope_id: int | None = Field(default=None, alias='scopeId')
    run_id: int | None = Field(default=None, alias='runId')
    local_version_id: int | None = Field(default=None, alias='localVersionId')
    local_textbook_id: int | None = Field(default=None, alias='localTextbookId')
    version_id: int | None = Field(default=None, alias='versionId')
    textbook_id: int | None = Field(default=None, alias='textbookId')
    version_name_snapshot: str | None = Field(default=None, alias='versionNameSnapshot')
    textbook_name_snapshot: str | None = Field(default=None, alias='textbookNameSnapshot')
    version_name: str | None = Field(default=None, alias='versionName')
    textbook_name: str | None = Field(default=None, alias='textbookName')
    source_provider: str | None = Field(default=None, alias='sourceProvider')
    external_version_id: str | None = Field(default=None, alias='externalVersionId')
    external_textbook_id: str | None = Field(default=None, alias='externalTextbookId')
    metadata_run_id: int | None = Field(default=None, alias='metadataRunId')
    collector_job_id: str | None = Field(default=None, alias='collectorJobId')
    collector_run_id: int | None = Field(default=None, alias='collectorRunId')
    resume_from_collector_run_id: int | None = Field(
        default=None,
        alias='resumeFromCollectorRunId',
        description='可安全续采的上一次不完整 collector run ID',
    )
    resume_available: bool = Field(default=False, alias='resumeAvailable')
    status: SyncRunStatus = 'queued'
    catalog_count: int = Field(default=0, alias='catalogCount', ge=0)
    question_count: int = Field(default=0, alias='questionCount', ge=0)
    question_catalog_count: int = Field(default=0, alias='questionCatalogCount', ge=0)
    question_tag_count: int = Field(default=0, alias='questionTagCount', ge=0)
    question_asset_count: int = Field(default=0, alias='questionAssetCount', ge=0)
    snapshot_complete: bool = Field(default=False, alias='snapshotComplete')
    snapshot_locked_at: datetime | None = Field(default=None, alias='snapshotLockedAt')
    new_catalog_count: int = Field(default=0, alias='newCatalogCount', ge=0)
    changed_catalog_count: int = Field(default=0, alias='changedCatalogCount', ge=0)
    new_question_count: int = Field(default=0, alias='newQuestionCount', ge=0)
    changed_question_count: int = Field(default=0, alias='changedQuestionCount', ge=0)
    error_message: str | None = Field(default=None, alias='errorMessage')
    started_at: datetime | None = Field(default=None, alias='startedAt')
    finished_at: datetime | None = Field(default=None, alias='finishedAt')


class SyncTaskModel(BankModel):
    subject_id: int = 1
    """Public task status used by the independent task pages."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra='allow',
    )

    task_id: int = Field(alias='taskId', gt=0)
    queue_state: Literal['waiting', 'dispatched', 'settling', 'closed'] | None = None
    queue_not_before: datetime | None = None
    queue_reason: str | None = None
    task_no: str | None = Field(default=None, alias='taskNo')
    task_module: SyncTaskModule = Field(default='center', alias='taskModule')
    run_type: SyncRunType = Field(default='metadata', alias='runType')
    status: SyncRunStatus
    phase: SyncRunPhase
    progress: Decimal = Field(default=Decimal('0'), ge=0, le=100)
    progress_percent: Decimal = Field(default=Decimal('0'), alias='progressPercent', ge=0, le=100)
    acknowledge_source_policy: bool = Field(default=True, alias='acknowledgeSourcePolicy')
    metadata_run_id: int | None = Field(default=None, alias='metadataRunId')
    source_task_id: int | None = Field(default=None, alias='sourceTaskId')
    retry_of_run_id: int | None = Field(default=None, alias='retryOfRunId')
    retry_of_task_id: int | None = Field(default=None, alias='retryOfTaskId')
    collector_job_id: str | None = Field(default=None, alias='collectorJobId')
    limit_to_1000_pages: bool = Field(default=False, alias='limitTo1000Pages')
    page_limit_reached: bool = Field(default=False, alias='pageLimitReached')
    version_id: int | None = Field(default=None, alias='versionId')
    version_name: str | None = Field(default=None, alias='versionName')
    textbook_count: int = Field(default=0, alias='textbookCount', ge=0)
    textbook_names: list[str] = Field(default_factory=list, alias='textbookNames')
    scope_items: list[SyncTaskScopeModel] = Field(default_factory=list, alias='scopeItems')
    fetched_version_count: int = Field(default=0, alias='fetchedVersionCount', ge=0)
    fetched_textbook_count: int = Field(default=0, alias='fetchedTextbookCount', ge=0)
    new_version_count: int = Field(default=0, alias='newVersionCount', ge=0)
    new_textbook_count: int = Field(default=0, alias='newTextbookCount', ge=0)
    total_versions: int = Field(default=0, alias='totalVersions', ge=0)
    total_textbooks: int = Field(default=0, alias='totalTextbooks', ge=0)
    completed_textbooks: int = Field(default=0, alias='completedTextbooks', ge=0)
    catalog_count: int = Field(default=0, alias='catalogCount', ge=0)
    new_catalog_count: int = Field(default=0, alias='newCatalogCount', ge=0)
    changed_catalog_count: int = Field(default=0, alias='changedCatalogCount', ge=0)
    question_count: int = Field(default=0, alias='questionCount', ge=0)
    question_catalog_count: int = Field(default=0, alias='questionCatalogCount', ge=0)
    question_tag_count: int = Field(default=0, alias='questionTagCount', ge=0)
    question_asset_count: int = Field(default=0, alias='questionAssetCount', ge=0)
    snapshot_complete: bool = Field(default=False, alias='snapshotComplete')
    snapshot_locked_at: datetime | None = Field(default=None, alias='snapshotLockedAt')
    new_question_count: int = Field(default=0, alias='newQuestionCount', ge=0)
    changed_question_count: int = Field(default=0, alias='changedQuestionCount', ge=0)
    current_textbook_id: str | None = Field(default=None, alias='currentTextbookId')
    current_textbook_name: str | None = Field(default=None, alias='currentTextbookName')
    log_tail: str | None = Field(default=None, alias='logTail')
    logs: list[str] = Field(default_factory=list)
    error_message: str | None = Field(default=None, alias='errorMessage')
    created_by: str | None = Field(default=None, alias='createdBy')
    started_at: datetime | None = Field(default=None, alias='startedAt')
    finished_at: datetime | None = Field(default=None, alias='finishedAt')
    create_time: datetime | None = Field(default=None, alias='createTime')
    update_time: datetime | None = Field(default=None, alias='updateTime')
    eligible: bool = Field(default=False, description='是否具备应用正式教材快照的条件')
    is_current: bool = Field(default=False, alias='isCurrent', description='是否为当前正式教材快照')
    current_task_id: int | None = Field(default=None, alias='currentTaskId')
    current_metadata_run_id: int | None = Field(default=None, alias='currentMetadataRunId')
    current_snapshot_hash: str | None = Field(default=None, alias='currentSnapshotHash')
    applied_at: datetime | None = Field(default=None, alias='appliedAt')
    suggested_action: str | None = Field(default=None, alias='suggestedAction')
    eligibility_message: str | None = Field(default=None, alias='eligibilityMessage')
    resume_from_collector_run_id: int | None = Field(
        default=None,
        alias='resumeFromCollectorRunId',
        description='任务中可安全续采的上一次不完整 collector run ID',
    )
    resume_available: bool = Field(default=False, alias='resumeAvailable')
    live_progress: dict[str, object] | None = Field(default=None, alias='liveProgress')
    live_progress_by_scope: dict[str, dict[str, object]] = Field(
        default_factory=dict,
        alias='liveProgressByScope',
    )


class TextbookApplyRequestModel(BankModel):
    """Optimistic concurrency token for applying a textbook task snapshot."""

    expected_current_task_id: int | None = Field(default=None, alias='expectedCurrentTaskId', gt=0)


class QuestionApplyRequestModel(BankModel):
    """Optimistic-concurrency values for applying a question task.

    ``expectedCurrentTaskId`` is retained for older single-scope clients.
    New clients send ``expectedStateToken`` as either one string (single
    scope) or a map keyed by external/local textbook ID (multi-scope).
    ``None`` values are accepted for a first apply where no state row has a
    token yet.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra='forbid',
    )

    expected_current_task_id: int | None = Field(default=None, alias='expectedCurrentTaskId', gt=0)
    expected_review_revision: int | None = Field(default=None, alias='expectedReviewRevision', ge=0)
    expected_state_token: str | dict[str, str | None] | None = Field(
        default=None,
        alias='expectedStateToken',
    )


class QuestionApplyResponseModel(BankModel):
    """Scope-aware result returned by the question snapshot application."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra='allow',
    )

    action: Literal['apply', 'rollback', 'restore', 'alreadyApplied']
    already_applied: bool = Field(default=False, alias='alreadyApplied')
    target_task_id: int = Field(alias='targetTaskId', gt=0)
    previous_task_id: int | None = Field(default=None, alias='previousTaskId')
    collector_run_id: int | None = Field(default=None, alias='collectorRunId')
    snapshot_hash: str | None = Field(default=None, alias='snapshotHash')
    state_token: str | dict[str, str | None] | None = Field(default=None, alias='stateToken')
    current_state_token: str | dict[str, str | None] | None = Field(default=None, alias='currentStateToken')
    scopes: list[dict[str, object]] = Field(default_factory=list)
    affected_textbooks: list[dict[str, object]] = Field(default_factory=list, alias='affectedTextbooks')
    stats: dict[str, dict[str, int]] = Field(default_factory=dict)


class TextbookApplyResponseModel(BankModel):
    """Result and row counts returned by the formal textbook application."""

    action: Literal['apply', 'rollback', 'restore']
    already_applied: bool = Field(alias='alreadyApplied')
    target_task_id: int = Field(alias='targetTaskId', gt=0)
    previous_task_id: int | None = Field(default=None, alias='previousTaskId')
    metadata_run_id: int = Field(alias='metadataRunId', gt=0)
    snapshot_hash: str = Field(alias='snapshotHash', min_length=64, max_length=64)
    versions: dict[str, int] = Field(default_factory=dict)
    textbooks: dict[str, int] = Field(default_factory=dict)
    stats: dict[str, dict[str, int]] = Field(default_factory=dict)


class TaskComparisonQueryModel(BankPageQueryModel):
    """Server-side filters for immutable question snapshots."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    scope_id: int | None = Field(default=None, alias='scopeId', gt=0)
    textbook_id: int | None = Field(default=None, alias='textbookId', gt=0)
    external_textbook_id: str | None = Field(default=None, alias='externalTextbookId', max_length=64)
    collector_run_id: int | None = Field(default=None, alias='collectorRunId', gt=0)
    catalog_id: str | None = Field(default=None, alias='catalogId', max_length=64)
    question_type: str | None = Field(default=None, alias='questionType', max_length=80)
    keyword: str | None = Field(default=None, max_length=120)
    comparison_status: str | None = Field(default=None, alias='comparisonStatus', max_length=30)
    source_provider: str | None = Field(default=None, alias='sourceProvider', max_length=64)
    selection: Literal['included', 'excluded', 'all'] = 'included'


class QuestionTaskSelectionModel(BankModel):
    external_question_ids: list[str] = Field(alias='externalQuestionIds', min_length=1, max_length=500)
    excluded: bool = True


class TaskOptionsModel(ResponseBaseModel):
    """Question task creation options grouped by formal version."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    versions: list[dict[str, object]] = Field(default_factory=list)


class TaskComparisonResponseModel(ResponseBaseModel):
    """Loose response shell for evolving collector comparison projections."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra='allow')


# Descriptive aliases kept for integrations that use request/response naming
# rather than the shorter ``*Model`` names used by this plugin.
TextbookTaskCreateRequestModel = SyncTaskCreateModel
QuestionTaskCreateRequestModel = QuestionTaskCreateModel
QuestionApplyRequest = QuestionApplyRequestModel
QuestionApplyResponse = QuestionApplyResponseModel
SyncTaskQueryModel = SyncTaskPageQueryModel
TaskScopeModel = SyncTaskScopeModel
TaskStatusModel = SyncTaskModel


class SyncRunStartRequestModel(BankModel):
    """开始来源采集的唯一公开选项。

    The command, script and collector paths are deliberately server-owned.
    The acknowledgement is explicit because this action accesses a third-party
    source and can issue a long-running crawl.
    """

    acknowledge_source_policy: bool = Field(
        default=False,
        alias='acknowledgeSourcePolicy',
        description='确认已核对来源站规则、授权范围和内容使用边界',
    )


class SyncContentRunStartRequestModel(BankModel):
    """Start content collection for an explicit metadata snapshot selection."""

    acknowledge_source_policy: bool = Field(
        default=False,
        alias='acknowledgeSourcePolicy',
        description='确认已核对来源站规则、授权范围和内容使用边界',
    )
    metadata_run_id: int = Field(alias='metadataRunId', gt=0, description='成功的元数据运行 ID')
    textbook_external_ids: list[str] = Field(
        alias='textbookExternalIds',
        min_length=1,
        max_length=1,
        description='用户明确选择的教材来源 ID，不能重复',
    )


class SyncRunPageQueryModel(BankPageQueryModel):
    status: SyncRunStatus | None = Field(default=None, description='同步任务状态')
    run_type: SyncRunType | None = Field(default=None, alias='runType', description='同步任务类型')


class SyncRunModel(BankModel):
    """Persistent status exposed to the polling panel.

    Internal worker tokens and process IDs are intentionally not part of the
    public model; cancellation is authorized by the task identity and checked
    again by the worker before signalling its process group.
    """

    run_id: int = Field(alias='runId')
    run_type: SyncRunType = Field(default='metadata', alias='runType')
    status: SyncRunStatus
    phase: SyncRunPhase
    acknowledge_source_policy: bool = Field(alias='acknowledgeSourcePolicy')
    metadata_run_id: int | None = Field(default=None, alias='metadataRunId')
    total_versions: int = Field(default=0, alias='totalVersions', ge=0)
    completed_versions: int = Field(default=0, alias='completedVersions', ge=0)
    total_textbooks: int = Field(default=0, alias='totalTextbooks', ge=0)
    completed_textbooks: int = Field(default=0, alias='completedTextbooks', ge=0)
    catalog_count: int = Field(default=0, alias='catalogCount', ge=0)
    question_count: int = Field(default=0, alias='questionCount', ge=0)
    question_catalog_count: int = Field(default=0, alias='questionCatalogCount', ge=0)
    question_tag_count: int = Field(default=0, alias='questionTagCount', ge=0)
    question_asset_count: int = Field(default=0, alias='questionAssetCount', ge=0)
    snapshot_complete: bool = Field(default=False, alias='snapshotComplete')
    snapshot_locked_at: datetime | None = Field(default=None, alias='snapshotLockedAt')
    current_textbook_id: str | None = Field(default=None, alias='currentTextbookId')
    current_textbook_name: str | None = Field(default=None, alias='currentTextbookName')
    progress_percent: Decimal = Field(default=Decimal('0'), alias='progressPercent', ge=0, le=100)
    log_tail: str | None = Field(default=None, alias='logTail')
    error_message: str | None = Field(default=None, alias='errorMessage')
    resume_from_collector_run_id: int | None = Field(default=None, alias='resumeFromCollectorRunId')
    resume_available: bool = Field(default=False, alias='resumeAvailable')
    created_by: str | None = Field(default=None, alias='createdBy')
    started_at: datetime | None = Field(default=None, alias='startedAt')
    finished_at: datetime | None = Field(default=None, alias='finishedAt')
    create_time: datetime | None = Field(default=None, alias='createTime')
    update_time: datetime | None = Field(default=None, alias='updateTime')
