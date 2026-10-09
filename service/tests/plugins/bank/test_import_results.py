"""Journal pagination stays bounded and preserves the selected run/watermark."""

import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import event

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbQuestionImport, QbQuestionImportBatch, QbSyncJobScope
from plugins.bank.service.import_results import _encode, batch_results, issue_results, list_import_history
from plugins.bank.service.incremental_import import current_task_import_status, request_incremental_import
from plugins.bank.service.question_apply_service import _empty_stats
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


async def journals(db, sizes):
    state = await request_incremental_import(db, 28)
    row = await db.get(QbQuestionImport, state['importId'])
    start = 0
    for batch, (count, quarantined) in enumerate(sizes, 1):
        db.add(QbQuestionImportBatch(
            import_id=row.import_id, batch_no=batch, start_cursor=start, next_cursor=start + count,
            batch_hash='b' * 64, accepted_count=count - quarantined, quarantined_count=quarantined,
            stats_json=_empty_stats(), issues_json=[
                {'questionId': f'bad-{batch}-{index}', 'reason': f'题干检查失败 {index}'}
                for index in range(quarantined)
            ], create_time=datetime.now(),
        ))
        start += count
    row.question_count = row.cursor = start
    row.batch_no = len(sizes)
    row.quarantined_count = sum(bad for _, bad in sizes)
    row.accepted_count = start - row.quarantined_count
    row.status = 'partial'
    await db.commit()
    return row.import_id


@pytest.mark.asyncio
async def test_batch_pages_freeze_the_watermark_and_return_public_fields(import_db):
    db = import_db
    import_id = await journals(db, [(2, 0), (3, 1), (1, 1)])
    first = await batch_results(db, 28, import_id, page_size=2)
    assert [item['batchNo'] for item in first['items']] == [1, 2]
    assert first['page']['total'] == 3 and first['page']['hasNext']
    row = await db.get(QbQuestionImport, import_id)
    db.add(QbQuestionImportBatch(import_id=import_id, batch_no=4, start_cursor=6, next_cursor=7,
        batch_hash='c' * 64, accepted_count=1, quarantined_count=0, stats_json=_empty_stats(),
        issues_json=[], create_time=datetime.now()))
    row.batch_no = 4
    row.question_count = row.cursor = 7
    row.accepted_count += 1
    await db.commit()
    second = await batch_results(db, 28, import_id, cursor=first['page']['nextCursor'], page_size=2)
    assert [item['batchNo'] for item in second['items']] == [3]
    assert second['page']['total'] == 3 and not second['page']['hasNext']
    back = await batch_results(db, 28, import_id, cursor=first['page']['cursor'], page_size=2)
    assert back['items'] == first['items'] and back['page']['total'] == 3
    fresh = await batch_results(db, 28, import_id, page_size=5)
    assert fresh['page']['total'] == 4 and len(fresh['items']) == 4
    public = json.dumps(fresh, default=str)
    assert all(key not in public for key in ('workerToken', 'qualityHash', 'identityHash', 'batch_hash', 'issues_json'))


@pytest.mark.asyncio
async def test_issues_cross_batches_including_large_batch_without_duplicates(import_db):
    db = import_db
    import_id = await journals(db, [(1, 0), (100, 100), (2, 0), (5, 5)])
    seen = []
    cursor = None
    for _ in range(20):
        page = await issue_results(db, 28, import_id, cursor=cursor, page_size=20)
        seen.extend(item['resultKey'] for item in page['items'])
        assert page['page']['total'] == 105 and len(page['items']) <= 20
        if not page['page']['hasNext']:
            break
        assert page['page']['nextCursor'] != cursor
        cursor = page['page']['nextCursor']
    else:
        raise AssertionError('issue pagination did not terminate')
    assert len(seen) == len(set(seen)) == 105


@pytest.mark.asyncio
async def test_issue_pages_skip_clean_batches_and_obey_a_scan_budget(import_db):
    db = import_db
    import_id = await journals(db, [(1, 0)] * 200 + [(1, 1)] * 20)
    first = await issue_results(db, 28, import_id, page_size=50)
    assert len(first['items']) == 8 and first['items'][0]['batchNo'] == 201
    assert first['page']['hasNext'] and first['page']['total'] == 20
    second = await issue_results(db, 28, import_id, cursor=first['page']['nextCursor'], page_size=50)
    third = await issue_results(db, 28, import_id, cursor=second['page']['nextCursor'], page_size=50)
    assert len(second['items']) == 8 and len(third['items']) == 4 and not third['page']['hasNext']


