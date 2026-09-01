"""Read-only collector comparison and synchronization review workflow.

The collector is an evidence store exposed through its HTTP API. The only
writes performed here are review decisions in qb_sync_review; this module
never publishes or mutates the current seven bank tables.
"""
from __future__ import annotations

import asyncio
import hashlib
import html
import json
import re
from collections import Counter
from collections.abc import Mapping
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from exceptions.exception import ServiceException
from plugins.bank.dao.sync_dao import SyncReviewDao
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.entity.vo.bank_vo import (
    SyncCompareQueryModel,
    SyncEntityType,
    SyncReviewItemModel,
    SyncReviewRequestModel,
)
from plugins.bank.service.collector_client import CollectorClient

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


PROVIDER = 'zujuan'
MAX_METADATA_VERSIONS = 1000
MAX_METADATA_TEXTBOOKS = 5000
MAX_COMPARE_CANDIDATES = 20000
_SAFE_TEXT_RE = re.compile(r'<[^>]*>')
_TABLES = {
    'version': 'source_textbook_versions',
    'textbook': 'source_textbooks',
    'catalog': 'textbook_nodes',
    'question': 'questions',
}

_VERSION_CURRENT_COLUMNS = (
    QbTextbookVersion.version_id,
    QbTextbookVersion.source_provider,
    QbTextbookVersion.external_version_id,
    QbTextbookVersion.version_name,
    QbTextbookVersion.source_url,
    QbTextbookVersion.is_new,
    QbTextbookVersion.sort_order,
    QbTextbookVersion.status,
)
_TEXTBOOK_CURRENT_COLUMNS = (
    QbTextbook.textbook_id,
    QbTextbook.version_id,
    QbTextbook.source_provider,
    QbTextbook.external_textbook_id,
    QbTextbook.textbook_name,
    QbTextbook.grade,
    QbTextbook.volume,
    QbTextbook.source_url,
    QbTextbook.sort_order,
    QbTextbook.status,
)
_CATALOG_CURRENT_COLUMNS = (
    QbCatalogNode.catalog_id,
    QbCatalogNode.textbook_id,
    QbCatalogNode.parent_id,
    QbCatalogNode.source_provider,
    QbCatalogNode.external_node_id,
    QbCatalogNode.node_name,
    QbCatalogNode.node_type,
    QbCatalogNode.source_url,
    QbCatalogNode.sort_order,
    QbCatalogNode.status,
)
_QUESTION_CURRENT_COLUMNS = (
    QbQuestion.question_id,
    QbQuestion.source_provider,
    QbQuestion.external_question_id,
    QbQuestion.source_url,
    QbQuestion.source_question_no,
    QbQuestion.source_text,
    QbQuestion.paper_name,
    QbQuestion.question_type,
    QbQuestion.difficulty,
    QbQuestion.difficulty_coefficient,
    QbQuestion.content_hash,
)


def _pick(row: Mapping[str, Any] | object, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(row, Mapping):
            if name in row:
                return row[name]
        elif hasattr(row, name):
            return getattr(row, name)
    return default


def _provider_value(row: Mapping[str, Any] | object) -> str:
    return str(_pick(row, 'provider', 'source_provider', default='') or '').strip()


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime,)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    # Decimal and other SQL scalar values have a stable string form, while
    # avoiding accidental serialization of ORM internals.
    return str(value)


