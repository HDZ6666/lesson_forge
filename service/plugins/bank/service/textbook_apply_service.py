"""Apply immutable metadata-task snapshots to the formal textbook tables.

This flow is intentionally independent from the qbpkg/publisher workflow. It
only owns the two metadata tables (versions and textbooks), while catalogs,
questions, and their relations are left untouched.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from exceptions.exception import ServiceException
from plugins.bank.dao.textbook_apply_dao import TextbookApplyDao
from plugins.bank.entity.do.bank_do import (
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
    QbTextbookApplyHistory,
    QbTextbookApplyState,
    QbTextbookVersion,
)
from plugins.bank.service.collector_client import CollectorClient

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


PROVIDER = 'zujuan'
MAX_METADATA_VERSIONS = 1000
MAX_METADATA_TEXTBOOKS = 5000
MYSQL_TABLE_NOT_FOUND = 1146
_SAFE_EXTERNAL_ID = __import__('re').compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z')


def _pick(value: Mapping[str, Any] | object, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(value, Mapping):
            if name in value:
                return value[name]
        elif hasattr(value, name):
            return getattr(value, name)
    return default


def _safe_external_id(value: Any) -> bool:
    return bool(_SAFE_EXTERNAL_ID.fullmatch(str(value or '').strip()))


def _try_parse_datetime(value: str, fmt: str) -> datetime | None:
    try:
        return datetime.strptime(value, fmt)
    except ValueError:
        return None


def _coerce_datetime(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    normalized = text.replace('Z', '+00:00')
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except ValueError:
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S'):
            parsed = _try_parse_datetime(text, fmt)
            if parsed is not None:
                return parsed
    return None


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(item) for item in value]
    return str(value)


def _canonical_hash(snapshot: Mapping[str, Any]) -> str:
    encoded = json.dumps(_jsonable(snapshot), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def _snapshot_lock_value(run: Mapping[str, Any] | object) -> Any:
    return _pick(run, 'snapshot_locked_at', 'snapshotLockedAt', 'locked')


def _is_missing_apply_state_table(exc: SQLAlchemyError) -> bool:
    original = getattr(exc, 'orig', None)
    arguments = getattr(original, 'args', ())
    if arguments and arguments[0] == MYSQL_TABLE_NOT_FOUND:
        return True
    message = str(original or exc).lower()
    return 'qb_textbook_apply_state' in message and any(
        marker in message for marker in ('does not exist', "doesn't exist", 'no such table')
    )


async def _read_snapshot(metadata_run_id: int) -> dict[str, Any]:
    payload = await asyncio.to_thread(CollectorClient().metadata_snapshot, metadata_run_id)
    if not isinstance(payload, Mapping) or payload.get('available') is not True:
        raise ServiceException(message=str((payload or {}).get('message') or 'collector 没有可用的教材快照'))
    if payload.get('immutable') is not True:
        raise ServiceException(message='collector 元数据快照未锁定，不能应用到正式表')
    versions = payload.get('versions')
    textbooks = payload.get('textbooks')
    run = payload.get('run')
    if not isinstance(versions, list) or not isinstance(textbooks, list) or not isinstance(run, Mapping):
        raise ServiceException(message='collector 元数据快照结构不完整')
    remote_run_id = _pick(run, 'id', 'runId', 'collectorRunId')
    try:
        if isinstance(remote_run_id, bool) or int(remote_run_id) != int(metadata_run_id):
            raise ServiceException(message='collector 元数据运行 ID 不一致')
    except (TypeError, ValueError) as exc:
        raise ServiceException(message='collector 元数据运行 ID 无效') from exc
    if _snapshot_lock_value(run) in (None, '', 0, '0', False):
        raise ServiceException(message='collector 元数据快照缺少锁定标记，不能应用到正式表')
    expected_versions = _pick(run, 'version_count', 'versionCount')
    expected_textbooks = _pick(run, 'textbook_count', 'textbookCount')
    try:
        expected_versions = int(expected_versions)
        expected_textbooks = int(expected_textbooks)
    except (TypeError, ValueError) as exc:
        raise ServiceException(message='collector 元数据快照缺少有效的版本或教材计数') from exc
    if expected_versions <= 0 or expected_textbooks <= 0:
        raise ServiceException(message='collector 元数据快照的版本或教材计数为空')
    if len(versions) != expected_versions or len(textbooks) != expected_textbooks:
        raise ServiceException(
            message=(
                f'collector 元数据快照不完整：版本 {len(versions)}/{expected_versions}，'
                f'教材 {len(textbooks)}/{expected_textbooks}'
            )
        )
    return {'run': dict(run), 'versions': versions, 'textbooks': textbooks, 'immutable': True}


def _normalise_snapshot(raw: Mapping[str, Any], task_id: int, metadata_run_id: int) -> dict[str, Any]:
    run = raw.get('run') or {}
    run_provider = str(_pick(run, 'provider', default='') or '').strip()
    if run_provider != PROVIDER:
        raise ServiceException(message='元数据运行来源与教材任务不一致')
    versions: list[dict[str, Any]] = []
    textbooks: list[dict[str, Any]] = []
    version_ids: set[str] = set()
    textbook_ids: set[str] = set()
    for row in raw.get('versions') or []:
        provider = str(_pick(row, 'provider', 'source_provider', 'sourceProvider', default='') or '').strip()
        external_id = str(_pick(row, 'external_version_id', 'externalVersionId', 'externalId', default='') or '').strip()
        name = str(_pick(row, 'version_name', 'versionName', default='') or '').strip()
        if provider != PROVIDER or not _safe_external_id(external_id) or external_id in version_ids or not name:
            raise ServiceException(message=f'任务 {task_id} 的元数据包含无效或重复版本 ID：{external_id or "缺少 ID"}')
        version_ids.add(external_id)
        versions.append(
            {
                'source_provider': provider,
                'external_version_id': external_id,
                'version_name': name,
                'source_url': _pick(row, 'source_url', 'sourceUrl'),
                'is_new': _pick(row, 'is_new', 'isNew'),
                'sort_order': int(_pick(row, 'sort_order', 'sortOrder', default=0) or 0),
                'status': '0',
                'last_seen_at': _coerce_datetime(_pick(row, 'captured_at', 'capturedAt', 'last_seen_at', 'lastSeenAt')),
            }
        )
    for row in raw.get('textbooks') or []:
        provider = str(_pick(row, 'provider', 'source_provider', 'sourceProvider', default='') or '').strip()
        external_id = str(_pick(row, 'external_textbook_id', 'externalTextbookId', 'externalId', default='') or '').strip()
        version_external_id = str(_pick(row, 'version_external_id', 'versionExternalId', default='') or '').strip()
        name = str(_pick(row, 'textbook_name', 'textbookName', default='') or '').strip()
        if provider != PROVIDER or not _safe_external_id(external_id) or external_id in textbook_ids or not name:
            raise ServiceException(message=f'任务 {task_id} 的元数据包含无效或重复教材 ID：{external_id or "缺少 ID"}')
        if not _safe_external_id(version_external_id) or version_external_id not in version_ids:
            raise ServiceException(message=f'教材 {external_id} 引用了不在同一快照中的版本 {version_external_id or "缺少 ID"}')
        textbook_ids.add(external_id)
        textbooks.append(
            {
                'source_provider': provider,
                'external_textbook_id': external_id,
                'version_external_id': version_external_id,
                'textbook_name': name,
                'grade': _pick(row, 'grade'),
                'volume': _pick(row, 'volume'),
                'source_url': _pick(row, 'source_url', 'sourceUrl'),
                'sort_order': int(_pick(row, 'sort_order', 'sortOrder', default=0) or 0),
                'status': '0',
                'last_seen_at': _coerce_datetime(_pick(row, 'captured_at', 'capturedAt', 'last_seen_at', 'lastSeenAt')),
            }
        )
    if not versions or not textbooks:
        raise ServiceException(message=f'任务 {task_id} 的教材快照为空，不能应用')
    versions.sort(key=lambda item: (item['sort_order'], item['external_version_id']))
    textbooks.sort(key=lambda item: (item['sort_order'], item['external_textbook_id']))
    # The digest represents only fields written to the two formal tables.
    # Task/run identity is audit metadata and must not create a false data
    # change when two runs contain the same normalized business rows.
    business_snapshot = {'provider': PROVIDER, 'versions': versions, 'textbooks': textbooks}
    return {
        'run': run,
        'versions': versions,
        'textbooks': textbooks,
        'version_ids': version_ids,
        'textbook_ids': textbook_ids,
        'snapshot_hash': _canonical_hash(business_snapshot),
        'business_snapshot': business_snapshot,
    }


def _task_value(row: object, *names: str, default: Any = None) -> Any:
    return _pick(row, *names, default=default)


async def _load_task_and_scopes(db: AsyncSession, task_id: int) -> tuple[QbSyncJob, list[QbSyncJobScope]]:
    result = await db.execute(
        select(QbSyncJob).where(QbSyncJob.run_id == int(task_id), QbSyncJob.task_module == 'textbook')
    )
    scalars = getattr(result, 'scalars', None)
    task = next(iter(scalars().all()), None) if callable(scalars) else None
    if task is None:
        raise ServiceException(message='同步教材任务不存在')
    scope_result = await db.execute(
        select(QbSyncJobScope).where(QbSyncJobScope.run_id == int(task_id)).order_by(QbSyncJobScope.scope_id)
    )
    scope_scalars = getattr(scope_result, 'scalars', None)
    scopes = list(scope_scalars().all()) if callable(scope_scalars) else []
    return task, scopes


async def _validate_task_snapshot(db: AsyncSession, task: QbSyncJob, scopes: list[QbSyncJobScope]) -> dict[str, Any]:
    task_id = int(_task_value(task, 'run_id', default=0) or 0)
    status = str(_task_value(task, 'status', default='') or '').strip().lower()
    if status != 'completed':
        raise ServiceException(message='只有已成功完成的同步教材任务才能应用正式表')
    metadata_run_id = _task_value(task, 'metadata_run_id')
    if not metadata_run_id or int(metadata_run_id) <= 0:
        raise ServiceException(message='同步教材任务缺少 metadataRunId，不能应用正式表')
    metadata_run_id = int(metadata_run_id)
    if not scopes:
        raise ServiceException(message='同步教材任务缺少绑定的教材范围，不能应用正式表')
    expected_scope_ids: set[str] = set()
    for scope in scopes:
        scope_status = str(_task_value(scope, 'status', default='') or '').lower()
        scope_provider = str(_task_value(scope, 'source_provider', default='') or '').strip()
        external_id = str(_task_value(scope, 'external_textbook_id', default='') or '').strip()
        scope_run_id = _task_value(scope, 'metadata_run_id')
        if scope_status != 'completed' or scope_provider != PROVIDER or not _safe_external_id(external_id):
            raise ServiceException(message=f'任务 {task_id} 存在未成功绑定的教材范围，不能应用')
        if scope_run_id is None or int(scope_run_id) != metadata_run_id:
            raise ServiceException(message=f'任务 {task_id} 的教材范围未全部绑定同一个 metadataRunId')
        if external_id in expected_scope_ids:
            raise ServiceException(message=f'任务 {task_id} 的教材范围包含重复来源 ID：{external_id}')
        expected_scope_ids.add(external_id)
    snapshot = await _read_snapshot(metadata_run_id)
    normalized = _normalise_snapshot(snapshot, task_id, metadata_run_id)
    if expected_scope_ids != normalized['textbook_ids']:
        raise ServiceException(
            message=(
                f'任务 {task_id} 的教材范围不完整：绑定 {len(expected_scope_ids)} 本，'
                f'元数据快照包含 {len(normalized["textbook_ids"])} 本'
            )
        )
    run = normalized['run']
    run_status = str(_pick(run, 'status', default='') or '').lower()
    if run_status not in {'success', 'completed'}:
        raise ServiceException(message=f'元数据运行 {metadata_run_id} 未成功完成')
    if _snapshot_lock_value(run) in (None, '', 0, '0', False):
        raise ServiceException(message=f'元数据运行 {metadata_run_id} 尚未锁定')
    return normalized


def _same_value(left: Any, right: Any) -> bool:
    if isinstance(left, datetime) or isinstance(right, datetime):
        left_dt, right_dt = _coerce_datetime(left), _coerce_datetime(right)
        return left_dt == right_dt
    return _jsonable(left) == _jsonable(right)


def _update_values(row: object, values: Mapping[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {key: values.get(key) for key in fields if not _same_value(getattr(row, key, None), values.get(key))}


class TextbookApplyService:
    """Apply and inspect provider-scoped formal textbook snapshots."""

    @staticmethod
    async def _state(db: AsyncSession, *, for_update: bool = False) -> QbTextbookApplyState | None:
        try:
            return await TextbookApplyDao.get_state(db, PROVIDER, for_update=for_update)
        except SQLAlchemyError as exc:
            # A pre-008 installation should remain readable until migrations
            # run; the write endpoint still fails clearly below.
            if _is_missing_apply_state_table(exc):
                return None
            raise

    @classmethod
    async def task_apply_status(cls, db: AsyncSession, task: object, scopes: list[object]) -> dict[str, Any]:
        state = await cls._state(db)
        current_task_id = _task_value(state, 'current_task_id') if state else None
        current_metadata_run_id = _task_value(state, 'current_metadata_run_id') if state else None
        applied_at = _task_value(state, 'applied_at') if state else None
        task_id = _task_value(task, 'run_id', 'task_id')
        status = str(_task_value(task, 'status', default='') or '').lower()
        eligible = False
        reason = None
        if status != 'completed':
            reason = '任务未成功完成'
        else:
            try:
                await _validate_task_snapshot(db, task, scopes)
                eligible = True
            except Exception as exc:
                reason = str(getattr(exc, 'message', None) or exc)
        is_current = bool(eligible and current_task_id is not None and int(current_task_id) == int(task_id))
        if is_current:
            suggested_action = 'alreadyApplied'
        elif current_task_id is None:
            suggested_action = 'apply'
        elif task_id is not None and int(task_id) < int(current_task_id):
            suggested_action = 'rollback'
        else:
            suggested_action = 'restore'
        return {
            'eligible': eligible,
            'isCurrent': is_current,
            'currentTaskId': int(current_task_id) if current_task_id is not None else None,
            'currentMetadataRunId': int(current_metadata_run_id) if current_metadata_run_id is not None else None,
            'currentSnapshotHash': _task_value(state, 'snapshot_hash') if state else None,
            'appliedAt': applied_at,
            'suggestedAction': suggested_action,
            'eligibilityMessage': reason,
        }

    @classmethod
    async def ensure_task_not_current(cls, db: AsyncSession, task_id: int) -> None:
        state = await cls._state(db, for_update=True)
        if state and state.current_task_id is not None and int(state.current_task_id) == int(task_id):
            raise ServiceException(message='任务当前对应正式教材版本，不能删除；请先切换正式版本后再删除')

    @classmethod
    async def apply(
        cls,
        db: AsyncSession,
        task_id: int,
        expected_current_task_id: int | None = None,
        operator: str | None = None,
    ) -> dict[str, Any]:
        try:
            state = await TextbookApplyDao.get_state(db, PROVIDER, for_update=True)
            if state is None:
                state = await TextbookApplyDao.add_state(db, PROVIDER)
                # A newly inserted row is owned by this transaction and is
                # therefore already serialized for the first provider write.
            current_task_id = int(state.current_task_id) if state.current_task_id is not None else None
            if expected_current_task_id != current_task_id:
                raise ServiceException(
                    message=(
                        f'正式教材版本已变化（当前为任务 {current_task_id or "无"}），'
                        '请刷新任务详情后重新确认'
                    )
                )
            # The provider lock also serializes task deletion.  Load the
            # task only after acquiring it so a non-current task cannot be
            # deleted while this request waits for the lock.
            task, scopes = await _load_task_and_scopes(db, task_id)
            normalized = await _validate_task_snapshot(db, task, scopes)
            metadata_run_id = int(_task_value(task, 'metadata_run_id'))
            snapshot_hash = str(normalized['snapshot_hash'])
            if (
                current_task_id == int(task_id)
                and int(state.current_metadata_run_id or 0) == metadata_run_id
                and str(state.snapshot_hash or '') == snapshot_hash
            ):
                result = cls._response(
                    action='apply',
                    already_applied=True,
                    task_id=task_id,
                    previous_task_id=current_task_id,
                    metadata_run_id=metadata_run_id,
                    snapshot_hash=snapshot_hash,
                    stats=cls._empty_stats(),
                )
                await db.rollback()
                return result

            stats = await cls._upsert_formal(db, normalized)
            action = 'apply' if current_task_id is None else ('rollback' if int(task_id) < current_task_id else 'restore')
            now = datetime.now()
            previous_metadata_run_id = int(state.current_metadata_run_id) if state.current_metadata_run_id else None
            state.current_task_id = int(task_id)
            state.current_metadata_run_id = metadata_run_id
            state.snapshot_hash = snapshot_hash
            state.applied_by = operator
            state.applied_at = now
            state.update_time = now
            await TextbookApplyDao.add_history(
                db,
                QbTextbookApplyHistory(
                    source_provider=PROVIDER,
                    task_id=int(task_id),
                    metadata_run_id=metadata_run_id,
                    snapshot_hash=snapshot_hash,
                    action=action,
                    previous_task_id=current_task_id,
                    previous_metadata_run_id=previous_metadata_run_id,
                    change_stats_json=stats,
                    applied_by=operator,
                    applied_at=now,
                    create_time=now,
                    update_time=now,
                ),
            )
            await db.commit()
            return cls._response(
                action=action,
                already_applied=False,
                task_id=task_id,
                previous_task_id=current_task_id,
                metadata_run_id=metadata_run_id,
                snapshot_hash=snapshot_hash,
                stats=stats,
            )
        except Exception:
            await db.rollback()
            raise

    @staticmethod
    def _empty_stats() -> dict[str, Any]:
        return {
            'versions': {'inserted': 0, 'updated': 0, 'unchanged': 0, 'disabled': 0},
            'textbooks': {'inserted': 0, 'updated': 0, 'unchanged': 0, 'disabled': 0},
        }

    @classmethod
    async def _upsert_formal(cls, db: AsyncSession, snapshot: Mapping[str, Any]) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
        now = datetime.now()
        stats = cls._empty_stats()
        version_rows_result = await db.execute(select(QbTextbookVersion).where(QbTextbookVersion.source_provider == PROVIDER))
        textbook_rows_result = await db.execute(select(QbTextbook).where(QbTextbook.source_provider == PROVIDER))
        scalar_versions = getattr(version_rows_result, 'scalars', None)
        scalar_textbooks = getattr(textbook_rows_result, 'scalars', None)
        versions = list(scalar_versions().all()) if callable(scalar_versions) else []
        textbooks = list(scalar_textbooks().all()) if callable(scalar_textbooks) else []
        versions_by_id = {str(row.external_version_id): row for row in versions if row.external_version_id}
        textbooks_by_id = {str(row.external_textbook_id): row for row in textbooks if row.external_textbook_id}
        fields = ('version_name', 'source_url', 'is_new', 'sort_order', 'status', 'last_seen_at')
        version_map: dict[str, int] = {}
        target_version_ids = set(snapshot['version_ids'])
        for values in snapshot['versions']:
            external_id = values['external_version_id']
            row = versions_by_id.get(external_id)
            if row is None:
                row = QbTextbookVersion(
                    source_provider=PROVIDER,
                    external_version_id=external_id,
                    create_time=now,
                    update_time=now,
                )
                for field in fields:
                    setattr(row, field, values[field])
                db.add(row)
                await db.flush()
                versions_by_id[external_id] = row
                stats['versions']['inserted'] += 1
            else:
                changed = _update_values(row, values, fields)
                if changed:
                    for field, value in changed.items():
                        setattr(row, field, value)
                    row.update_time = now
                    stats['versions']['updated'] += 1
                else:
                    stats['versions']['unchanged'] += 1
            version_map[external_id] = int(row.version_id)
        for external_id, row in versions_by_id.items():
            if external_id not in target_version_ids and str(row.status or '0') != '1':
                row.status = '1'
                row.update_time = now
                stats['versions']['disabled'] += 1

        target_textbook_ids = set(snapshot['textbook_ids'])
        textbook_fields = ('version_id', 'textbook_name', 'grade', 'volume', 'source_url', 'sort_order', 'status', 'last_seen_at')
        for values in snapshot['textbooks']:
            external_id = values['external_textbook_id']
            row = textbooks_by_id.get(external_id)
            formal_values = {**values, 'version_id': version_map[values['version_external_id']]}
            if row is None:
                row = QbTextbook(
                    source_provider=PROVIDER,
                    external_textbook_id=external_id,
                    create_time=now,
                    update_time=now,
                )
                for field in textbook_fields:
                    setattr(row, field, formal_values[field])
                db.add(row)
                await db.flush()
                textbooks_by_id[external_id] = row
                stats['textbooks']['inserted'] += 1
            else:
                changed = _update_values(row, formal_values, textbook_fields)
                if changed:
                    for field, value in changed.items():
                        setattr(row, field, value)
                    row.update_time = now
                    stats['textbooks']['updated'] += 1
                else:
                    stats['textbooks']['unchanged'] += 1
        for external_id, row in textbooks_by_id.items():
            if external_id not in target_textbook_ids and str(row.status or '0') != '1':
                row.status = '1'
                row.update_time = now
                stats['textbooks']['disabled'] += 1
        await db.flush()
        return stats

    @staticmethod
    def _response(
        *,
        action: str,
        already_applied: bool,
        task_id: int,
        previous_task_id: int | None,
        metadata_run_id: int,
        snapshot_hash: str,
        stats: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            'action': action,
            'alreadyApplied': already_applied,
            'targetTaskId': int(task_id),
            'previousTaskId': previous_task_id,
            'metadataRunId': metadata_run_id,
            'snapshotHash': snapshot_hash,
            'versions': stats['versions'],
            'textbooks': stats['textbooks'],
            'stats': stats,
        }
