"""Independent textbook/question synchronization task services.

The collector owns immutable snapshots behind its HTTP API.  This module only
records task state/scope in MySQL and computes comparison projections.
Publishing those projections is a separate, explicit batch workflow.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections import Counter
from collections.abc import Mapping
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from common.vo import PageModel
from exceptions.exception import ServiceException
from plugins.bank.dao.bank_dao import BankDao
from plugins.bank.dao.sync_task_dao import SyncTaskDao
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionCatalog,
    QbSyncJob,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.entity.vo.bank_vo import (
    QuestionTaskCreateModel,
    SyncTaskCreateModel,
    SyncTaskPageQueryModel,
    TaskComparisonQueryModel,
)
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.question_apply_service import _normalise_answer_status

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


PROVIDER = 'zujuan'
MAX_SCOPE_ITEMS = 200
MAX_SNAPSHOT_ROWS = 100_000
MAX_LOG_LINES = 100
_TERMINAL_TASK_STATUSES = {'completed', 'failed', 'blocked', 'cancelled', 'interrupted'}
# The collector API accepts source identifiers up to 64 characters,
# including numeric-only IDs. Keep the same bound here before forwarding
# identifiers to the collector or exposing them in comparison responses.
SAFE_EXTERNAL_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z')
_COLLECTOR_COUNT_ALIASES: dict[str, tuple[str, ...]] = {
    'catalog': ('catalogItemCount', 'catalogs', 'catalogCount', 'catalog_count'),
    'question': ('questionItemCount', 'questions', 'questionCount', 'question_count'),
}
_COLLECTOR_RUN_ID_ALIASES = ('id', 'runId', 'collectorRunId', 'run_id')


def _pick(value: Mapping[str, Any] | object, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(value, Mapping):
            if name in value:
                return value[name]
        elif hasattr(value, name):
            return getattr(value, name)
    return default


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(item) for item in value]
    return str(value)


def _canonical_hash(value: Any) -> str:
    payload = json.dumps(_jsonable(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _safe_external_id(value: object) -> bool:
    return bool(SAFE_EXTERNAL_ID.fullmatch(str(value or '').strip()))


def _as_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or '').strip().lower() in {'1', 'true', 'yes', 'y', 'on', 'complete', 'completed', 'success'}


def _positive_resume_run_id(value: Any) -> int | None:
    """Return a strictly positive persisted collector run ID, if valid."""

    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not re.fullmatch(r'\d+', text):
        return None
    try:
        parsed = int(text)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _scalars(result: Any) -> list[Any]:
    method = getattr(result, 'scalars', None)
    if callable(method):
        return list(method().all())
    method = getattr(result, 'all', None)
    if callable(method):
        return list(method())
    return []


def _mappings(result: Any) -> list[Any]:
    method = getattr(result, 'mappings', None)
    if callable(method):
        return list(method().all())
    return _scalars(result)


async def _commit_or_rollback(db: AsyncSession, operation: Any) -> Any:
    """Commit a task mutation, rolling back the same transaction on error."""

    try:
        result = await operation
        await db.commit()
        return result
    except Exception:
        await db.rollback()
        raise


def _task_options(row: object) -> dict[str, Any]:
    value = _pick(row, 'options_json', 'optionsJson', default={})
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return {}
        return dict(parsed) if isinstance(parsed, Mapping) else {}
    return {}


def _scope_payload(scope: object) -> dict[str, Any]:
    local_version_id = _pick(scope, 'local_version_id', 'localVersionId', 'version_id', 'versionId')
    local_textbook_id = _pick(scope, 'local_textbook_id', 'localTextbookId', 'textbook_id', 'textbookId')
    version_name = _pick(scope, 'version_name_snapshot', 'versionNameSnapshot', 'version_name', 'versionName')
    textbook_name = _pick(scope, 'textbook_name_snapshot', 'textbookNameSnapshot', 'textbook_name', 'textbookName')
    scope_status = str(_pick(scope, 'status', 'state', default='queued') or 'queued').lower()
    collector_run_id = _pick(scope, 'collector_run_id', 'collectorRunId')
    resume_from = _pick(scope, 'resume_from_collector_run_id', 'resumeFromCollectorRunId')
    if resume_from in (None, '') and scope_status == 'interrupted':
        resume_from = collector_run_id
    resume_source = _positive_resume_run_id(resume_from)
    return {
        'scopeId': _pick(scope, 'scope_id', 'scopeId'),
        'runId': _pick(scope, 'run_id', 'runId'),
        'localVersionId': local_version_id,
        'localTextbookId': local_textbook_id,
        # Both names are useful to existing clients.  ``versionId`` and
        # ``textbookId`` are the stable UI aliases.
        'versionId': local_version_id,
        'textbookId': local_textbook_id,
        'versionNameSnapshot': version_name,
        'textbookNameSnapshot': textbook_name,
        'versionName': version_name,
        'textbookName': textbook_name,
        'sourceProvider': _pick(scope, 'source_provider', 'sourceProvider', 'provider'),
        'externalVersionId': _pick(scope, 'external_version_id', 'externalVersionId'),
        'externalTextbookId': _pick(
            scope,
            'external_textbook_id',
            'externalTextbookId',
            'textbook_external_id',
            'textbookExternalId',
        ),
        'metadataRunId': _pick(scope, 'metadata_run_id', 'metadataRunId'),
        'collectorJobId': _pick(scope, 'collector_job_id', 'collectorJobId'),
        'collectorRunId': collector_run_id,
        'resumeFromCollectorRunId': resume_source,
        'resumeAvailable': scope_status in {'interrupted', 'blocked'} and resume_source is not None,
        'status': scope_status,
        'catalogCount': int(_pick(scope, 'catalog_count', 'catalogCount', default=0) or 0),
        'questionCount': int(_pick(scope, 'question_count', 'questionCount', default=0) or 0),
        'questionCatalogCount': int(
            _pick(scope, 'question_catalog_count', 'questionCatalogCount', 'relation_count', 'relationCount', default=0)
            or 0
        ),
        'questionTagCount': int(
            _pick(scope, 'question_tag_count', 'questionTagCount', 'tag_count', 'tagCount', default=0) or 0
        ),
        'questionAssetCount': int(
            _pick(scope, 'question_asset_count', 'questionAssetCount', 'asset_count', 'assetCount', default=0) or 0
        ),
        'snapshotComplete': _as_flag(_pick(scope, 'snapshot_complete', 'snapshotComplete', 'complete', default=False)),
        'snapshotLockedAt': _pick(scope, 'snapshot_locked_at', 'snapshotLockedAt', 'lockedAt'),
        'newCatalogCount': int(_pick(scope, 'new_catalog_count', 'newCatalogCount', default=0) or 0),
        'changedCatalogCount': int(_pick(scope, 'changed_catalog_count', 'changedCatalogCount', default=0) or 0),
        'newQuestionCount': int(_pick(scope, 'new_question_count', 'newQuestionCount', default=0) or 0),
        'changedQuestionCount': int(_pick(scope, 'changed_question_count', 'changedQuestionCount', default=0) or 0),
        'errorMessage': _pick(scope, 'error_message', 'errorMessage'),
        'startedAt': _pick(scope, 'started_at', 'startedAt'),
        'finishedAt': _pick(scope, 'finished_at', 'finishedAt'),
    }


def task_payload(row: object, scopes: list[object] | None = None) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
    """Project one ORM row to the stable camelCase task contract."""

    options = _task_options(row)
    scope_payloads = [_scope_payload(scope) for scope in (scopes or [])]
    module = str(_pick(row, 'task_module', 'taskModule', default='center') or 'center')
    run_type = str(_pick(row, 'run_type', 'runType', default='metadata') or 'metadata')
    run_id = int(_pick(row, 'run_id', 'runId', 'task_id', 'taskId', default=0) or 0)
    metadata_run_id = _pick(row, 'metadata_run_id', 'metadataRunId', default=options.get('metadataRunId'))
    version_id = options.get('versionId') or options.get('version_id')
    version_name = options.get('versionName') or options.get('version_name')
    if version_id is not None:
        try:
            version_id = int(version_id)
        except (TypeError, ValueError):
            version_id = None
    if not version_name:
        version_name = next((item.get('versionName') for item in scope_payloads if item.get('versionName')), None)
    textbook_names = [str(item.get('textbookName') or '') for item in scope_payloads]
    if not textbook_names:
        raw_names = options.get('textbookNames') or options.get('textbook_names') or []
        textbook_names = [str(item) for item in raw_names] if isinstance(raw_names, list) else []
    progress_percent = _pick(row, 'progress_percent', 'progressPercent', 'progress', default=0) or 0
    try:
        progress_value = float(progress_percent)
    except (TypeError, ValueError):
        progress_value = 0.0
    log_tail = _pick(row, 'log_tail', 'logTail', 'logs', default=None)
    if isinstance(log_tail, list):
        logs = [str(item) for item in log_tail][-MAX_LOG_LINES:]
        log_tail = '\n'.join(logs)
    else:
        logs = str(log_tail or '').splitlines()[-MAX_LOG_LINES:]
        log_tail = '\n'.join(logs) or None
    total_versions = int(_pick(row, 'total_versions', 'totalVersions', default=0) or 0)
    total_textbooks = int(
        _pick(row, 'total_textbooks', 'totalTextbooks', default=len(scope_payloads)) or len(scope_payloads)
    )
    completed_textbooks = int(_pick(row, 'completed_textbooks', 'completedTextbooks', default=0) or 0)
    catalog_count = int(_pick(row, 'catalog_count', 'catalogCount', default=0) or 0)
    question_count = int(_pick(row, 'question_count', 'questionCount', default=0) or 0)
    question_catalog_count = int(
        _pick(row, 'question_catalog_count', 'questionCatalogCount', 'relation_count', 'relationCount', default=0)
        or 0
    )
    question_tag_count = int(
        _pick(row, 'question_tag_count', 'questionTagCount', 'tag_count', 'tagCount', default=0) or 0
    )
    question_asset_count = int(
        _pick(row, 'question_asset_count', 'questionAssetCount', 'asset_count', 'assetCount', default=0) or 0
    )
    if module == 'question' and scope_payloads:
        # Scope rows are authoritative for a multi-textbook question task;
        # derive an aggregate for old task rows created before the additive
        # task-level projection columns existed.
        catalog_count = max(
            catalog_count,
            sum(int(item.get('catalogCount') or 0) for item in scope_payloads),
        )
        question_count = max(
            question_count,
            sum(int(item.get('questionCount') or 0) for item in scope_payloads),
        )
        question_catalog_count = max(
            question_catalog_count,
            sum(int(item.get('questionCatalogCount') or 0) for item in scope_payloads),
        )
        question_tag_count = max(
            question_tag_count,
            sum(int(item.get('questionTagCount') or 0) for item in scope_payloads),
        )
        question_asset_count = max(
            question_asset_count,
            sum(int(item.get('questionAssetCount') or 0) for item in scope_payloads),
        )
    snapshot_complete = _as_flag(_pick(row, 'snapshot_complete', 'snapshotComplete', 'complete', default=False))
    if module == 'question' and scope_payloads:
        snapshot_complete = snapshot_complete or all(item.get('snapshotComplete') for item in scope_payloads)
    snapshot_locked_at = _pick(row, 'snapshot_locked_at', 'snapshotLockedAt', 'lockedAt')
    if snapshot_locked_at is None and scope_payloads:
        locks = [item.get('snapshotLockedAt') for item in scope_payloads if item.get('snapshotLockedAt')]
        if len(locks) == 1:
            snapshot_locked_at = locks[0]
    status = _pick(row, 'status', default='queued') or 'queued'
    resume_ids = [
        item.get('resumeFromCollectorRunId')
        for item in scope_payloads
        if item.get('status') != 'completed'
        and item.get('resumeAvailable') is True
        and item.get('resumeFromCollectorRunId') not in (None, '')
    ]
    resume_from = _pick(row, 'resume_from_collector_run_id', 'resumeFromCollectorRunId')
    normalized_row_resume = _positive_resume_run_id(resume_from)
    if normalized_row_resume is None and len(resume_ids) == 1:
        normalized_row_resume = int(resume_ids[0])
    task_status = str(status or '').strip().lower()
    auto_resume_enabled_value = options.get('autoResume', options.get('auto_resume', True))
    auto_resume_enabled = (
        auto_resume_enabled_value
        if isinstance(auto_resume_enabled_value, bool)
        else str(auto_resume_enabled_value).strip().lower() not in {'0', 'false', 'no', 'off', 'disabled'}
    )
    try:
        auto_resume_attempt = max(
            0,
            int(options.get('autoResumeAttempt', options.get('auto_resume_attempt', 0)) or 0),
        )
    except (TypeError, ValueError):
        auto_resume_attempt = 0
    try:
        auto_resume_max_attempts = max(
            0,
            int(options.get('autoResumeMaxAttempts', options.get('auto_resume_max_attempts', 3)) or 0),
        )
    except (TypeError, ValueError):
        auto_resume_max_attempts = 3
    return {
        'taskId': run_id,
        'taskNo': str(run_id),
        'runId': run_id,
        'taskModule': module,
        'runType': run_type,
        'status': status,
        'phase': _pick(row, 'phase', default='metadata' if run_type == 'metadata' else 'catalogs_questions'),
        'progress': max(0.0, min(100.0, progress_value)),
        'progressPercent': max(0.0, min(100.0, progress_value)),
        'acknowledgeSourcePolicy': str(_pick(row, 'acknowledge_source_policy', 'acknowledgeSourcePolicy', default='Y'))
        == 'Y',
        'metadataRunId': metadata_run_id,
        'sourceTaskId': _pick(row, 'source_task_id', 'sourceTaskId'),
        'retryOfRunId': _pick(row, 'retry_of_run_id', 'retryOfRunId'),
        'retryOfTaskId': _pick(row, 'retry_of_run_id', 'retryOfTaskId'),
        'collectorJobId': _pick(row, 'collector_job_id', 'collectorJobId'),
        'versionId': version_id,
        'versionName': version_name,
        'textbookCount': len(scope_payloads) or total_textbooks,
        'textbookNames': textbook_names,
        'scopeItems': scope_payloads,
        'fetchedVersionCount': total_versions,
        'fetchedTextbookCount': total_textbooks,
        'newVersionCount': int(_pick(row, 'new_version_count', 'newVersionCount', default=0) or 0),
        'newTextbookCount': int(_pick(row, 'new_textbook_count', 'newTextbookCount', default=0) or 0),
        'totalVersions': total_versions,
        'totalTextbooks': total_textbooks,
        'completedTextbooks': completed_textbooks,
        'catalogCount': catalog_count,
        'newCatalogCount': int(_pick(row, 'new_catalog_count', 'newCatalogCount', default=0) or 0),
        'changedCatalogCount': int(_pick(row, 'changed_catalog_count', 'changedCatalogCount', default=0) or 0),
        'questionCount': question_count,
        'questionCatalogCount': question_catalog_count,
        'questionTagCount': question_tag_count,
        'questionAssetCount': question_asset_count,
        'snapshotComplete': snapshot_complete,
        'snapshotLockedAt': snapshot_locked_at,
        'newQuestionCount': int(_pick(row, 'new_question_count', 'newQuestionCount', default=0) or 0),
        'changedQuestionCount': int(_pick(row, 'changed_question_count', 'changedQuestionCount', default=0) or 0),
        'currentTextbookId': _pick(row, 'current_textbook_id', 'currentTextbookId'),
        'currentTextbookName': _pick(row, 'current_textbook_name', 'currentTextbookName'),
        'logTail': log_tail,
        'logs': logs,
        'errorMessage': _pick(row, 'error_message', 'errorMessage'),
        'createdBy': _pick(row, 'created_by', 'createdBy'),
        'startedAt': _pick(row, 'started_at', 'startedAt'),
        'finishedAt': _pick(row, 'finished_at', 'finishedAt'),
        'completedAt': _pick(row, 'finished_at', 'completedAt'),
        'createTime': _pick(row, 'create_time', 'createTime'),
        'updateTime': _pick(row, 'update_time', 'updateTime'),
        # Keep a snake-case-compatible nested projection for non-browser
        # clients without leaking worker tokens or process IDs.
        'scope': scope_payloads,
        'resumeFromCollectorRunId': normalized_row_resume,
        'resumeAvailable': task_status in {'interrupted', 'blocked'} and bool(resume_ids),
        'autoResumeEnabled': auto_resume_enabled,
        'autoResumeAttempt': auto_resume_attempt,
        'autoResumeMaxAttempts': auto_resume_max_attempts,
        'autoResumePending': _as_flag(
            options.get('autoResumePending', options.get('auto_resume_pending', False))
        ),
        'autoResumeNextAt': options.get('autoResumeNextAt') or options.get('auto_resume_next_at'),
    }


def _page(rows: list[dict[str, Any]], query: SyncTaskPageQueryModel) -> PageModel:
    start = (query.page_num - 1) * query.page_size
    selected = rows[start : start + query.page_size]
    return PageModel(
        rows=selected,
        pageNum=query.page_num,
        pageSize=query.page_size,
        total=len(rows),
        hasNext=start + query.page_size < len(rows),
    )


def _row_matches_filters(payload: Mapping[str, Any], query: SyncTaskPageQueryModel) -> bool:
    if query.status and str(payload.get('status')) != query.status:
        return False
    if query.task_no and query.task_no.lower() not in str(payload.get('taskNo') or '').lower():
        return False
    return not (query.version_name and query.version_name.lower() not in str(payload.get('versionName') or '').lower())


def _normalise_catalog(row: Mapping[str, Any] | object) -> dict[str, Any] | None:
    provider = str(_pick(row, 'sourceProvider', 'source_provider', 'provider', default='') or '').strip()
    external_id = _pick(
        row,
        'externalCatalogId',
        'external_catalog_id',
        'externalNodeId',
        'external_node_id',
        'externalId',
        'external_id',
        default=None,
    )
    if not provider or not _safe_external_id(external_id):
        return None
    return {
        'sourceProvider': provider,
        'externalCatalogId': str(external_id),
        'externalNodeId': str(external_id),
        'externalTextbookId': _pick(
            row,
            'externalTextbookId',
            'external_textbook_id',
            'textbookExternalId',
            'textbook_external_id',
        ),
        'parentExternalId': _pick(row, 'parentExternalId', 'parent_external_id', 'parentExternalNodeId'),
        'nodeLevel': _pick(row, 'nodeLevel', 'node_level', 'catalogLevel', 'catalog_level'),
        'nodeType': _pick(row, 'nodeType', 'node_type', default='other') or 'other',
        'nodeName': _pick(row, 'nodeName', 'node_name', 'name', 'catalogName', 'catalog_name'),
        'sourcePath': _pick(row, 'sourcePath', 'source_path', 'catalogPath', 'catalog_path'),
        'catalogPath': _pick(row, 'catalogPath', 'catalog_path', 'sourcePath', 'source_path'),
        'sourceUrl': _pick(row, 'sourceUrl', 'source_url'),
        'sortOrder': _pick(row, 'sortOrder', 'sort_order', default=0),
        'questionCount': int(_pick(row, 'questionCount', 'question_count', default=0) or 0),
        'capturedAt': _pick(row, 'capturedAt', 'captured_at'),
    }


def _normalise_question(row: Mapping[str, Any] | object) -> dict[str, Any] | None:
    provider = str(_pick(row, 'sourceProvider', 'source_provider', 'provider', default='') or '').strip()
    external_id = _pick(
        row,
        'externalQuestionId',
        'external_question_id',
        'questionExternalId',
        'question_external_id',
        'externalId',
        'external_id',
        default=None,
    )
    if not provider or not _safe_external_id(external_id):
        return None
    content_hash = _pick(row, 'contentHash', 'content_hash', 'detailContentHash', 'detail_content_hash')
    plain_text = _pick(row, 'plainText', 'plain_text', default='') or ''
    content_html = _pick(row, 'contentHtml', 'content_html', default=None)
    if not content_hash:
        # A collector may expose only list/detail fields.  Derive a stable
        # fallback so two equal snapshots still compare as existing.
        content_hash = _canonical_hash({'contentHtml': content_html, 'plainText': plain_text})
    result = {
        'sourceProvider': provider,
        'externalQuestionId': str(external_id),
        'externalId': str(external_id),
        'externalTextbookId': _pick(
            row, 'externalTextbookId', 'external_textbook_id', 'textbookExternalId', 'textbook_external_id'
        ),
        'chapterId': _pick(row, 'chapterId', 'chapter_id'),
        'detailUrl': _pick(row, 'detailUrl', 'detail_url'),
        'sourceShort': _pick(row, 'sourceShort', 'source_short'),
        'sourceTitle': _pick(row, 'sourceTitle', 'source_title'),
        'sourceUrl': _pick(row, 'sourceUrl', 'source_url'),
        'sourceQuestionNo': _pick(row, 'sourceQuestionNo', 'source_question_no'),
        'questionType': _pick(row, 'questionType', 'question_type'),
        'questionTypeId': _pick(row, 'questionTypeId', 'question_type_id'),
        'difficulty': _pick(row, 'difficultyLabel', 'difficulty_label', 'difficulty'),
        'difficultyCode': _pick(row, 'difficultyCode', 'difficulty_code'),
        'difficultyCoefficient': _pick(row, 'easeCoefficient', 'ease_coefficient', 'difficultyCoefficient'),
        'contentHtml': content_html,
        'plainText': plain_text,
        'solutionHtml': _pick(row, 'solutionHtml', 'solution_html'),
        'answerStatus': _normalise_answer_status(_pick(row, 'answerStatus', 'answer_status')),
        'contentHash': str(content_hash),
        'listContentHash': _pick(row, 'listContentHash', 'list_content_hash'),
        'detailContentHash': _pick(row, 'detailContentHash', 'detail_content_hash'),
        'contentVersion': _pick(row, 'contentVersion', 'content_version'),
        'questionVersion': _pick(row, 'questionVersion', 'question_version'),
        'snapshotVersion': _pick(row, 'snapshotVersion', 'snapshot_version'),
        'detailFetched': _pick(row, 'detailFetched', 'detail_fetched'),
        'subquestionCount': _pick(row, 'subquestionCount', 'subquestion_count'),
        'childCount': _pick(row, 'childCount', 'child_count'),
        'hasImage': _pick(row, 'hasImage', 'has_image'),
        'hasFormula': _pick(row, 'hasFormula', 'has_formula'),
        'hasTable': _pick(row, 'hasTable', 'has_table'),
        'isNew': _pick(row, 'isNew', 'is_new'),
        'useCount': _pick(row, 'useCount', 'use_count'),
        'providerUpdatedAt': _pick(row, 'providerUpdatedAt', 'provider_updated_at'),
        'catalogCount': int(_pick(row, 'catalogCount', 'catalog_count', default=0) or 0),
        'capturedAt': _pick(row, 'capturedAt', 'captured_at'),
        'catalogs': _pick(row, 'catalogs', 'catalogItems', default=[]),
    }
    # ``solutionHtml`` is the collector's single combined answer/analysis
    # block. Only preserve answer/analysis when the source supplies those
    # fields independently; never derive either one from solutionHtml.
    answer_html = _pick(row, 'answerHtml', 'answer_html', 'answer', 'referenceAnswer', 'reference_answer')
    analysis_html = _pick(row, 'analysisHtml', 'analysis_html', 'analysis', 'explanationHtml', 'explanation_html')
    if answer_html not in (None, ''):
        result['answerHtml'] = answer_html
    if analysis_html not in (None, ''):
        result['analysisHtml'] = analysis_html
    return result


def _formal_question_value(row: Mapping[str, Any] | object) -> dict[str, Any]:
    content_html = _pick(row, 'content_html', 'contentHtml')
    plain_text = _pick(row, 'plain_text', 'plainText')
    content_hash = _pick(row, 'content_hash', 'contentHash')
    if not content_hash:
        content_hash = _canonical_hash({'contentHtml': content_html, 'plainText': plain_text})
    return {
        'sourceProvider': _pick(row, 'source_provider', 'sourceProvider'),
        'externalQuestionId': _pick(row, 'external_question_id', 'externalQuestionId'),
        'externalId': _pick(row, 'external_question_id', 'externalQuestionId'),
        'sourceUrl': _pick(row, 'source_url', 'sourceUrl'),
        'sourceQuestionNo': _pick(row, 'source_question_no', 'sourceQuestionNo'),
        'sourceName': _pick(row, 'paper_name', 'paperName') or _pick(row, 'source_text', 'sourceText'),
        'questionType': _pick(row, 'question_type', 'questionType'),
        'difficulty': _pick(row, 'difficulty', 'difficultyLabel'),
        'difficultyCoefficient': _pick(row, 'difficulty_coefficient', 'difficultyCoefficient'),
        'contentHtml': content_html,
        'plainText': plain_text,
        'answerHtml': _pick(row, 'answer_html', 'answerHtml'),
        'analysisHtml': _pick(row, 'analysis_html', 'analysisHtml'),
        'answerStatus': _normalise_answer_status(_pick(row, 'answer_status', 'answerStatus')),
        'contentHash': str(content_hash),
        'currentLocalId': _pick(row, 'question_id', 'questionId'),
    }


def _question_compare_fields(candidate: Mapping[str, Any], current: Mapping[str, Any]) -> list[str]:
    fields = (
        ('questionType', 'questionType'),
        ('difficulty', 'difficulty'),
        ('sourceUrl', 'sourceUrl'),
        ('sourceQuestionNo', 'sourceQuestionNo'),
        ('answerStatus', 'answerStatus'),
        ('contentHash', 'contentHash'),
    )
    return [left for left, right in fields if _jsonable(candidate.get(left)) != _jsonable(current.get(right))]


def _catalog_tree(rows: list[dict[str, Any]], side: str) -> list[dict[str, Any]]:
    """Build a cycle-safe nested tree from flat catalog projections."""

    nodes: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        provider = str(row.get('sourceProvider') or '')
        textbook = str(row.get('externalTextbookId') or '')
        external_id = str(row.get('externalCatalogId') or row.get('externalNodeId') or '')
        if not provider or not external_id:
            continue
        node = {
            **row,
            'catalogId': external_id,
            'externalNodeId': external_id,
            'label': str(row.get('nodeName') or external_id),
            'sourceProvider': provider,
            'comparisonStatus': 'existing' if side == 'current' else row.get('comparisonStatus', 'existing'),
            'children': [],
        }
        nodes[(provider, textbook, external_id)] = node
    parent_by_key: dict[tuple[str, str, str], tuple[str, str, str] | None] = {}
    for key, node in nodes.items():
        parent = str(node.get('parentExternalId') or '')
        parent_key = (key[0], key[1], parent)
        parent_by_key[key] = parent_key if parent and parent_key in nodes and parent_key != key else None

    roots: list[dict[str, Any]] = []
    for key, node in nodes.items():
        parent_key = parent_by_key[key]
        # A malformed source tree can contain a parent cycle.  Reject the
        # offending edge and expose that node as a root instead of recursing
        # forever while serialising the comparison response.
        cursor = parent_key
        ancestry = {key}
        while cursor is not None and cursor not in ancestry:
            ancestry.add(cursor)
            cursor = parent_by_key.get(cursor)
        if parent_key is not None and cursor is None:
            nodes[parent_key]['children'].append(node)
        else:
            roots.append(node)

    def sort_tree(items: list[dict[str, Any]]) -> None:
        items.sort(key=lambda item: (int(item.get('sortOrder') or 0), str(item.get('externalNodeId') or '')))
        for item in items:
            sort_tree(item['children'])

    sort_tree(roots)
    return roots


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, '__await__'):
        return await value
    return value


def _collector_envelope(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Unwrap the documented ``data``/``summary`` response envelopes."""

    payload: Mapping[str, Any] = raw
    for wrapper in ('data', 'summary'):
        candidate = payload.get(wrapper)
        if isinstance(candidate, Mapping):
            payload = {
                **candidate,
                **{key: value for key, value in payload.items() if key not in {'data', 'summary'}},
            }
            break
    return dict(payload)