def _sort_order(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _canonical_hash(value: dict[str, Any]) -> str:
    payload = json.dumps(_jsonable(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _safe_snippet(value: Any, limit: int = 360) -> str | None:
    if value is None:
        return None
    text = html.unescape(_SAFE_TEXT_RE.sub(' ', str(value)))
    text = ' '.join(text.split())
    return text[:limit] if text else None


def _version_candidate(row: dict[str, Any]) -> dict[str, Any] | None:
    external_id = _pick(row, 'external_version_id', 'externalVersionId')
    provider = _provider_value(row)
    if not provider or external_id is None or not str(external_id).strip():
        return None
    return {
        'sourceProvider': provider,
        'externalId': str(external_id),
        'versionName': _pick(row, 'version_name', 'versionName'),
        'sourceUrl': _pick(row, 'source_url', 'sourceUrl'),
        'isNew': _pick(row, 'is_new', 'isNew'),
        'sortOrder': _pick(row, 'sort_order', 'sortOrder', default=0),
        'status': _pick(row, 'status', default='0') or '0',
        'firstSeenAt': _pick(row, 'first_seen_at', 'firstSeenAt'),
        'lastSeenAt': _pick(row, 'last_seen_at', 'lastSeenAt'),
    }


def _textbook_candidate(row: dict[str, Any]) -> dict[str, Any] | None:
    external_id = _pick(row, 'external_textbook_id', 'externalTextbookId')
    provider = _provider_value(row)
    if not provider or external_id is None or not str(external_id).strip():
        return None
    return {
        'sourceProvider': provider,
        'externalId': str(external_id),
        'versionExternalId': _pick(row, 'version_external_id', 'versionExternalId'),
        'textbookName': _pick(row, 'textbook_name', 'textbookName'),
        'grade': _pick(row, 'grade'),
        'volume': _pick(row, 'volume'),
        'sourceUrl': _pick(row, 'source_url', 'sourceUrl'),
        'sortOrder': _pick(row, 'sort_order', 'sortOrder', default=0),
        'status': _pick(row, 'status', default='0') or '0',
        'bootstrapChapterExternalId': _pick(row, 'bootstrap_chapter_external_id', 'bootstrapChapterExternalId'),
        'firstSeenAt': _pick(row, 'first_seen_at', 'firstSeenAt'),
        'lastSeenAt': _pick(row, 'last_seen_at', 'lastSeenAt'),
    }


def _catalog_candidate(row: dict[str, Any]) -> dict[str, Any] | None:
    external_id = _pick(row, 'external_id', 'external_node_id', 'externalId')
    provider = _provider_value(row)
    if not provider or external_id is None or not str(external_id).strip():
        return None
    return {
        'sourceProvider': provider,
        'externalId': str(external_id),
        'textbookExternalId': _pick(row, 'textbook_external_id', 'textbookExternalId'),
        'parentExternalId': _pick(row, 'parent_external_id', 'parentExternalId'),
        'nodeLevel': _pick(row, 'node_level', 'nodeLevel'),
        'nodeType': _pick(row, 'node_type', 'nodeType', default='other') or 'other',
        'nodeName': _pick(row, 'name', 'node_name', 'nodeName'),
        'sourcePath': _pick(row, 'source_path', 'sourcePath'),
        'sourceUrl': _pick(row, 'source_url', 'sourceUrl', 'source_path', 'sourcePath'),
        'sortOrder': _pick(row, 'sort_order', 'sortOrder', default=0),
        # Older textbook_nodes schemas did not have a status column.  The
        # collector treats observed nodes as enabled in that case so they do
        # not compare as changed forever against formal status='0'.
        'status': _pick(row, 'status', default='0') or '0',
        'firstSeenAt': _pick(row, 'first_seen_at', 'firstSeenAt'),
        'lastSeenAt': _pick(row, 'last_seen_at', 'lastSeenAt'),
    }


def _question_candidate(row: dict[str, Any]) -> dict[str, Any] | None:
    external_id = _pick(row, 'external_id', 'external_question_id', 'externalId')
    provider = _provider_value(row)
    if not provider or external_id is None or not str(external_id).strip():
        return None
    plain_text = _pick(row, 'plain_text', 'plainText')
    candidate = {
        'sourceProvider': provider,
        'externalId': str(external_id),
        'chapterId': _pick(row, 'chapter_id', 'chapterId'),
        'detailUrl': _pick(row, 'detail_url', 'detailUrl'),
        'sourceShort': _pick(row, 'source_short', 'sourceShort'),
        'sourceName': _pick(row, 'source_title', 'sourceTitle', 'source_short', 'sourceShort'),
        'sourceUrl': _pick(row, 'source_url', 'sourceUrl'),
        'sourceQuestionNo': _pick(row, 'source_question_no', 'sourceQuestionNo'),
        'questionType': _pick(row, 'question_type', 'questionType'),
        'difficulty': _pick(row, 'difficulty_label', 'difficulty', 'difficultyLabel'),
        'difficultyCoefficient': _pick(row, 'ease_coefficient', 'difficulty_coefficient', 'difficultyCoefficient'),
        'contentHash': _pick(row, 'content_hash', 'contentHash', 'detail_content_hash'),
        'plainTextSnippet': _safe_snippet(plain_text),
        'detailFetched': _pick(row, 'detail_fetched', 'detailFetched'),
        'subquestionCount': _pick(row, 'subquestion_count', 'subquestionCount'),
        'isNew': _pick(row, 'is_new', 'isNew'),
        'providerUpdatedAt': _pick(row, 'provider_updated_at', 'providerUpdatedAt'),
        'firstSeenAt': _pick(row, 'first_seen_at', 'firstSeenAt'),
        'lastSeenAt': _pick(row, 'last_seen_at', 'lastSeenAt'),
    }
    # The collector may include this bounded boolean when a scoped question
    # query was joined through an authoritative question-catalog relation.
    # Preserve it only as an internal filter marker; it is not part of the
    # public candidate or staged hash.
    scope_matched = _pick(row, 'textbook_scope_matched', 'textbookScopeMatched', 'scopeMatched')
    if scope_matched is not None:
        if isinstance(scope_matched, str):
            scope_matched = scope_matched.strip().lower() not in {'', '0', 'false', 'no', 'off'}
        else:
            scope_matched = bool(scope_matched)
        candidate['_textbookScopeMatched'] = scope_matched
    return candidate


_CANDIDATE_BUILDERS = {
    'version': _version_candidate,
    'textbook': _textbook_candidate,
    'catalog': _catalog_candidate,
    'question': _question_candidate,
}

# Fields that can be compared with formal table rows.  Collector-only
# timestamps and raw fields are intentionally absent; a source rescan that
# merely updates last_seen_at should not create a false data change.
_COMPARE_FIELDS = {
    'version': ('sourceProvider', 'externalId', 'versionName', 'sourceUrl', 'isNew', 'sortOrder', 'status'),
    'textbook': (
        'sourceProvider',
        'externalId',
        'versionExternalId',
        'textbookName',
        'grade',
        'volume',
        'sourceUrl',
        'sortOrder',
        'status',
    ),
    'catalog': (
        'sourceProvider',
        'externalId',
        'textbookExternalId',
        'parentExternalId',
        'nodeName',
        'nodeType',
        'sourceUrl',
        'sortOrder',
        'status',
    ),
    'question': (
        'sourceProvider',
        'externalId',
        'sourceUrl',
        'sourceQuestionNo',
        'sourceName',
        'questionType',
        'difficulty',
        'difficultyCoefficient',
        'contentHash',
    ),
}
_HASH_FIELDS = {
    'version': _COMPARE_FIELDS['version'],
    'textbook': _COMPARE_FIELDS['textbook'] + ('bootstrapChapterExternalId',),
    'catalog': _COMPARE_FIELDS['catalog'] + ('nodeLevel', 'sourcePath'),
    'question': _COMPARE_FIELDS['question'] + ('plainTextSnippet', 'chapterId', 'detailFetched'),
}


def _semantic(candidate: dict[str, Any], entity_type: str, *, for_hash: bool = False) -> dict[str, Any]:
    fields = _HASH_FIELDS[entity_type] if for_hash else _COMPARE_FIELDS[entity_type]
    return {field: _jsonable(candidate.get(field)) for field in fields}


def _changed_fields(candidate: dict[str, Any], current: dict[str, Any] | None, entity_type: str) -> list[str]:
    if current is None:
        return []
    return [
        field
        for field in _COMPARE_FIELDS[entity_type]
        if _jsonable(candidate.get(field)) != _jsonable(current.get(field))
    ]


def _formal_version(row: Mapping[str, Any] | QbTextbookVersion) -> dict[str, Any]:
    return {
        'sourceProvider': _pick(row, 'source_provider'),
        'externalId': _pick(row, 'external_version_id'),
        'versionName': _pick(row, 'version_name'),
        'sourceUrl': _pick(row, 'source_url'),
        'isNew': _pick(row, 'is_new'),
        'sortOrder': _pick(row, 'sort_order'),
        'status': _pick(row, 'status'),
        'currentLocalId': _pick(row, 'version_id'),
    }


def _formal_textbook(
    row: Mapping[str, Any] | QbTextbook,
    version_external_id: str | None,
) -> dict[str, Any]:
    return {
        'sourceProvider': _pick(row, 'source_provider'),
        'externalId': _pick(row, 'external_textbook_id'),
        'versionExternalId': version_external_id,
        'textbookName': _pick(row, 'textbook_name'),
        'grade': _pick(row, 'grade'),
        'volume': _pick(row, 'volume'),
        'sourceUrl': _pick(row, 'source_url'),
        'sortOrder': _pick(row, 'sort_order'),
        'status': _pick(row, 'status'),
        'currentLocalId': _pick(row, 'textbook_id'),
    }


def _formal_catalog(
    row: Mapping[str, Any] | QbCatalogNode,
    textbook_external_id: str | None,
    parent_external_id: str | None,
) -> dict[str, Any]:
    return {
        'sourceProvider': _pick(row, 'source_provider'),
        'externalId': _pick(row, 'external_node_id'),
        'textbookExternalId': textbook_external_id,
        'parentExternalId': parent_external_id,
        'nodeName': _pick(row, 'node_name'),
        'nodeType': _pick(row, 'node_type'),
        'sourceUrl': _pick(row, 'source_url'),
        'sortOrder': _pick(row, 'sort_order'),
        'status': _pick(row, 'status'),
        'currentLocalId': _pick(row, 'catalog_id'),
    }


def _formal_question(row: Mapping[str, Any] | QbQuestion) -> dict[str, Any]:
    return {
        'sourceProvider': _pick(row, 'source_provider'),
        'externalId': _pick(row, 'external_question_id'),
        'sourceUrl': _pick(row, 'source_url'),
        'sourceQuestionNo': _pick(row, 'source_question_no'),
        # The collector uses source_title and falls back to source_short.
        # Publisher persists those as paper_name and source_text respectively,
        # so the formal-side comparison must mirror the same fallback.
        'sourceName': _pick(row, 'paper_name') or _pick(row, 'source_text'),
        'questionType': _pick(row, 'question_type'),
        'difficulty': _pick(row, 'difficulty'),
        'difficultyCoefficient': _pick(row, 'difficulty_coefficient'),
        'contentHash': _pick(row, 'content_hash'),
        # Current question projection intentionally has no long HTML/text
        # columns; the source side already supplies a bounded safe summary.
        'plainTextSnippet': _safe_snippet(_pick(row, 'plain_text')),
        'currentLocalId': _pick(row, 'question_id'),
    }


class SyncService:
    """Comparison and review operations for the synchronization UI."""

    @classmethod
    async def _read_candidates(
        cls,
        entity_type: str,
        source_provider: str | None = None,
        metadata_run_id: int | None = None,
        textbook_external_id: str | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        payload = await asyncio.to_thread(
            CollectorClient().candidates,
            entity_type,
            source_provider=source_provider,
            metadata_run_id=metadata_run_id,
            textbook_external_id=textbook_external_id,
        )
        if not isinstance(payload, Mapping):
            raise ServiceException(message='collector API 候选数据结构不正确')
        available = bool(payload.get('available'))
        message = str(payload.get('message') or '')
        raw_rows = payload.get('rows')
        if not isinstance(raw_rows, list) or any(not isinstance(row, dict) for row in raw_rows):
            raise ServiceException(message='collector API 候选数据结构不正确')
        rows = raw_rows
        if len(rows) > MAX_COMPARE_CANDIDATES:
            raise ServiceException(
                message=(f'{entity_type} 候选数量超过安全上限 {MAX_COMPARE_CANDIDATES}，请缩小同步范围后重试')
            )
        builder = _CANDIDATE_BUILDERS[entity_type]
        candidates = [built for row in rows if (built := builder(row)) is not None]
        skipped = len(rows) - len(candidates)
        if skipped:
            message = f'{message}；已跳过 {skipped} 条缺少稳定来源 ID 的候选'
        candidates.sort(key=lambda item: (str(item.get('sourceProvider') or ''), str(item.get('externalId') or '')))
        return available, message, candidates

    @classmethod
    async def _metadata_source_rows(
        cls,
        metadata_run_id: int | None,
    ) -> tuple[bool, bool, str, str, list[dict[str, Any]], list[dict[str, Any]], dict[str, Any] | None, str]:
        """Read one coherent metadata snapshot through the collector API."""

        payload = await asyncio.to_thread(CollectorClient().metadata_snapshot, metadata_run_id)
        if not isinstance(payload, Mapping):
            raise ServiceException(message='collector API 元数据快照结构不正确')
        version_rows = payload.get('versions')
        textbook_rows = payload.get('textbooks')
        run = payload.get('run')
        if not isinstance(version_rows, list) or any(not isinstance(row, dict) for row in version_rows):
            raise ServiceException(message='collector API 版本快照结构不正确')
        if not isinstance(textbook_rows, list) or any(not isinstance(row, dict) for row in textbook_rows):
            raise ServiceException(message='collector API 教材快照结构不正确')
        if run is not None and not isinstance(run, dict):
            raise ServiceException(message='collector API 元数据运行结构不正确')
        if metadata_run_id is not None and run is not None:
            remote_run_id = run.get('id', run.get('runId', run.get('metadataRunId')))
            try:
                if isinstance(remote_run_id, bool) or int(remote_run_id) != int(metadata_run_id):
                    raise ServiceException(message='collector API 元数据运行 ID 不一致')
            except (TypeError, ValueError) as exc:
                raise ServiceException(message='collector API 元数据运行 ID 无效') from exc
        available = bool(payload.get('available'))
        return (
            available,
            available,
            str(payload.get('message') or ''),
            '',
            version_rows,
            textbook_rows,
            run,
            'collector API 可用',
        )

    @classmethod
    async def metadata_snapshot(
        cls,
        db: AsyncSession,
        metadata_run_id: int | None = None,
    ) -> dict[str, Any]:
        """Return a bounded version -> textbook comparison snapshot.

        The collector rows are restricted to the exact run time window.  A
        missing explicit ID means the latest *successful* metadata run, never
        all historical source rows.
        """

        (
            available_v,
            available_t,
            message_v,
            message_t,
            version_rows,
            textbook_rows,
            run,
            source_message,
        ) = await cls._metadata_source_rows(metadata_run_id)
        if not available_v or not available_t or run is None:
            message = '；'.join(value for value in (message_v, message_t) if value)
            return {
                'sourceAvailable': False,
                'sourceMessage': message or '没有可用的元数据快照',
                'metadataRunId': None,
                'collectedAt': None,
                'versionCount': 0,
                'textbookCount': 0,
                'versions': [],
            }
        if len(version_rows) > MAX_METADATA_VERSIONS:
            raise ServiceException(message=f'版本候选数量超过安全上限 {MAX_METADATA_VERSIONS}')
        if len(textbook_rows) > MAX_METADATA_TEXTBOOKS:
            raise ServiceException(message=f'教材候选数量超过安全上限 {MAX_METADATA_TEXTBOOKS}')

        version_builder = _CANDIDATE_BUILDERS['version']
        textbook_builder = _CANDIDATE_BUILDERS['textbook']
        versions = [built for row in version_rows if (built := version_builder(row)) is not None]
        textbooks = [built for row in textbook_rows if (built := textbook_builder(row)) is not None]
        if len(versions) > MAX_METADATA_VERSIONS or len(textbooks) > MAX_METADATA_TEXTBOOKS:
            raise ServiceException(message='元数据快照中存在过多缺少稳定 ID 的候选')
        versions.sort(key=lambda item: (_sort_order(item.get('sortOrder')), str(item['externalId'])))
        textbooks.sort(key=lambda item: (_sort_order(item.get('sortOrder')), str(item['externalId'])))
        current_versions, current_textbooks = await asyncio.gather(
            cls._load_current(db, 'version', PROVIDER),
            cls._load_current(db, 'textbook', PROVIDER),
        )
        reviews_versions, reviews_textbooks = await asyncio.gather(
            cls._load_reviews(db, 'version', PROVIDER),
            cls._load_reviews(db, 'textbook', PROVIDER),
        )

        version_view: dict[tuple[str, str], dict[str, Any]] = {}
        for candidate in versions:
            key = (str(candidate['sourceProvider']), str(candidate['externalId']))
            formal = current_versions.get(key)
            staged_hash = _canonical_hash(_semantic(candidate, 'version', for_hash=True))
            review = reviews_versions.get(key)
            version_view[key] = {
                'sourceProvider': candidate['sourceProvider'],
                'externalId': candidate['externalId'],
                'versionName': candidate.get('versionName'),
                'candidate': _jsonable(candidate),
                'current': _jsonable(formal) if formal else None,
                'stagedHash': staged_hash,
                'comparisonStatus': 'new'
                if formal is None
                else ('changed' if _changed_fields(candidate, formal, 'version') else 'unchanged'),
                'reviewStatus': cls._review_status(review, staged_hash),
                'changedFields': _changed_fields(candidate, formal, 'version'),
                'collectedAt': candidate.get('lastSeenAt'),
                'textbooks': [],
                '_sortOrder': _sort_order(candidate.get('sortOrder')),
            }
        for candidate in textbooks:
            key = (str(candidate['sourceProvider']), str(candidate['externalId']))
            formal = current_textbooks.get(key)
            staged_hash = _canonical_hash(_semantic(candidate, 'textbook', for_hash=True))
            review = reviews_textbooks.get(key)
            version_key = (
                str(candidate['sourceProvider']),
                str(candidate.get('versionExternalId') or ''),
            )
            item = {
                'sourceProvider': candidate['sourceProvider'],
                'externalId': candidate['externalId'],
                'textbookName': candidate.get('textbookName'),
                'candidate': _jsonable(candidate),
                'current': _jsonable(formal) if formal else None,
                'stagedHash': staged_hash,
                'comparisonStatus': 'new'
                if formal is None
                else ('changed' if _changed_fields(candidate, formal, 'textbook') else 'unchanged'),
                'reviewStatus': cls._review_status(review, staged_hash),
                'changedFields': _changed_fields(candidate, formal, 'textbook'),
                'collectedAt': candidate.get('lastSeenAt'),
                '_sortOrder': _sort_order(candidate.get('sortOrder')),
            }
            if version_key not in version_view:
                # A malformed collector run must not make an ungrouped
                # textbook appear selectable in the transfer UI.
                continue
            version_view[version_key]['textbooks'].append(item)
        ordered_versions = sorted(
            version_view.values(),
            key=lambda item: (_sort_order(item.get('_sortOrder')), str(item['externalId'])),
        )
        for version in ordered_versions:
            version['textbooks'].sort(
                key=lambda item: (_sort_order(item.get('_sortOrder')), str(item['externalId']))
            )
            version.pop('_sortOrder', None)
            for textbook in version['textbooks']:
                textbook.pop('_sortOrder', None)
        return {
            'sourceAvailable': True,
            'sourceMessage': source_message,
            'metadataRunId': int(run['id']),
            'collectedAt': run.get('finished_at'),
            'versionCount': len(ordered_versions),
            'textbookCount': sum(len(item['textbooks']) for item in ordered_versions),
            'versions': ordered_versions,
        }

    @classmethod
    async def _load_current_textbook_overview(
        cls,
        db: AsyncSession,
    ) -> list[dict[str, Any]]:
        """Load the complete current version -> textbook tree.

        This is deliberately separate from ``_load_current``.  The compare
        workflow uses a provider/external-ID dictionary and therefore skips
        rows without an external ID.  The overview page is a display of the
        complete formal bank, so manual rows (including repeated ``NULL``
        external IDs) must remain as independent records.
        """

        def execute_mappings(result: Any) -> list[Any]:
            mappings = getattr(result, 'mappings', None)
            if mappings is not None:
                return list(mappings().all())
            scalars = getattr(result, 'scalars', None)
            return list(scalars().all()) if scalars is not None else []

        try:
            version_rows = execute_mappings(await db.execute(select(*_VERSION_CURRENT_COLUMNS)))
            textbook_rows = execute_mappings(await db.execute(select(*_TEXTBOOK_CURRENT_COLUMNS)))
        except SQLAlchemyError as exc:
            raise ServiceException(message='正式题库查询失败，请确认数据库迁移和连接状态') from exc

        versions_by_id: dict[int, dict[str, Any]] = {}
        for row in version_rows:
            local_id = _pick(row, 'version_id')
            if local_id is None:
                # A primary key cannot be NULL in the formal schema.  Keep a
                # defensive guard for lightweight test doubles and malformed
                # legacy data rather than returning an invalid API record.
                continue
            local_id = int(local_id)
            versions_by_id[local_id] = {
                'currentLocalId': local_id,
                'sourceProvider': str(_pick(row, 'source_provider') or ''),
                'externalId': _pick(row, 'external_version_id'),
                'versionName': _pick(row, 'version_name'),
                'textbookCount': 0,
                'textbooks': [],
                '_sortOrder': _sort_order(_pick(row, 'sort_order')),
            }

        # A textbook normally points to an existing version.  If old/manual
        # data contains an orphaned reference, retain it in a synthetic
        # display group so the full textbook count is still truthful.
        for row in textbook_rows:
            local_id = _pick(row, 'textbook_id')
            version_id = _pick(row, 'version_id')
            if local_id is None or version_id is None:
                continue
            local_id = int(local_id)
            version_id = int(version_id)
            version = versions_by_id.get(version_id)
            if version is None:
                version = {
                    'currentLocalId': version_id,
                    'sourceProvider': str(_pick(row, 'source_provider') or ''),
                    'externalId': None,
                    'versionName': '未关联版本',
                    'textbookCount': 0,
                    'textbooks': [],
                    '_sortOrder': 0,
                }
                versions_by_id[version_id] = version
            version['textbooks'].append(
                {
                    'currentLocalId': local_id,
                    'sourceProvider': str(_pick(row, 'source_provider') or ''),
                    'externalId': _pick(row, 'external_textbook_id'),
                    'textbookName': _pick(row, 'textbook_name'),
                    'grade': _pick(row, 'grade'),
                    'volume': _pick(row, 'volume'),
                    '_sortOrder': _sort_order(_pick(row, 'sort_order')),
                }
            )

        for version in versions_by_id.values():
            version['textbooks'].sort(
                key=lambda item: (
                    _sort_order(item.get('_sortOrder')),
                    int(item.get('currentLocalId') or 0),
                )
            )
            version['textbookCount'] = len(version['textbooks'])
            for textbook in version['textbooks']:
                textbook.pop('_sortOrder', None)

        ordered_versions = sorted(
            versions_by_id.values(),
            key=lambda item: (
                _sort_order(item.get('_sortOrder')),
                int(item.get('currentLocalId') or 0),
            ),
        )
        for version in ordered_versions:
            version.pop('_sortOrder', None)
        return ordered_versions

    @classmethod
    async def metadata_textbook_overview(  # noqa: PLR0912, PLR0915
        cls,
        db: AsyncSession,
        metadata_run_id: int | None = None,
    ) -> dict[str, Any]:
        """Return the full fetched-vs-current tree for the textbook page.

        The left side is restricted to one successful metadata run (the
        latest successful run when no ID is supplied).  The right side is
        always the complete formal version/textbook tree.  Matching is based
        exclusively on ``(sourceProvider, externalId)``; names are display
        fields and never identity fields.
        """

        current_versions = await cls._load_current_textbook_overview(db)
        current_version_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        current_textbook_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        for version in current_versions:
            provider = str(version.get('sourceProvider') or '')
            external_id = version.get('externalId')
            if external_id is not None and str(external_id).strip():
                current_version_by_key[(provider, str(external_id))] = version
            for textbook in version['textbooks']:
                textbook_provider = str(textbook.get('sourceProvider') or '')
                textbook_external_id = textbook.get('externalId')
                if textbook_external_id is not None and str(textbook_external_id).strip():
                    current_textbook_by_key[(textbook_provider, str(textbook_external_id))] = textbook

        try:
            (
                available_v,
                available_t,
                message_v,
                message_t,
                version_rows,
                textbook_rows,
                run,
                source_message,
            ) = await cls._metadata_source_rows(metadata_run_id)
        except ServiceException as exc:
            # The current side remains useful even while a remote collector
            # is unavailable, so degrade only the fetched side to an empty
            # snapshot and surface the collector error as display metadata.
            available_v = available_t = False
            message_v = exc.message or '同步来源暂不可用'
            message_t = ''
            version_rows = []
            textbook_rows = []
            run = None
            source_message = ''

        source_available = bool(available_v and available_t and run is not None)
        fetched_versions: list[dict[str, Any]] = []
        if source_available:
            if len(version_rows) > MAX_METADATA_VERSIONS:
                raise ServiceException(message=f'版本候选数量超过安全上限 {MAX_METADATA_VERSIONS}')
            if len(textbook_rows) > MAX_METADATA_TEXTBOOKS:
                raise ServiceException(message=f'教材候选数量超过安全上限 {MAX_METADATA_TEXTBOOKS}')

            version_builder = _CANDIDATE_BUILDERS['version']
            textbook_builder = _CANDIDATE_BUILDERS['textbook']
            version_candidates = [built for row in version_rows if (built := version_builder(row)) is not None]
            textbook_candidates = [built for row in textbook_rows if (built := textbook_builder(row)) is not None]
            if len(version_candidates) > MAX_METADATA_VERSIONS or len(textbook_candidates) > MAX_METADATA_TEXTBOOKS:
                raise ServiceException(message='元数据快照中存在过多缺少稳定 ID 的候选')

            # Source metadata is expected to be unique by provider + external
            # ID.  De-duplicate defensively so a malformed run cannot inflate
            # the counts or render duplicate groups in the new page.
            version_view: dict[tuple[str, str], dict[str, Any]] = {}
            for candidate in version_candidates:
                key = (str(candidate['sourceProvider']), str(candidate['externalId']))
                if key in version_view:
                    continue
                current = current_version_by_key.get(key)
                item: dict[str, Any] = {
                    'sourceProvider': candidate['sourceProvider'],
                    'externalId': candidate['externalId'],
                    'versionName': candidate.get('versionName'),
                    'matchStatus': 'existing' if current else 'new',
                    'textbookCount': 0,
                    'textbooks': [],
                    '_sortOrder': _sort_order(candidate.get('sortOrder')),
                }
                if current is not None:
                    item['currentLocalId'] = current['currentLocalId']
                version_view[key] = item

            seen_textbooks: set[tuple[tuple[str, str], tuple[str, str]]] = set()
            for candidate in textbook_candidates:
                version_key = (
                    str(candidate['sourceProvider']),
                    str(candidate.get('versionExternalId') or ''),
                )
                if version_key not in version_view:
                    # The existing metadata snapshot intentionally hides
                    # malformed orphan textbooks instead of presenting an
                    # item that cannot be associated with a version.
                    continue
                textbook_key = (str(candidate['sourceProvider']), str(candidate['externalId']))
                dedupe_key = (version_key, textbook_key)
                if dedupe_key in seen_textbooks:
                    continue
                seen_textbooks.add(dedupe_key)
                current = current_textbook_by_key.get(textbook_key)
                textbook: dict[str, Any] = {
                    'sourceProvider': candidate['sourceProvider'],
                    'externalId': candidate['externalId'],
                    'textbookName': candidate.get('textbookName'),
                    'grade': candidate.get('grade'),
                    'volume': candidate.get('volume'),
                    'matchStatus': 'existing' if current else 'new',
                    '_sortOrder': _sort_order(candidate.get('sortOrder')),
                }
                if current is not None:
                    textbook['currentLocalId'] = current['currentLocalId']
                version_view[version_key]['textbooks'].append(textbook)

            for version in version_view.values():
                version['textbooks'].sort(
                    key=lambda item: (
                        _sort_order(item.get('_sortOrder')),
                        str(item.get('externalId') or ''),
                    )
                )
                version['textbookCount'] = len(version['textbooks'])
            fetched_versions = sorted(
                version_view.values(),
                key=lambda item: (
                    _sort_order(item.get('_sortOrder')),
                    str(item.get('externalId') or ''),
                ),
            )
            for version in fetched_versions:
                version.pop('_sortOrder', None)
                for textbook in version['textbooks']:
                    textbook.pop('_sortOrder', None)

        fetched_textbooks = [textbook for version in fetched_versions for textbook in version['textbooks']]
        message = source_message
        if not source_available:
            message = '；'.join(dict.fromkeys(value for value in (message_v, message_t) if value))
            message = message or '没有可用的元数据快照'
        return {
            'sourceAvailable': source_available,
            'sourceMessage': message,
            'metadataRunId': int(run['id']) if source_available and run else None,
            'collectedAt': _jsonable(run.get('finished_at')) if source_available and run else None,
            'summary': {
                'fetchedVersionCount': len(fetched_versions),
                'fetchedTextbookCount': len(fetched_textbooks),
                'newVersionCount': sum(1 for item in fetched_versions if item['matchStatus'] == 'new'),
                'existingVersionCount': sum(1 for item in fetched_versions if item['matchStatus'] == 'existing'),
                'newTextbookCount': sum(1 for item in fetched_textbooks if item['matchStatus'] == 'new'),
                'existingTextbookCount': sum(1 for item in fetched_textbooks if item['matchStatus'] == 'existing'),
                'currentVersionCount': len(current_versions),
                'currentTextbookCount': sum(item['textbookCount'] for item in current_versions),
            },
            'fetchedVersions': fetched_versions,
            'currentVersions': current_versions,
        }

    @classmethod
    async def _load_current(
        cls,
        db: AsyncSession,
        entity_type: str,
        source_provider: str | None = None,
    ) -> dict[tuple[str, str], dict[str, Any]]:
        """Load projected formal rows and map them by provider + external ID.

        ``select(Model)`` is intentionally avoided here: questions contain
        LONGTEXT/JSON columns which are not needed by the comparison page.
        SQL-level provider predicates also keep a tenant/provider's data out
        of the in-memory comparison set.
        """

        def execute_mappings(result: Any) -> list[Any]:
            mappings = getattr(result, 'mappings', None)
            if mappings is not None:
                return list(mappings().all())
            # This fallback keeps lightweight unit-test doubles compatible;
            # production SQLAlchemy results always expose mappings().
            scalars = getattr(result, 'scalars', None)
            return list(scalars().all()) if scalars is not None else []

        try:
            if entity_type == 'version':
                statement = select(*_VERSION_CURRENT_COLUMNS)
                if source_provider:
                    statement = statement.where(QbTextbookVersion.source_provider == source_provider)
                rows = execute_mappings(await db.execute(statement))
                values = [_formal_version(row) for row in rows]
            elif entity_type == 'textbook':
                statement = select(*_TEXTBOOK_CURRENT_COLUMNS)
                version_statement = select(
                    QbTextbookVersion.version_id,
                    QbTextbookVersion.external_version_id,
                    QbTextbookVersion.source_provider,
                )
                if source_provider:
                    statement = statement.where(QbTextbook.source_provider == source_provider)
                    version_statement = version_statement.where(QbTextbookVersion.source_provider == source_provider)
                rows = execute_mappings(await db.execute(statement))
                versions = execute_mappings(await db.execute(version_statement))
                version_map = {
                    int(_pick(row, 'version_id')): _pick(row, 'external_version_id')
                    for row in versions
                    if _pick(row, 'version_id') is not None
                }
                values = [
                    _formal_textbook(
                        row,
                        version_map.get(int(_pick(row, 'version_id')))
                        if _pick(row, 'version_id') is not None
                        else None,
                    )
                    for row in rows
                ]
            elif entity_type == 'catalog':
                statement = select(*_CATALOG_CURRENT_COLUMNS)
                textbook_statement = select(
                    QbTextbook.textbook_id,
                    QbTextbook.external_textbook_id,
                    QbTextbook.source_provider,
                )
                if source_provider:
                    statement = statement.where(QbCatalogNode.source_provider == source_provider)
                    textbook_statement = textbook_statement.where(QbTextbook.source_provider == source_provider)
                rows = execute_mappings(await db.execute(statement))
                textbooks = execute_mappings(await db.execute(textbook_statement))
                textbook_map = {
                    int(_pick(row, 'textbook_id')): _pick(row, 'external_textbook_id')
                    for row in textbooks
                    if _pick(row, 'textbook_id') is not None
                }
                catalog_map = {
                    int(_pick(row, 'catalog_id')): _pick(row, 'external_node_id')
                    for row in rows
                    if _pick(row, 'catalog_id') is not None
                }
                values = [
                    _formal_catalog(
                        row,
                        textbook_map.get(int(_pick(row, 'textbook_id')))
                        if _pick(row, 'textbook_id') is not None
                        else None,
                        catalog_map.get(int(_pick(row, 'parent_id'))) if _pick(row, 'parent_id') is not None else None,
                    )
                    for row in rows
                ]
            else:
                statement = select(*_QUESTION_CURRENT_COLUMNS)
                if source_provider:
                    statement = statement.where(QbQuestion.source_provider == source_provider)
                rows = execute_mappings(await db.execute(statement))
                values = [_formal_question(row) for row in rows]
        except SQLAlchemyError as exc:
            raise ServiceException(message='正式题库查询失败，请确认数据库迁移和连接状态') from exc

        result: dict[tuple[str, str], dict[str, Any]] = {}
        for value in values:
            provider = str(value.get('sourceProvider') or '')
            external_id = value.get('externalId')
            if source_provider and provider != source_provider:
                continue
            if external_id is not None and str(external_id).strip():
                result[(provider, str(external_id))] = _jsonable(value)
        return result

    @classmethod
    async def _load_reviews(
        cls,
        db: AsyncSession,
        entity_type: str,
        source_provider: str | None = None,
    ) -> dict[tuple[str, str], Any]:
        try:
            rows = await SyncReviewDao.list_for_entity(db, entity_type, source_provider)
        except SQLAlchemyError as exc:
            raise ServiceException(message='同步审核表查询失败，请确认同步审核迁移已执行') from exc
        return {(row.source_provider, row.external_id): row for row in rows}

    @staticmethod
    def _review_status(review: Any | None, staged_hash: str) -> str:
        if review is None:
            return 'pending'
        if str(review.staged_hash) != staged_hash:
            return 'stale'
        return str(review.review_status or 'pending')

    @classmethod
    async def compare(  # noqa: PLR0912, PLR0915
        cls,
        db: AsyncSession,
        entity_type: SyncEntityType | str,
        query: SyncCompareQueryModel | None = None,
    ) -> dict[str, Any]:
        if entity_type not in _TABLES:
            raise ServiceException(message='不支持的同步实体类型')
        query = query or SyncCompareQueryModel()
        if entity_type in {'catalog', 'question'} and not query.textbook_external_id:
            raise ServiceException(message='目录或题目查询必须携带教材范围')
        candidate_args: dict[str, Any] = {}
        if entity_type in {'version', 'textbook'} and query.metadata_run_id is not None:
            candidate_args['metadata_run_id'] = query.metadata_run_id
        if entity_type in {'catalog', 'question'} and query.textbook_external_id:
            candidate_args['textbook_external_id'] = query.textbook_external_id
        try:
            available, source_message, candidates = await cls._read_candidates(
                entity_type,
                query.source_provider,
                **candidate_args,
            )
        except TypeError as exc:
            # Keep small test/integration doubles written against the previous
            # two-argument private helper usable when no new scope is needed.
            if candidate_args:
                raise
            if 'unexpected keyword argument' not in str(exc):
                raise
            available, source_message, candidates = await cls._read_candidates(
                entity_type,
                query.source_provider,
            )
        empty_page = {
            'pageNum': query.page_num,
            'pageSize': query.page_size,
            'total': 0,
            'hasNext': False,
        }
        empty_summary = {
            'total': 0,
            'newCount': 0,
            'changedCount': 0,
            'unchangedCount': 0,
            'conflictCount': 0,
            'pendingCount': 0,
            'approvedCount': 0,
            'rejectedCount': 0,
            'staleCount': 0,
        }
        if not available:
            return {
                'summary': empty_summary,
                'rows': [],
                'page': empty_page,
                'sourceAvailable': False,
                'sourceMessage': source_message,
            }

        current = await cls._load_current(db, entity_type, query.source_provider)
        reviews = await cls._load_reviews(db, entity_type, query.source_provider)
        duplicate_keys = {
            key
            for key, count in Counter(
                (str(item.get('sourceProvider') or ''), str(item.get('externalId') or '')) for item in candidates
            ).items()
            if count > 1
        }
        rows: list[dict[str, Any]] = []
        for candidate in candidates:
            provider = str(candidate.get('sourceProvider') or '')
            external_id = str(candidate.get('externalId') or '')
            # Hierarchy filters are applied at the collector read boundary for
            # questions.  Keep these checks as a second defensive filter for
            # catalog/textbook rows and for lightweight legacy collectors.
            if (
                entity_type == 'textbook'
                and query.version_external_id
                and str(candidate.get('versionExternalId') or '') != query.version_external_id
            ):
                continue
            if (
                entity_type == 'catalog'
                and query.textbook_external_id
                and str(candidate.get('textbookExternalId') or '') != query.textbook_external_id
            ):
                continue
            if (
                entity_type == 'question'
                and query.textbook_external_id
                and not candidate.get('_textbookScopeMatched', True)
            ):
                continue
            if query.keyword:
                searchable = ' '.join(str(value or '') for value in candidate.values()).lower()
                if query.keyword.lower() not in searchable:
                    continue
            staged_hash = _canonical_hash(_semantic(candidate, entity_type, for_hash=True))
            formal = current.get((provider, external_id))
            conflict = False
            if (provider, external_id) in duplicate_keys:
                conflict = True
            if formal is not None and entity_type == 'textbook':
                conflict = conflict or (candidate.get('versionExternalId') != formal.get('versionExternalId'))
            elif formal is not None and entity_type == 'catalog':
                conflict = conflict or any(
                    candidate.get(field) != formal.get(field) for field in ('textbookExternalId', 'parentExternalId')
                )
            comparison_status = (
                'conflict'
                if conflict
                else (
                    'new'
                    if formal is None
                    else ('unchanged' if not _changed_fields(candidate, formal, entity_type) else 'changed')
                )
            )
            review = reviews.get((provider, external_id))
            review_status = cls._review_status(review, staged_hash)
            rows.append(
                {
                    'externalId': external_id,
                    'sourceProvider': provider,
                    'stagedHash': staged_hash,
                    'comparisonStatus': comparison_status,
                    'reviewStatus': review_status,
                    'currentLocalId': formal.get('currentLocalId') if formal else None,
                    'candidate': _jsonable(candidate),
                    'current': _jsonable(formal) if formal else None,
                    'changedFields': _changed_fields(candidate, formal, entity_type),
                    # Keep the old comment visible when a candidate becomes stale;
                    # stale status makes it explicit that the decision cannot be
                    # used until the operator reviews the new hash.
                    'reviewComment': review.review_comment if review else None,
                    'collectedAt': candidate.get('lastSeenAt'),
                    'reviewedBy': review.reviewed_by if review else None,
                    'reviewedAt': review.reviewed_at if review else None,
                }
            )

        comparison_counts = Counter(row['comparisonStatus'] for row in rows)
        review_counts = Counter(row['reviewStatus'] for row in rows)
        summary = {
            'total': len(rows),
            'newCount': comparison_counts.get('new', 0),
            'changedCount': comparison_counts.get('changed', 0),
            'unchangedCount': comparison_counts.get('unchanged', 0),
            'conflictCount': comparison_counts.get('conflict', 0),
            'pendingCount': review_counts.get('pending', 0),
            'approvedCount': review_counts.get('approved', 0),
            'rejectedCount': review_counts.get('rejected', 0),
            'staleCount': review_counts.get('stale', 0),
        }
        if query.comparison_status:
            rows = [row for row in rows if row['comparisonStatus'] == query.comparison_status]
        review_filter = query.review_status or query.status
        if review_filter:
            rows = [row for row in rows if row['reviewStatus'] == review_filter]
        total = len(rows)
        start = (query.page_num - 1) * query.page_size
        end = start + query.page_size
        return {
            'summary': summary,
            'rows': rows[start:end],
            'page': {
                'pageNum': query.page_num,
                'pageSize': query.page_size,
                'total': total,
                'hasNext': end < total,
            },
            'sourceAvailable': True,
            'sourceMessage': source_message,
        }

    @classmethod
    async def _candidate_for_review(
        cls,
        entity_type: str,
        external_id: str,
        source_provider: str | None,
    ) -> dict[str, Any]:
        available, message, candidates = await cls._read_candidates(entity_type, source_provider)
        if not available:
            raise ServiceException(message=message)
        matches = [candidate for candidate in candidates if str(candidate.get('externalId')) == external_id]
        if not matches:
            raise ServiceException(message='候选不存在或已被采集结果移除，请刷新列表')
        if len(matches) > 1:
            raise ServiceException(message='来源实体 ID 不唯一，请指定 sourceProvider')
        return matches[0]

    @staticmethod
    def _normalise_action(item: SyncReviewItemModel | SyncReviewRequestModel) -> str:
        action = getattr(item, 'action', None)
        status = getattr(item, 'review_status', None) or getattr(item, 'status', None)
        value = action or status
        if value in {'approve', 'approved'}:
            return 'approved'
        if value in {'reject', 'rejected'}:
            return 'rejected'
        raise ServiceException(message='审核 action 必须是 approve 或 reject')

    @classmethod
    async def review(  # noqa: PLR0912, PLR0915
        cls,
        db: AsyncSession,
        entity_type: SyncEntityType | str,
        payload: SyncReviewRequestModel,
        reviewer: str | None = None,
    ) -> dict[str, Any]:
        if entity_type not in _TABLES:
            raise ServiceException(message='不支持的同步实体类型')
        textbook_external_id = str(payload.textbook_external_id or '').strip() or None
        if textbook_external_id and entity_type not in {'catalog', 'question'}:
            raise ServiceException(message='教材范围只能用于目录或题目审核')
        if entity_type in {'catalog', 'question'} and not textbook_external_id:
            raise ServiceException(message='目录或题目审核必须携带教材范围')
        items = list(payload.items)
        if items:
            if payload.external_id is not None or payload.staged_hash is not None:
                raise ServiceException(message='批量审核不能携带单条 externalId 或 stagedHash')
            # A batch may put one common action/comment on the envelope, or
            # put action/comment on every item.  Envelope values are defaults
            # and never override an explicit item value.
            if (
                payload.action
                or payload.review_status
                or payload.status
                or payload.review_comment is not None
                or payload.source_provider
            ):
                items = [
                    SyncReviewItemModel(
                        externalId=item.external_id,
                        sourceProvider=item.source_provider or payload.source_provider,
                        stagedHash=item.staged_hash,
                        action=(
                            item.action
                            or item.review_status
                            or item.status
                            or payload.action
                            or payload.review_status
                            or payload.status
                        ),
                        reviewComment=item.review_comment
                        if item.review_comment is not None
                        else payload.review_comment,
                    )
                    for item in items
                ]
        elif (
            payload.external_id is not None
            or payload.staged_hash is not None
            or payload.action
            or payload.review_status
            or payload.status
        ):
            if not payload.external_id or not payload.staged_hash:
                raise ServiceException(message='单条审核必须携带 externalId 和 stagedHash')
            items = [
                SyncReviewItemModel(
                    externalId=payload.external_id,
                    sourceProvider=payload.source_provider,
                    stagedHash=payload.staged_hash,
                    action=payload.action,
                    reviewStatus=payload.review_status,
                    status=payload.status,
                    reviewComment=payload.review_comment,
                )
            ]
        if not items:
            raise ServiceException(message='审核请求不能为空')
        seen_request_keys: set[tuple[str, str]] = set()
        for item in items:
            provider = str(item.source_provider or payload.source_provider or '').strip()
            key = (provider, item.external_id)
            if key in seen_request_keys:
                raise ServiceException(message='审核请求不能包含重复的 sourceProvider + externalId')
            seen_request_keys.add(key)
        now = datetime.now()
        reviewer_name = (reviewer or '').strip() or 'system'
        item_providers = [str(item.source_provider or payload.source_provider or '').strip() for item in items]
        requested_providers = {provider for provider in item_providers if provider}
        # A provider predicate is safe only when every item carries one.  A
        # mixed batch with an unspecified provider must still be able to find
        # that item's identity in another provider's candidate set.
        source_provider = (
            next(iter(requested_providers)) if len(requested_providers) == 1 and all(item_providers) else None
        )
        if textbook_external_id:
            available, source_message, candidates = await cls._read_candidates(
                entity_type,
                source_provider,
                textbook_external_id=textbook_external_id,
            )
        else:
            available, source_message, candidates = await cls._read_candidates(entity_type, source_provider)
        if not available:
            raise ServiceException(message=source_message)
        candidate_index: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for candidate in candidates:
            key = (str(candidate.get('sourceProvider') or ''), str(candidate.get('externalId') or ''))
            candidate_index.setdefault(key, []).append(candidate)
        current = await cls._load_current(db, entity_type, source_provider)
        prepared: list[
            tuple[
                SyncReviewItemModel,
                dict[str, Any],
                str,
                dict[str, Any] | None,
                dict[str, Any] | None,
                str,
            ]
        ] = []
        # Prepare and validate every item first.  A stale item therefore cannot
        # leave a partial batch behind.
        for item in items:
            action = cls._normalise_action(item)
            provider = str(item.source_provider or payload.source_provider or '').strip() or None
            if provider:
                matches = candidate_index.get((provider, item.external_id), [])
            else:
                matches = [
                    value
                    for (candidate_provider, candidate_id), values in candidate_index.items()
                    if candidate_id == item.external_id
                    for value in values
                ]
                if len(matches) > 1:
                    raise ServiceException(message='来源实体 ID 不唯一，请指定 sourceProvider')
            if len(matches) > 1:
                raise ServiceException(message='来源实体 ID 不唯一，请指定 sourceProvider')
            candidate = matches[0] if matches else None
            if candidate is None:
                raise ServiceException(message=f'候选 {item.external_id} 不存在或已被采集结果移除，请刷新列表')
            staged_hash = _canonical_hash(_semantic(candidate, entity_type, for_hash=True))
            if staged_hash != item.staged_hash.lower():
                raise ServiceException(message=f'候选 {item.external_id} 已变化，请刷新后重新审核')
            formal = current.get((str(candidate.get('sourceProvider') or ''), item.external_id))
            conflict = False
            if formal is not None and entity_type == 'textbook':
                conflict = candidate.get('versionExternalId') != formal.get('versionExternalId')
            if formal is not None and entity_type == 'catalog':
                conflict = any(
                    candidate.get(field) != formal.get(field) for field in ('textbookExternalId', 'parentExternalId')
                )
            comparison_status = (
                'conflict'
                if conflict
                else (
                    'new'
                    if formal is None
                    else ('unchanged' if not _changed_fields(candidate, formal, entity_type) else 'changed')
                )
            )
            if comparison_status == 'conflict':
                raise ServiceException(message=f'候选 {item.external_id} 存在冲突，解决来源 ID 或层级冲突后才能审核')
            try:
                previous = await SyncReviewDao.get(
                    db,
                    entity_type,
                    str(candidate.get('sourceProvider') or ''),
                    item.external_id,
                )
            except SQLAlchemyError as exc:
                raise ServiceException(message='同步审核表查询失败，请确认同步审核迁移已执行') from exc
            prepared.append((item, candidate, action, formal, previous, comparison_status))

        results: list[dict[str, Any]] = []
        try:
            for item, candidate, action, formal, previous, comparison_status in prepared:
                provider = str(candidate.get('sourceProvider') or '')
                staged_hash = _canonical_hash(_semantic(candidate, entity_type, for_hash=True))
                row = await SyncReviewDao.upsert(
                    db,
                    entity_type=entity_type,
                    source_provider=provider,
                    external_id=item.external_id,
                    staged_hash=staged_hash,
                    staged_data=_jsonable(candidate),
                    current_local_id=int(formal['currentLocalId'])
                    if formal and formal.get('currentLocalId') is not None
                    else None,
                    comparison_status=comparison_status,
                    review_status=action,
                    review_comment=(
                        item.review_comment
                        if item.review_comment is not None
                        else (previous.review_comment if previous is not None else None)
                    ),
                    reviewed_by=reviewer_name,
                    reviewed_at=now,
                    create_time=now,
                    update_time=now,
                )
                results.append(
                    {
                        'externalId': item.external_id,
                        'sourceProvider': provider,
                        'reviewStatus': row.review_status,
                        'comparisonStatus': row.comparison_status,
                        'stagedHash': row.staged_hash,
                        'reviewedBy': row.reviewed_by,
                        'reviewedAt': row.reviewed_at,
                    }
                )
            await db.commit()
        except SQLAlchemyError as exc:
            await db.rollback()
            raise ServiceException(message='同步审核写入失败，请确认同步审核迁移和数据库连接状态') from exc
        except Exception:
            await db.rollback()
            raise
        return {'updated': len(results), 'items': results}

    # Compatibility aliases for callers that use an imperative naming style.
    compare_candidates = compare
    review_candidates = review


# Name used by callers that prefer the longer, explicit service name.
SyncComparisonService = SyncService
BankSyncService = SyncService