@pytest.mark.asyncio
async def test_historical_run_is_readable_but_cannot_masquerade_as_current(import_db):
    db = import_db
    old = await journals(db, [(1, 1)])
    scope = await db.get(QbSyncJobScope, 30)
    scope.collector_run_id = 99
    await db.commit()
    newer = await request_incremental_import(db, 28)
    history = await list_import_history(db, 28, page_size=1)
    assert history['hasNext'] and history['items'][0]['importId'] == newer['importId']
    assert history['items'][0]['currentBinding'] is True
    previous = await list_import_history(db, 28, before_id=history['nextBeforeId'], page_size=1)
    assert previous['items'][0]['importId'] == old and previous['items'][0]['currentBinding'] is False
    result = await issue_results(db, 28, old)
    assert result['items'][0]['questionId'] == 'bad-1-0' and not result['import']['currentBinding']


@pytest.mark.asyncio
@pytest.mark.parametrize('changed_field', ['snapshot_locked_at', 'snapshot_complete', 'local_textbook_id'])
async def test_binding_drift_does_not_present_old_results_as_current(import_db, changed_field):
    db = import_db
    import_id = await journals(db, [(1, 1)])
    scope = await db.get(QbSyncJobScope, 30)
    changed = {'snapshot_locked_at': scope.snapshot_locked_at + timedelta(seconds=1),
               'snapshot_complete': 1, 'local_textbook_id': 2}
    setattr(scope, changed_field, changed[changed_field])
    await db.commit()
    assert await current_task_import_status(db, 28, [scope]) is None
    page = await issue_results(db, 28, import_id)
    assert not page['import']['currentBinding'] and page['items'][0]['questionId'] == 'bad-1-0'


@pytest.mark.asyncio
async def test_membership_cursor_kind_and_watermark_are_validated(import_db):
    db = import_db
    import_id = await journals(db, [(1, 1)])
    with pytest.raises(ServiceException, match='任务不存在'):
        await issue_results(db, 29, import_id)
    with pytest.raises(ServiceException, match='入库记录'):
        await batch_results(db, 28, import_id + 10)
    first = await batch_results(db, 28, import_id)
    with pytest.raises(ServiceException, match='分页位置'):
        await issue_results(db, 28, import_id, cursor=first['page']['cursor'])
    invalid = [None, True, -1, 0, 51]
    for size in invalid:
        with pytest.raises(ServiceException, match='每页数量'):
            await batch_results(db, 28, import_id, page_size=size)
    payload = {'v': 1, 'kind': 'issue', 'importId': import_id, 'watermark': 1, 'batch': 1, 'offset': 0}
    for mutation in (
        {'importId': import_id + 1}, {'watermark': 99}, {'offset': True}, {'extra': 'file:///tmp'}, {'offset': 99},
    ):
        with pytest.raises(ServiceException, match='分页位置'):
            await issue_results(db, 28, import_id, cursor=_encode({**payload, **mutation}))
    for cursor in ('bad', 'a' * 513, _encode({'v': 1})):
        with pytest.raises(ServiceException, match='分页位置'):
            await batch_results(db, 28, import_id, cursor=cursor)


@pytest.mark.asyncio
async def test_corrupt_journal_is_reported_not_presented_as_no_issues(import_db):
    db = import_db
    import_id = await journals(db, [(1, 1)])
    batch = await db.get(QbQuestionImportBatch, (import_id, 1))
    batch.issues_json = []
    await db.commit()
    with pytest.raises(ServiceException, match='记录不一致'):
        await issue_results(db, 28, import_id)


@pytest.mark.asyncio
async def test_batch_endpoint_does_not_select_issue_arrays_and_history_avoids_n_plus_one(import_db):
    db = import_db
    import_id = await journals(db, [(100, 100)] * 30)
    queries = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        queries.append(statement.lower())

    event.listen(db.bind.sync_engine, 'before_cursor_execute', record)
    try:
        page = await batch_results(db, 28, import_id, page_size=1)
        assert len(page['items']) == 1
        assert not any('issues_json' in statement for statement in queries)
        queries.clear()
        await list_import_history(db, 28)
        assert len(queries) == 3
    finally:
        event.remove(db.bind.sync_engine, 'before_cursor_execute', record)


@pytest.mark.asyncio
async def test_empty_and_clean_results_are_explicitly_empty(import_db):
    db = import_db
    empty = await request_incremental_import(db, 28)
    for fetch in (batch_results, issue_results):
        page = await fetch(db, 28, empty['importId'])
        assert page['items'] == [] and not page['page']['hasNext'] and page['page']['total'] == 0