def _strict_nonnegative(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ServiceException(message=f'collector {label} 无效')
    if isinstance(value, int):
        result = value
    elif isinstance(value, str) and re.fullmatch(r'\d+', value.strip()):
        result = int(value.strip())
    elif isinstance(value, float) and value.is_integer() and value >= 0:
        result = int(value)
    else:
        raise ServiceException(message=f'collector {label} 无效')
    if result < 0 or result > MAX_SNAPSHOT_ROWS:
        raise ServiceException(message=f'collector {label} 超出安全上限')
    return result


def _collector_scope_ids(value: Any) -> set[str]:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return set()
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {text}
        return _collector_scope_ids(parsed)
    if isinstance(value, Mapping):
        result: set[str] = set()
        for name in (
            'textbookExternalId',
            'textbook_external_id',
            'externalTextbookId',
            'external_textbook_id',
        ):
            item = value.get(name)
            if item not in (None, ''):
                result.add(str(item).strip())
        for name in (
            'textbookExternalIds',
            'textbook_external_ids',
            'textbookIds',
            'textbook_ids',
        ):
            items = value.get(name)
            if isinstance(items, list):
                result.update(str(item).strip() for item in items if item not in (None, ''))
        for name in ('run', 'scope', 'scopeItems', 'scope_items', 'textbooks', 'selectedTextbooks'):
            nested = value.get(name)
            if isinstance(nested, (Mapping, list, str)):
                result.update(_collector_scope_ids(nested))
        return {item for item in result if item}
    if isinstance(value, list):
        result: set[str] = set()
        for item in value:
            result.update(_collector_scope_ids(item))
        return result
    return set()


def _collector_run_id(run: Mapping[str, Any]) -> Any:
    return next((run[name] for name in _COLLECTOR_RUN_ID_ALIASES if run.get(name) is not None), None)


def _validate_collector_run(
    run: Mapping[str, Any],
    run_id: int,
    textbook_external_id: str | None,
    *,
    reference: Mapping[str, Any] | None = None,
) -> None:
    remote_id = _collector_run_id(run)
    if remote_id is None or str(remote_id) != str(run_id):
        raise ServiceException(message='collector 运行快照 ID 不一致')
    provider = run.get('provider', run.get('sourceProvider'))
    if str(provider or '') != PROVIDER:
        raise ServiceException(message='collector 运行快照来源不受支持')
    status = str(run.get('status') or '').strip().lower()
    if status not in {'success', 'completed'}:
        raise ServiceException(message='collector 运行快照未成功完成')
    if textbook_external_id is not None:
        scope_ids = _collector_scope_ids(run)
        if str(textbook_external_id) not in scope_ids:
            raise ServiceException(message='collector 运行快照教材范围不一致')
    for source in (run,):
        markers = [
            source[name]
            for name in ('snapshotComplete', 'snapshot_complete', 'complete', 'isComplete')
            if name in source and source[name] is not None
        ]
        if markers and not all(_as_flag(value) for value in markers):
            raise ServiceException(message='collector 运行快照未完成')
    if reference is not None:
        for aliases in (
            ('provider', 'sourceProvider'),
            ('status',),
            ('snapshotLockedAt', 'snapshot_locked_at', 'locked'),
            ('finishedAt', 'finished_at'),
            ('textbookExternalId', 'textbook_external_id'),
        ):
            left = next((reference[name] for name in aliases if name in reference), None)
            right = next((run[name] for name in aliases if name in run), None)
            if left is not None and right is not None and str(left) != str(right):
                raise ServiceException(message='collector 分页快照运行信息不一致')


def _validate_collector_summary(
    raw: Any,
    run_id: int,
    textbook_external_id: str | None,
    kind: str,
) -> tuple[dict[str, Any], dict[str, Any], int]:
    if not isinstance(raw, Mapping):
        raise ServiceException(message='collector API 快照摘要结构不正确')
    payload = _collector_envelope(raw)
    if payload.get('available') is not True or payload.get('immutable') is not True:
        raise ServiceException(message='collector 快照摘要未锁定或不可用')
    run = payload.get('run')
    if not isinstance(run, Mapping):
        raise ServiceException(message='collector API 快照摘要缺少运行信息')
    _validate_collector_run(run, run_id, textbook_external_id)
    payload_markers = [
        payload[name]
        for name in ('snapshotComplete', 'snapshot_complete', 'complete', 'isComplete')
        if name in payload and payload[name] is not None
    ]
    if not payload_markers or not all(_as_flag(value) for value in payload_markers):
        raise ServiceException(message='collector 快照摘要未完成')
    scope_ids = _collector_scope_ids(payload)
    if textbook_external_id is not None and str(textbook_external_id) not in scope_ids:
        raise ServiceException(message='collector 快照摘要教材范围不一致')
    counts = payload.get('counts')
    if not isinstance(counts, Mapping):
        raise ServiceException(message='collector 快照摘要缺少 counts')
    aliases = _COLLECTOR_COUNT_ALIASES[kind]
    values = [_strict_nonnegative(counts[name], f'{kind} 快照计数') for name in aliases if name in counts]
    if not values or len(set(values)) != 1:
        raise ServiceException(message=f'collector 快照 {kind} 计数结构不一致')
    return payload, dict(run), values[0]


async def _collector_call(method: Any, *args: Any, **kwargs: Any) -> Any:
    result = await asyncio.to_thread(method, *args, **kwargs)
    return await _maybe_await(result)


async def _collector_summary(
    client: CollectorClient,
    run_id: int,
    textbook_external_id: str | None,
    kind: str,
) -> tuple[dict[str, Any], dict[str, Any], int]:
    method = getattr(client, 'run_snapshot_summary', None) or getattr(client, 'snapshot_summary', None)
    if not callable(method):
        raise ServiceException(message='collector 客户端不支持快照摘要接口')
    try:
        raw = await _collector_call(method, run_id, textbook_external_id=textbook_external_id)
    except TypeError:
        # Small integration doubles may omit the optional scope keyword. The
        # response is still subjected to the same strict scope validation.
        raw = await _collector_call(method, run_id)
    return _validate_collector_summary(raw, run_id, textbook_external_id, kind)


def _collector_page_rows(
    payload: Any,
    run_id: int,
    textbook_external_id: str | None,
    kind: str,
    reference_run: Mapping[str, Any],
    expected_total: int,
    requested_page: int,
    requested_page_size: int,
    *,
    filtered: bool,
) -> tuple[dict[str, Any], list[dict[str, Any]], int]:
    if not isinstance(payload, Mapping):
        raise ServiceException(message='collector API 分页快照结构不正确')
    if payload.get('available') is not True:
        raise ServiceException(message='collector 分页快照不可用')
    run = payload.get('run')
    if not isinstance(run, Mapping):
        raise ServiceException(message='collector API 分页快照缺少运行信息')
    _validate_collector_run(run, run_id, textbook_external_id, reference=reference_run)
    page = _strict_nonnegative(payload.get('page'), '分页 page')
    if page != requested_page or page < 1:
        raise ServiceException(message='collector 分页快照 page 不一致')
    page_size_value = payload.get('pageSize', payload.get('page_size', requested_page_size))
    page_size = _strict_nonnegative(page_size_value, '分页 pageSize')
    if page_size <= 0 or page_size > MAX_SNAPSHOT_ROWS or page_size != requested_page_size:
        raise ServiceException(message='collector 分页快照 pageSize 不一致')
    total = _strict_nonnegative(payload.get('total'), '分页 total')
    if total > expected_total or (not filtered and total != expected_total):
        raise ServiceException(message='collector 分页快照计数与摘要不一致')
    rows = payload.get('rows')
    if rows is None:
        rows = payload.get('items')
    if rows is None:
        rows = payload.get('catalogs' if kind == 'catalog' else 'questions')
    if not isinstance(rows, list) or any(not isinstance(item, Mapping) for item in rows):
        raise ServiceException(message=f'collector API 分页 {kind} 行结构不正确')
    if len(rows) > page_size or len(rows) > MAX_SNAPSHOT_ROWS:
        raise ServiceException(message='collector 分页快照页大小超过安全上限')
    return dict(run), [dict(item) for item in rows], total


async def _collector_rows(  # noqa: PLR0912, PLR0915
    run_id: int,
    kind: str,
    textbook_external_id: str | None,
    *,
    catalog_external_id: str | None = None,
    question_type: str | None = None,
    keyword: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Read only the requested comparison collection over the HTTP API.

    Summary validation establishes the immutable run/scope and the maximum
    collection count. The legacy collection endpoints then page only catalogs
    or questions, avoiding a five-collection snapshot (and its assets) for a
    browser comparison request.
    """

    if kind not in {'catalog', 'question'}:
        raise ServiceException(message='不支持的题库快照类型')
    client = CollectorClient()
    kind_name = 'catalog' if kind == 'catalog' else 'question'
    _summary, summary_run, expected_total = await _collector_summary(
        client,
        run_id,
        textbook_external_id,
        kind_name,
    )
    method_name = 'run_catalogs' if kind == 'catalog' else 'run_questions'
    method = getattr(client, method_name, None)
    if not callable(method):
        alias = 'catalogs' if kind == 'catalog' else 'questions'
        method = getattr(client, alias, None)
    if not callable(method):
        raise ServiceException(message='collector 客户端不支持题库分页接口')
    page_size = 500 if kind == 'catalog' else 200
    filtered = bool(catalog_external_id or question_type or keyword)
    kwargs: dict[str, Any] = {
        'textbook_external_id': textbook_external_id,
        'page': 1,
        'page_size': page_size,
    }
    if kind == 'question':
        kwargs.update(
            {
                'catalog_external_id': catalog_external_id,
                'question_type': question_type,
                'keyword': keyword,
            }
        )
    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    page_number = 1
    total: int | None = None
    while True:
        call_kwargs = {**kwargs, 'page': page_number}
        try:
            payload = await _collector_call(method, run_id, **call_kwargs)
        except TypeError:
            # Keep simple test/integration doubles compatible while the real
            # client always uses the fully filtered endpoint contract.
            try:
                payload = await _collector_call(
                    method,
                    run_id,
                    textbook_external_id=textbook_external_id,
                    page=page_number,
                    page_size=page_size,
                )
            except TypeError:
                fallback = {'textbook_external_id': textbook_external_id}
                payload = await _collector_call(method, run_id, **fallback)
        page_run, batch, page_total = _collector_page_rows(
            payload,
            run_id,
            textbook_external_id,
            kind_name,
            summary_run,
            expected_total,
            page_number,
            page_size,
            filtered=filtered,
        )
        if total is None:
            total = page_total
        elif total != page_total:
            raise ServiceException(message='collector 分页快照 total 在页间不一致')
        for item in batch:
            row_provider = str(_pick(item, 'sourceProvider', 'source_provider', 'provider', default='') or '').strip()
            if row_provider != PROVIDER:
                raise ServiceException(message=f'collector 分页 {kind_name} 行来源不受支持')
            row_textbook = _pick(
                item,
                'externalTextbookId',
                'external_textbook_id',
                'textbookExternalId',
                'textbook_external_id',
            )
            if textbook_external_id is not None and str(row_textbook or '').strip() != str(textbook_external_id):
                raise ServiceException(message=f'collector 分页 {kind_name} 行教材范围不一致')
            external_id = _pick(
                item,
                'externalCatalogId' if kind == 'catalog' else 'externalQuestionId',
                'catalog_external_id' if kind == 'catalog' else 'question_external_id',
                'externalId',
                'external_id',
            )
            if not _safe_external_id(external_id):
                raise ServiceException(message=f'collector 分页 {kind_name} 行缺少安全外部 ID')
            identity = str(external_id)
            if identity in seen_ids:
                raise ServiceException(message=f'collector 分页 {kind_name} 包含重复行')
            seen_ids.add(identity)
            if kind == 'question' and catalog_external_id:
                # The specialized endpoint filters by catalog but does not
                # repeat relation rows; preserve the selected catalog for the
                # existing comparison projection/filter.
                item['catalogs'] = [{'externalCatalogId': str(catalog_external_id)}]
            rows.append(item)
        if len(rows) > total:
            raise ServiceException(message='collector 分页快照累计行数超过 total')
        has_next = payload.get('hasNext') if isinstance(payload, Mapping) else None
        if len(rows) == total:
            if has_next is True:
                raise ServiceException(message='collector 分页快照 hasNext 与 total 不一致')
            return page_run, rows
        if not batch or has_next is False:
            raise ServiceException(message='collector 分页快照页未前进或提前结束')
        page_number += 1
        if page_number > MAX_SNAPSHOT_ROWS:
            raise ServiceException(message='collector 分页快照页数超过安全上限')


async def _collector_question_detail(run_id: int, external_id: str, textbook_external_id: str | None) -> dict[str, Any]:
    """Validate the run summary, then read one question detail over HTTP."""

    client = CollectorClient()
    _summary, summary_run, _expected_total = await _collector_summary(
        client,
        run_id,
        textbook_external_id,
        'question',
    )
    method = getattr(client, 'run_question_detail', None) or getattr(client, 'question_detail', None)
    if not callable(method):
        raise ServiceException(message='collector 客户端不支持题目详情接口')
    try:
        payload = await _collector_call(
            method,
            run_id,
            external_id,
            textbook_external_id=textbook_external_id,
        )
    except TypeError:
        payload = await _collector_call(method, run_id, external_id)
    if not isinstance(payload, Mapping):
        raise ServiceException(message='collector API 题目详情结构不正确')
    if payload.get('available') is not True:
        raise ServiceException(message=str(payload.get('message') or 'collector 没有可用的题目详情快照'))
    detail_run = payload.get('run')
    if not isinstance(detail_run, Mapping):
        raise ServiceException(message='collector API 题目详情缺少运行信息')
    _validate_collector_run(detail_run, run_id, textbook_external_id, reference=summary_run)
    item = payload.get('item') or payload.get('question') or payload.get('data')
    if not isinstance(item, Mapping):
        raise ServiceException(message='collector API 题目详情缺少题目')
    item_id = _pick(item, 'externalQuestionId', 'questionExternalId', 'external_question_id', 'externalId', 'external_id')
    if not _safe_external_id(item_id) or str(item_id) != str(external_id):
        raise ServiceException(message='collector API 题目详情外部 ID 不一致')
    provider = str(_pick(item, 'sourceProvider', 'source_provider', 'provider', default='') or '')
    if provider != PROVIDER:
        raise ServiceException(message='collector API 题目详情来源不受支持')
    if textbook_external_id is not None and str(textbook_external_id) not in (
        _collector_scope_ids(payload) | _collector_scope_ids(detail_run) | _collector_scope_ids(item)
    ):
        raise ServiceException(message='collector API 题目详情教材范围不一致')
    return dict(item)


class SyncTaskService:
    """Business logic for the independent textbook/question task modules."""

    # ---------------------------- task lifecycle -------------------------
    @classmethod
    async def create_textbook(
        cls,
        db: AsyncSession,
        payload: SyncTaskCreateModel | Mapping[str, Any] | None = None,
        operator: str | None = None,
    ) -> dict[str, Any]:
        request = (
            payload if isinstance(payload, SyncTaskCreateModel) else SyncTaskCreateModel.model_validate(payload or {})
        )
        if not request.acknowledge_source_policy:
            raise ServiceException(message='开始同步前必须确认已核对来源站规则、授权范围和内容使用边界')
        from plugins.bank.service.sync_run_service import SyncRunService  # noqa: PLC0415

        return await SyncRunService._create_job(
            db,
            run_type='metadata',
            task_module='textbook',
            acknowledge_source_policy=True,
            operator=operator,
        )

    @classmethod
    async def _list(cls, db: AsyncSession, module: str, query: SyncTaskPageQueryModel) -> PageModel:
        page = await SyncTaskDao.list_page(db, module, query)
        rows = list(getattr(page, 'rows', []) or [])
        payloads: list[dict[str, Any]] = []
        for row in rows:
            scopes = await SyncTaskDao.scopes(db, int(_pick(row, 'run_id', 'runId', default=0) or 0))
            projected = task_payload(row, scopes)
            # SQL applies all current filters.  Keep this defensive check for
            # lightweight DAO doubles and old databases whose JSON operator
            # cannot filter ``versionName``.
            if _row_matches_filters(projected, query):
                payloads.append(projected)
        if len(payloads) == len(rows):
            page.rows = payloads
            return page
        # A fallback page is only used when a test double/legacy dialect
        # returned rows that did not satisfy the SQL projection.
        return _page(payloads, query)

    @classmethod
    async def list_textbook(cls, db: AsyncSession, query: SyncTaskPageQueryModel) -> PageModel:
        return await cls._list(db, 'textbook', query)

    @classmethod
    async def list_question(cls, db: AsyncSession, query: SyncTaskPageQueryModel) -> PageModel:
        return await cls._list(db, 'question', query)

    @classmethod
    async def _detail(cls, db: AsyncSession, task_id: int, module: str) -> dict[str, Any]:
        row = await SyncTaskDao.get(db, task_id, module)
        if row is None:
            raise ServiceException(message='同步任务不存在')
        scopes = await SyncTaskDao.scopes(db, task_id)
        payload = task_payload(row, scopes)
        if module == 'textbook':
            from plugins.bank.service.textbook_apply_service import TextbookApplyService  # noqa: PLC0415

            payload.update(await TextbookApplyService.task_apply_status(db, row, scopes))
        elif module == 'question':
            from plugins.bank.service.question_apply_service import QuestionApplyService  # noqa: PLC0415

            apply_status = await QuestionApplyService.task_apply_status(db, row, scopes)
            # Keep the rich nested projection for new clients and flatten its
            # stable compatibility fields for existing task-page consumers.
            payload['applyStatus'] = apply_status
            payload.update(
                {
                    key: value
                    for key, value in apply_status.items()
                    if key != 'applyStatus'
                }
            )
        return payload

    @classmethod
    async def textbook_detail(cls, db: AsyncSession, task_id: int) -> dict[str, Any]:
        return await cls._detail(db, task_id, 'textbook')

    @classmethod
    async def question_detail(cls, db: AsyncSession, task_id: int) -> dict[str, Any]:
        return await cls._detail(db, task_id, 'question')

    @staticmethod
    async def _delete(db: AsyncSession, task_id: int, module: str, label: str) -> None:
        # Question apply locks the task before its per-textbook state rows.
        # Delete must use the same order so it cannot remove a task between
        # snapshot validation and the formal-state commit. Textbook apply has
        # one provider state row and retains its established state->task order.
        row = (
            await SyncTaskDao.get_for_update(db, task_id, module)
            if module == 'question'
            else await SyncTaskDao.get(db, task_id, module)
        )
        if row is None:
            raise ServiceException(message=f'同步{label}任务不存在')
        status = str(_pick(row, 'status', default='') or '').strip().lower()
        if status not in _TERMINAL_TASK_STATUSES:
            raise ServiceException(message='只有终态同步任务（completed/failed/blocked/cancelled/interrupted）可以删除')
        if module == 'textbook':
            from plugins.bank.service.textbook_apply_service import TextbookApplyService  # noqa: PLC0415

            await TextbookApplyService.ensure_task_not_current(db, task_id)
        elif module == 'question':
            from plugins.bank.service.question_apply_service import QuestionApplyService  # noqa: PLC0415

            await QuestionApplyService.ensure_task_not_current(db, task_id)

        async def operation() -> int:
            deleted = await SyncTaskDao.delete_task(db, task_id, module)
            if not deleted:
                raise ServiceException(message='同步任务不存在或状态已变化，请刷新后重试')
            return deleted

        await _commit_or_rollback(db, operation())

    @classmethod
    async def delete_textbook(cls, db: AsyncSession, task_id: int) -> None:
        await cls._delete(db, task_id, 'textbook', '教材')

    @classmethod
    async def delete_question(cls, db: AsyncSession, task_id: int) -> None:
        await cls._delete(db, task_id, 'question', '题库')

    @staticmethod
    async def _cancel(db: AsyncSession, task_id: int, module: str) -> dict[str, Any]:
        row = await SyncTaskDao.get(db, task_id, module)
        if row is None:
            raise ServiceException(message='同步任务不存在')
        from plugins.bank.service.sync_run_service import SyncRunService  # noqa: PLC0415

        return await SyncRunService.cancel(db, task_id)

    @classmethod
    async def cancel_textbook(cls, db: AsyncSession, task_id: int) -> dict[str, Any]:
        return await cls._cancel(db, task_id, 'textbook')

    @classmethod
    async def cancel_question(cls, db: AsyncSession, task_id: int) -> dict[str, Any]:
        return await cls._cancel(db, task_id, 'question')

    @classmethod
    async def resume_question(cls, db: AsyncSession, task_id: int, operator: str | None = None) -> dict[str, Any]:
        """Resume an interrupted question task without allocating a new ID."""

        from plugins.bank.service.sync_run_service import SyncRunService  # noqa: PLC0415

        return await SyncRunService.resume_question(db, task_id, operator)

    @classmethod
    async def retry_textbook(cls, db: AsyncSession, task_id: int, operator: str | None = None) -> dict[str, Any]:
        row = await SyncTaskDao.get(db, task_id, 'textbook')
        if row is None:
            raise ServiceException(message='同步教材任务不存在')
        if str(_pick(row, 'status', default='')) not in {'failed', 'blocked', 'cancelled', 'interrupted'}:
            raise ServiceException(message='只有失败、阻断、已停止或已中断的任务可以重试')
        from plugins.bank.service.sync_run_service import SyncRunService  # noqa: PLC0415

        return await SyncRunService._create_job(
            db,
            run_type='metadata',
            task_module='textbook',
            acknowledge_source_policy=True,
            operator=operator,
            retry_of_run_id=task_id,
        )

    @classmethod
    async def retry_question(cls, db: AsyncSession, task_id: int, operator: str | None = None) -> dict[str, Any]:
        row = await SyncTaskDao.get(db, task_id, 'question')
        if row is None:
            raise ServiceException(message='同步题库任务不存在')
        if str(_pick(row, 'status', default='')) not in {'failed', 'blocked', 'cancelled', 'interrupted'}:
            raise ServiceException(message='只有失败、阻断、已停止或已中断的任务可以重试')
        scopes = await SyncTaskDao.scopes(db, task_id)
        options = _task_options(row)
        version_id = options.get('versionId') or options.get('version_id')
        textbook_ids = options.get('textbookIds') or options.get('textbook_ids')
        if not isinstance(textbook_ids, list):
            textbook_ids = [
                item.get('localTextbookId')
                for item in (_scope_payload(scope) for scope in scopes)
                if item.get('localTextbookId')
            ]
        if version_id is None:
            version_id = next(
                (
                    item.get('localVersionId')
                    for item in (_scope_payload(scope) for scope in scopes)
                    if item.get('localVersionId') is not None
                ),
                None,
            )
        if not textbook_ids or version_id is None:
            raise ServiceException(message='原题库任务缺少可重试的版本或教材范围')
        # A retry gets a new collector run and therefore new mutable worker
        # state. Copy only the immutable formal/external selection identity
        # from the old scopes. Historical metadata/source-task bindings are
        # intentionally not required and are never propagated.
        retry_scopes: list[dict[str, Any]] = []
        for scope in scopes:
            retry_scope = _scope_payload(scope)
            retry_scope.update(
                {
                    'metadataRunId': None,
                    'metadata_run_id': None,
                    'status': 'queued',
                    'collectorJobId': None,
                    'collectorRunId': None,
                    'resumeFromCollectorRunId': None,
                    'catalogCount': 0,
                    'questionCount': 0,
                    'newCatalogCount': 0,
                    'changedCatalogCount': 0,
                    'newQuestionCount': 0,
                    'changedQuestionCount': 0,
                    'questionCatalogCount': 0,
                    'questionTagCount': 0,
                    'questionAssetCount': 0,
                    'snapshotComplete': False,
                    'snapshotLockedAt': None,
                    'errorMessage': None,
                    'startedAt': None,
                    'finishedAt': None,
                }
            )
            retry_scopes.append(retry_scope)
        from plugins.bank.service.sync_run_service import SyncRunService  # noqa: PLC0415

        return await SyncRunService._create_job(
            db,
            run_type='content',
            task_module='question',
            acknowledge_source_policy=True,
            operator=operator,
            metadata_run_id=None,
            textbook_external_ids=[
                str(item.get('externalTextbookId'))
                for item in (_scope_payload(scope) for scope in scopes)
                if item.get('externalTextbookId')
            ],
            source_task_id=None,
            retry_of_run_id=task_id,
            scope_rows=retry_scopes,
            extra_options={'versionId': int(version_id), 'textbookIds': [int(item) for item in textbook_ids]},
        )

    # ----------------------------- options/create ------------------------
    @classmethod
    async def question_options(cls, db: AsyncSession) -> dict[str, Any]:
        try:
            versions_result = await db.execute(
                select(QbTextbookVersion)
                .where(QbTextbookVersion.status == '0')
                .order_by(QbTextbookVersion.sort_order, QbTextbookVersion.version_id)
            )
            textbooks_result = await db.execute(
                select(QbTextbook)
                .where(QbTextbook.status == '0')
                .order_by(QbTextbook.version_id, QbTextbook.sort_order, QbTextbook.textbook_id)
            )
            versions = _scalars(versions_result)
            textbooks = _scalars(textbooks_result)
        except SQLAlchemyError as exc:
            raise ServiceException(message='正式版本和教材查询失败，请确认数据库迁移和连接状态') from exc
        books_by_version: dict[int, list[Any]] = {}
        for book in textbooks:
            version_id = _pick(book, 'version_id', 'versionId')
            if version_id is not None:
                books_by_version.setdefault(int(version_id), []).append(book)
        result: list[dict[str, Any]] = []
        for version in versions:
            version_id = int(_pick(version, 'version_id', 'versionId', default=0) or 0)
            provider = str(_pick(version, 'source_provider', 'sourceProvider', default='') or '')
            external_version_id = _pick(version, 'external_version_id', 'externalVersionId')
            version_valid = bool(provider and _safe_external_id(external_version_id))
            book_values: list[dict[str, Any]] = []
            for book in books_by_version.get(version_id, []):
                book_provider = str(_pick(book, 'source_provider', 'sourceProvider', default='') or '')
                external_book_id = _pick(book, 'external_textbook_id', 'externalTextbookId')
                valid = bool(version_valid and book_provider == provider and _safe_external_id(external_book_id))
                reason = ''
                if not provider or not _safe_external_id(external_version_id):
                    reason = '版本缺少稳定采集来源标识'
                elif book_provider != provider:
                    reason = '教材来源提供方与版本不一致'
                elif not _safe_external_id(external_book_id):
                    reason = '教材缺少稳定采集来源标识'
                book_values.append(
                    {
                        'textbookId': int(_pick(book, 'textbook_id', 'textbookId', default=0) or 0),
                        'textbookName': _pick(book, 'textbook_name', 'textbookName'),
                        'versionId': version_id,
                        'sourceProvider': book_provider,
                        'externalTextbookId': external_book_id,
                        'grade': _pick(book, 'grade'),
                        'volume': _pick(book, 'volume'),
                        'disabled': not valid,
                        'disabledReason': reason,
                    }
                )
            selectable = any(not item['disabled'] for item in book_values)
            result.append(
                {
                    'versionId': version_id,
                    'versionName': _pick(version, 'version_name', 'versionName'),
                    'sourceProvider': provider,
                    'externalVersionId': external_version_id,
                    'disabled': not (version_valid and selectable),
                    'disabledReason': (
                        ''
                        if version_valid and selectable
                        else ('该版本下暂无可同步教材' if version_valid else '版本缺少稳定采集来源标识')
                    ),
                    'textbooks': book_values,
                }
            )
        return {'versions': result}

    @classmethod
    async def _resolve_question_scope(
        cls,
        db: AsyncSession,
        payload: QuestionTaskCreateModel,
    ) -> tuple[Any, list[Any]]:
        ids = [int(value) for value in payload.textbook_ids]
        if len(ids) != len(set(ids)):
            raise ServiceException(message='教材 ID 列表必须去重，不能包含重复教材')
        version = await BankDao.get_version(db, int(payload.version_id))
        if version is None:
            raise ServiceException(message='正式版本不存在')
        if str(_pick(version, 'status', default='0')) == '1':
            raise ServiceException(message='只能选择启用的正式版本')
        provider = str(_pick(version, 'source_provider', 'sourceProvider', default='') or '').strip()
        external_version_id = _pick(version, 'external_version_id', 'externalVersionId')
        if not provider or not _safe_external_id(external_version_id):
            raise ServiceException(message='所选版本缺少稳定采集来源标识，不能创建题库任务')
        books: list[Any] = []
        for textbook_id in ids:
            book = await BankDao.get_textbook(db, textbook_id)
            if book is None:
                raise ServiceException(message=f'正式教材 {textbook_id} 不存在')
            if str(_pick(book, 'status', default='0')) == '1':
                raise ServiceException(message=f'正式教材 {textbook_id} 已停用，不能创建题库任务')
            if int(_pick(book, 'version_id', 'versionId', default=0) or 0) != int(payload.version_id):
                raise ServiceException(message='所选教材必须全部属于同一个版本')
            book_provider = str(_pick(book, 'source_provider', 'sourceProvider', default='') or '').strip()
            external_book_id = _pick(book, 'external_textbook_id', 'externalTextbookId')
            if book_provider != provider:
                raise ServiceException(message='所选教材与版本的来源提供方不一致')
            if not _safe_external_id(external_book_id):
                raise ServiceException(message=f'教材 {textbook_id} 缺少稳定采集来源 ID，不能创建题库任务')
            books.append(book)
        # Question synchronization is based directly on the enabled formal
        # version/textbook rows and their stable external identities. It does
        # not require a textbook task, apply-state row, or metadata run.
        return version, books

    @classmethod
    async def create_question(
        cls,
        db: AsyncSession,
        payload: QuestionTaskCreateModel | Mapping[str, Any],
        operator: str | None = None,
    ) -> dict[str, Any]:
        request = (
            payload if isinstance(payload, QuestionTaskCreateModel) else QuestionTaskCreateModel.model_validate(payload)
        )
        version, books = await cls._resolve_question_scope(db, request)
        scope_rows: list[dict[str, Any]] = []
        external_ids: list[str] = []
        for book in books:
            external_id = str(_pick(book, 'external_textbook_id', 'externalTextbookId'))
            external_ids.append(external_id)
            scope_rows.append(
                {
                    'local_version_id': int(request.version_id),
                    'local_textbook_id': int(_pick(book, 'textbook_id', 'textbookId')),
                    'version_name_snapshot': _pick(version, 'version_name', 'versionName'),
                    'textbook_name_snapshot': _pick(book, 'textbook_name', 'textbookName'),
                    'source_provider': _pick(book, 'source_provider', 'sourceProvider'),
                    'external_version_id': _pick(version, 'external_version_id', 'externalVersionId'),
                    'external_textbook_id': external_id,
                    # Content collection allocates and persists a fresh
                    # collectorRunId for this task; no metadata run is bound.
                    'metadata_run_id': None,
                    'collector_run_id': None,
                    'status': 'queued',
                }
            )
        from plugins.bank.service.sync_run_service import SyncRunService  # noqa: PLC0415

        return await SyncRunService._create_job(
            db,
            run_type='content',
            task_module='question',
            acknowledge_source_policy=True,
            operator=operator,
            metadata_run_id=None,
            textbook_external_ids=external_ids,
            source_task_id=None,
            scope_rows=scope_rows,
            extra_options={
                'versionId': int(request.version_id),
                'versionName': _pick(version, 'version_name', 'versionName'),
                'textbookIds': [int(value) for value in request.textbook_ids],
                'textbookNames': [_pick(book, 'textbook_name', 'textbookName') for book in books],
                'textbookScopes': [
                    {
                        'sourceProvider': _pick(book, 'source_provider', 'sourceProvider'),
                        'externalVersionId': _pick(version, 'external_version_id', 'externalVersionId'),
                        'externalTextbookId': str(_pick(book, 'external_textbook_id', 'externalTextbookId')),
                        'versionName': _pick(version, 'version_name', 'versionName'),
                        'textbookName': _pick(book, 'textbook_name', 'textbookName'),
                    }
                    for book in books
                ],
            },
        )

    # -------------------------- formal projections -----------------------
    @classmethod
    async def _formal_catalogs(cls, db: AsyncSession, textbook_ids: list[int]) -> list[Any]:
        if not textbook_ids:
            return []
        result = await db.execute(
            select(QbCatalogNode)
            .where(QbCatalogNode.textbook_id.in_(textbook_ids))
            .order_by(QbCatalogNode.textbook_id, QbCatalogNode.sort_order, QbCatalogNode.catalog_id)
        )
        return _scalars(result)

    @classmethod
    async def _formal_questions(cls, db: AsyncSession, textbook_ids: list[int]) -> list[Any]:
        if not textbook_ids:
            return []
        result = await db.execute(
            select(QbQuestion)
            .join(QbQuestionCatalog, QbQuestionCatalog.question_id == QbQuestion.question_id)
            .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id)
            .where(
                QbCatalogNode.textbook_id.in_(textbook_ids),
                QbQuestionCatalog.relation_type == 'query_catalog',
            )
            .distinct()
        )
        return _scalars(result)

    @classmethod
    async def _scope_selection(
        cls,
        db: AsyncSession,
        task_id: int,
        query: TaskComparisonQueryModel | None,
    ) -> tuple[QbSyncJob, list[Any]]:
        row = await SyncTaskDao.get(db, task_id, 'question')
        if row is None:
            raise ServiceException(message='同步题库任务不存在')
        if str(_pick(row, 'status', default='')) != 'completed':
            raise ServiceException(message='题库任务尚未成功完成，暂不能查看快照对比')
        scopes = await SyncTaskDao.scopes(db, task_id)
        query = query or TaskComparisonQueryModel()
        if query.scope_id:
            scopes = [
                scope for scope in scopes if int(_pick(scope, 'scope_id', 'scopeId', default=0) or 0) == query.scope_id
            ]
        if query.textbook_id:
            scopes = [
                scope
                for scope in scopes
                if int(_pick(scope, 'local_textbook_id', 'localTextbookId', default=0) or 0) == query.textbook_id
            ]
        if query.external_textbook_id:
            scopes = [
                scope
                for scope in scopes
                if str(_pick(scope, 'external_textbook_id', 'externalTextbookId', default=''))
                == query.external_textbook_id
            ]
        if query.collector_run_id:
            scopes = [
                scope
                for scope in scopes
                if int(_pick(scope, 'collector_run_id', 'collectorRunId', default=0) or 0) == query.collector_run_id
            ]
        if query.source_provider:
            scopes = [
                scope
                for scope in scopes
                if str(_pick(scope, 'source_provider', 'sourceProvider', default='') or '') == query.source_provider
            ]
        if not scopes:
            raise ServiceException(message='没有匹配的教材任务范围或可用的 collectorRunId 快照')
        return row, scopes

    # ----------------------------- comparisons ---------------------------
    @classmethod
    async def textbook_comparison(cls, db: AsyncSession, task_id: int) -> dict[str, Any]:
        row = await SyncTaskDao.get(db, task_id, 'textbook')
        if row is None:
            raise ServiceException(message='同步教材任务不存在')
        if str(_pick(row, 'status', default='')) != 'completed':
            raise ServiceException(message='同步教材任务尚未成功完成，暂不能查看快照对比')
        metadata_run_id = _pick(row, 'metadata_run_id', 'metadataRunId')
        if not metadata_run_id:
            raise ServiceException(message='同步教材任务缺少 metadataRunId，无法读取不可变快照')
        from plugins.bank.service.sync_service import SyncService  # noqa: PLC0415

        return await SyncService.metadata_textbook_overview(db, int(metadata_run_id))

    @classmethod
    async def catalog_comparison(
        cls,
        db: AsyncSession,
        task_id: int,
        query: TaskComparisonQueryModel | None = None,
    ) -> dict[str, Any]:
        query = query or TaskComparisonQueryModel()
        _job, scopes = await cls._scope_selection(db, task_id, query)
        fetched: list[dict[str, Any]] = []
        source_messages: list[str] = []
        for scope in scopes:
            run_id = _pick(scope, 'collector_run_id', 'collectorRunId')
            if not run_id:
                source_messages.append(
                    f'教材 {_pick(scope, "textbook_name_snapshot", "textbookNameSnapshot", default="")} 缺少 collectorRunId'
                )
                continue
            _run, raw_rows = await _collector_rows(
                int(run_id),
                'catalog',
                str(_pick(scope, 'external_textbook_id', 'externalTextbookId', default='')) or None,
            )
            for raw in raw_rows:
                item = _normalise_catalog(raw)
                if item is not None:
                    item['externalTextbookId'] = item.get('externalTextbookId') or str(
                        _pick(scope, 'external_textbook_id', 'externalTextbookId', default='') or ''
                    )
                    fetched.append(item)
        # Formal nodes are loaded for all selected local textbooks and mapped
        # by provider + external ID, exactly like the source side.
        local_ids = [
            int(_pick(scope, 'local_textbook_id', 'localTextbookId'))
            for scope in scopes
            if _pick(scope, 'local_textbook_id', 'localTextbookId') is not None
        ]
        formal_rows = await cls._formal_catalogs(db, local_ids)
        textbook_external_by_local: dict[int, str | None] = {}
        if local_ids:
            try:
                textbook_result = await db.execute(
                    select(QbTextbook.textbook_id, QbTextbook.external_textbook_id).where(
                        QbTextbook.textbook_id.in_(local_ids)
                    )
                )
                textbook_external_by_local = {
                    int(local_id): external_id for local_id, external_id in textbook_result.all()
                }
            except SQLAlchemyError:
                textbook_external_by_local = {}
        parent_map = {
            int(_pick(item, 'catalog_id', 'catalogId')): item
            for item in formal_rows
            if _pick(item, 'catalog_id', 'catalogId') is not None
        }
        current: list[dict[str, Any]] = []
        for item in formal_rows:
            parent = (
                parent_map.get(int(_pick(item, 'parent_id', 'parentId')))
                if _pick(item, 'parent_id', 'parentId') is not None
                else None
            )
            textbook_id = _pick(item, 'textbook_id', 'textbookId')
            current.append(
                {
                    'sourceProvider': _pick(item, 'source_provider', 'sourceProvider'),
                    'externalCatalogId': _pick(item, 'external_node_id', 'externalNodeId'),
                    'externalNodeId': _pick(item, 'external_node_id', 'externalNodeId'),
                    'externalTextbookId': textbook_external_by_local.get(int(textbook_id))
                    if textbook_id is not None
                    else None,
                    'parentExternalId': _pick(parent, 'external_node_id', 'externalNodeId') if parent else None,
                    'nodeName': _pick(item, 'node_name', 'nodeName'),
                    'nodeType': _pick(item, 'node_type', 'nodeType'),
                    'sourceUrl': _pick(item, 'source_url', 'sourceUrl'),
                    'sortOrder': _pick(item, 'sort_order', 'sortOrder', default=0),
                    'catalogId': _pick(item, 'catalog_id', 'catalogId'),
                }
            )
        current_by_key = {
            (
                str(item.get('sourceProvider') or ''),
                str(item.get('externalTextbookId') or ''),
                str(item.get('externalCatalogId') or ''),
            ): item
            for item in current
            if item.get('externalCatalogId')
        }
        seen: set[tuple[str, str, str]] = set()
        comparisons: list[dict[str, Any]] = []
        for item in fetched:
            key = (
                str(item.get('sourceProvider') or ''),
                str(item.get('externalTextbookId') or ''),
                str(item.get('externalCatalogId') or ''),
            )
            if key in seen:
                continue
            seen.add(key)
            formal = current_by_key.get(key)
            fields = ('externalTextbookId', 'parentExternalId', 'nodeName', 'nodeType', 'sourceUrl', 'sortOrder')
            changed = [field for field in fields if _jsonable(item.get(field)) != _jsonable((formal or {}).get(field))]
            status = 'new' if formal is None else ('changed' if changed else 'existing')
            comparisons.append(
                {
                    **item,
                    'comparisonStatus': status,
                    'diffFields': changed,
                    'fetched': item,
                    'candidate': item,
                    'current': formal,
                    'changedFields': changed,
                }
            )
        if query.keyword:
            needle = query.keyword.lower()
            comparisons = [item for item in comparisons if needle in json.dumps(item, ensure_ascii=False).lower()]
        if query.comparison_status:
            wanted = 'existing' if query.comparison_status == 'unchanged' else query.comparison_status
            comparisons = [item for item in comparisons if item.get('comparisonStatus') == wanted]
        summary_counts = Counter(item.get('comparisonStatus') for item in comparisons)
        summary = {
            'total': len(comparisons),
            'newCount': summary_counts.get('new', 0),
            'existingCount': summary_counts.get('existing', 0),
            'changedCount': summary_counts.get('changed', 0),
        }
        # Include formal-only nodes in the right tree, while the fetched tree
        # carries the status/diff annotations.
        return {
            'sourceAvailable': bool(fetched or not source_messages),
            'sourceMessage': '；'.join(dict.fromkeys(source_messages)),
            'summary': summary,
            'fetchedTree': _catalog_tree(comparisons, 'fetched'),
            'currentTree': _catalog_tree(current, 'current'),
            'rows': comparisons,
            'total': len(comparisons),
        }

    @classmethod
    async def question_comparison(  # noqa: PLR0912, PLR0915
        cls,
        db: AsyncSession,
        task_id: int,
        query: TaskComparisonQueryModel | None = None,
    ) -> dict[str, Any]:
        query = query or TaskComparisonQueryModel()
        _job, scopes = await cls._scope_selection(db, task_id, query)
        fetched: list[dict[str, Any]] = []
        source_messages: list[str] = []
        for scope in scopes:
            run_id = _pick(scope, 'collector_run_id', 'collectorRunId')
            if not run_id:
                source_messages.append(
                    f'教材 {_pick(scope, "textbook_name_snapshot", "textbookNameSnapshot", default="")} 缺少 collectorRunId'
                )
                continue
            _run, raw_rows = await _collector_rows(
                int(run_id),
                'question',
                str(_pick(scope, 'external_textbook_id', 'externalTextbookId', default='')) or None,
                catalog_external_id=query.catalog_id,
                question_type=query.question_type,
                keyword=query.keyword,
            )
            for raw in raw_rows:
                item = _normalise_question(raw)
                if item is not None:
                    item['externalTextbookId'] = item.get('externalTextbookId') or str(
                        _pick(scope, 'external_textbook_id', 'externalTextbookId', default='') or ''
                    )
                    # Attach catalog IDs for filtering.  Collector responses
                    # use either nested links or a direct catalog ID.
                    links = item.get('catalogs')
                    if isinstance(links, list) and links:
                        item['catalogIds'] = [
                            str(_pick(link, 'externalCatalogId', 'catalog_external_id', 'catalogId', default=''))
                            for link in links
                            if _pick(link, 'externalCatalogId', 'catalog_external_id', 'catalogId') is not None
                        ]
                    else:
                        chapter_id = _pick(item, 'chapterId')
                        item['catalogIds'] = [str(chapter_id)] if chapter_id else []
                    fetched.append(item)
        local_ids = [
            int(_pick(scope, 'local_textbook_id', 'localTextbookId'))
            for scope in scopes
            if _pick(scope, 'local_textbook_id', 'localTextbookId') is not None
        ]
        formal_rows = await cls._formal_questions(db, local_ids)
        current_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        for item in formal_rows:
            value = _formal_question_value(item)
            provider = str(value.get('sourceProvider') or '')
            external = str(value.get('externalQuestionId') or '')
            if provider and external:
                current_by_key[(provider, external)] = value
        rows: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for item in fetched:
            key = (str(item.get('sourceProvider') or ''), str(item.get('externalQuestionId') or ''))
            if key in seen:
                continue
            seen.add(key)
            formal = current_by_key.get(key)
            if formal is None:
                status = 'new'
                diff_fields: list[str] = []
            else:
                # The immutable collector hash is the authoritative question
                # comparison key.  Equal hashes are existing even when a
                # volatile source field changed; unequal hashes are changed.
                status = (
                    'existing'
                    if str(item.get('contentHash') or '') == str(formal.get('contentHash') or '')
                    else 'changed'
                )
                diff_fields = _question_compare_fields(item, formal) if status == 'changed' else []
            row = {
                **item,
                'comparisonStatus': status,
                'diffStatus': status,
                'diffFields': diff_fields,
                'changedFields': diff_fields,
                'fetched': item,
                'candidate': item,
                'current': formal,
                'externalId': item.get('externalQuestionId'),
            }
            rows.append(row)
        full_counts = Counter(item.get('comparisonStatus') for item in rows)
        question_types = sorted({str(item.get('questionType')) for item in rows if item.get('questionType')})
        if query.catalog_id:
            wanted = str(query.catalog_id)
            rows = [item for item in rows if wanted in {str(value) for value in item.get('catalogIds', [])}]
        if query.question_type:
            rows = [item for item in rows if str(item.get('questionType') or '') == query.question_type]
        if query.keyword:
            needle = query.keyword.lower()
            rows = [item for item in rows if needle in json.dumps(item, ensure_ascii=False).lower()]
        if query.comparison_status:
            wanted_status = 'existing' if query.comparison_status in {'unchanged', 'same'} else query.comparison_status
            rows = [item for item in rows if item.get('comparisonStatus') == wanted_status]
        total = len(rows)
        start = (query.page_num - 1) * query.page_size
        return {
            'sourceAvailable': bool(fetched or not source_messages),
            'sourceMessage': '；'.join(dict.fromkeys(source_messages)),
            'summary': {
                'total': len(seen),
                'newCount': full_counts.get('new', 0),
                'existingCount': full_counts.get('existing', 0),
                'changedCount': full_counts.get('changed', 0),
            },
            'rows': rows[start : start + query.page_size],
            'total': total,
            'page': {
                'pageNum': query.page_num,
                'pageSize': query.page_size,
                'total': total,
                'hasNext': start + query.page_size < total,
            },
            'questionTypes': [{'value': value, 'label': value} for value in question_types],
        }

    @classmethod
    async def question_detail_comparison(
        cls,
        db: AsyncSession,
        task_id: int,
        external_id: str,
        query: TaskComparisonQueryModel | None = None,
    ) -> dict[str, Any]:
        query = query or TaskComparisonQueryModel()
        if not _safe_external_id(external_id):
            raise ServiceException(message='题目外部 ID 格式不安全')
        _job, scopes = await cls._scope_selection(db, task_id, query)
        matches: list[tuple[dict[str, Any], Any]] = []
        for scope in scopes:
            run_id = _pick(scope, 'collector_run_id', 'collectorRunId')
            if not run_id:
                continue
            try:
                raw = await _collector_question_detail(
                    int(run_id),
                    external_id,
                    str(_pick(scope, 'external_textbook_id', 'externalTextbookId', default='')) or None,
                )
            except ServiceException:
                continue
            item = _normalise_question(raw)
            if item is not None:
                matches.append((item, scope))
        if not matches:
            raise ServiceException(message=f'本任务快照中不存在题目 {external_id}')
        if query.source_provider:
            matches = [item for item in matches if item[0].get('sourceProvider') == query.source_provider]
            if not matches:
                raise ServiceException(message=f'本任务快照中不存在来源为 {query.source_provider} 的题目 {external_id}')
        if len(matches) > 1:
            raise ServiceException(message='题目外部 ID 在本任务多个教材中不唯一，请指定教材范围或来源提供方')
        fetched, scope = matches[0]
        local_id = _pick(scope, 'local_textbook_id', 'localTextbookId')
        formal_values = await cls._formal_questions(db, [int(local_id)] if local_id is not None else [])
        formal = None
        wanted_key = (str(fetched.get('sourceProvider') or ''), str(fetched.get('externalQuestionId') or ''))
        for item in formal_values:
            candidate = _formal_question_value(item)
            if (
                str(candidate.get('sourceProvider') or ''),
                str(candidate.get('externalQuestionId') or ''),
            ) == wanted_key:
                formal = candidate
                break
        status = (
            'new'
            if formal is None
            else ('existing' if fetched.get('contentHash') == formal.get('contentHash') else 'changed')
        )
        diff_fields = _question_compare_fields(fetched, formal) if formal and status == 'changed' else []
        # Keep the names consumed by the browser comparison component while
        # retaining the full bounded collector fields for API clients. The
        # collector's solutionHtml remains one unclassified source block;
        # do not manufacture answerHtml/analysisHtml fallbacks here.
        fetched_view = {
            **fetched,
            'stemHtml': fetched.get('contentHtml'),
        }
        current_view = None
        if formal is not None:
            current_view = {
                **formal,
                'stemHtml': formal.get('contentHtml'),
                'answerHtml': formal.get('answerHtml'),
                'analysisHtml': formal.get('analysisHtml'),
            }
        return {
            'sourceProvider': fetched.get('sourceProvider'),
            'externalQuestionId': fetched.get('externalQuestionId'),
            'externalId': fetched.get('externalQuestionId'),
            'comparisonStatus': status,
            'diffStatus': status,
            'diffFields': diff_fields,
            'changedFields': diff_fields,
            'fetched': fetched_view,
            'candidate': fetched_view,
            'current': current_view,
            'scope': _scope_payload(scope),
        }

    # Friendly aliases used by callers that mirror endpoint names.
    create_textbook_task = create_textbook
    list_textbook_tasks = list_textbook
    get_textbook_task = textbook_detail
    get_textbook_task_comparison = textbook_comparison
    cancel_textbook_task = cancel_textbook
    delete_textbook_task = delete_textbook
    retry_textbook_task = retry_textbook
    question_task_options = question_options
    create_question_task = create_question
    list_question_tasks = list_question
    get_question_task = question_detail
    get_question_task_catalog_comparison = catalog_comparison
    get_question_task_question_comparison = question_comparison
    get_question_task_question_detail = question_detail_comparison
    cancel_question_task = cancel_question
    delete_question_task = delete_question
    retry_question_task = retry_question
    resume_question_task = resume_question


# Short public name for integrations.
TaskService = SyncTaskService

__all__ = ['SyncTaskService', 'TaskService', 'task_payload']
