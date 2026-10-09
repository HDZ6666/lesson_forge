"""Opt-in 49,865-question MySQL pipeline check with a mid-batch write fault.

Uses the guarded scratch schema and generated pages, never a real source.
Run with both LESSON_REFACTOR_MYSQL_MERGE_CHECK=1 and
LESSON_REFACTOR_SCALE_CHECK=1 through scripts/refactor_env.py.
"""

import copy
import os
import time

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from plugins.bank.dao.bank_dao import BankDao
from plugins.bank.entity.do.bank_do import QbQuestion, QbQuestionCatalog, QbQuestionImport, QbQuestionImportBatch
from plugins.bank.entity.vo.bank_vo import QuestionPageQueryModel
from plugins.bank.service import incremental_import_worker as worker
from plugins.bank.service.book_coverage import book_coverage
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.coverage_queries import catalog_coverage
from plugins.bank.service.import_results import batch_results, issue_results
from plugins.bank.service.incremental_import import request_incremental_import
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db

pytestmark = pytest.mark.skipif(
    os.environ.get('LESSON_REFACTOR_MYSQL_MERGE_CHECK') != '1'
    or os.environ.get('LESSON_REFACTOR_SCALE_CHECK') != '1',
    reason='requires explicitly enabled scale check against guarded local MySQL scratch schema',
)

TOTAL = 49_865
BAD = {0, 25_001, TOTAL - 1}
CATALOGS = ['scale-root', 'scale-leaf-1', 'scale-leaf-2']


def generated_client(monkeypatch):
    client = CollectorClient()
    counts = {'catalogs': 3, 'questions': TOTAL, 'questionCatalogs': TOTAL * 3, 'tags': 0, 'assets': 0}
    summary = {
        'available': True, 'immutable': True, 'snapshotComplete': False,
        'run': {'id': 27, 'provider': 'zujuan', 'status': 'failed', 'errorCount': 1,
                'textbookExternalId': 'tb1', 'finishedAt': '2026-10-01T01:00:00Z',
                'snapshotLockedAt': '2026-10-01T01:00:00Z', 'snapshotComplete': False,
                'scope': {'textbookId': 'tb1', 'sourceNamespace': 'zujuan:junior:math'}},
        'counts': {'catalogItemCount': 3, 'questionItemCount': TOTAL, 'questionCatalogCount': TOTAL * 3,
                   'questionTagCount': 0, 'questionAssetCount': 0},
    }
    common = {'provider': 'zujuan', 'textbook_external_id': 'tb1'}
    page_calls = []

    def item(collection, index):
        if collection == 'catalogs':
            return {**common, 'catalog_external_id': CATALOGS[index], 'name': CATALOGS[index],
                    'parent_external_id': None if index == 0 else CATALOGS[0]}
        if collection == 'questions':
            return {**common, 'question_external_id': f'scale-{index}', 'question_type': '单选题',
                    'content_html': '' if index in BAD else f'<p>计算 {index} + 1。</p>',
                    'detail_fetched': 1, 'captured_at': '2026-10-01T00:00:00Z'}
        return {**common, 'question_external_id': f'scale-{index // 3}',
                'catalog_external_id': CATALOGS[index % 3]}

    def request(_method, route, *, query):
        if route.endswith('/snapshot-summary'):
            return copy.deepcopy(summary)
        collection, cursor = query['collection'], query['cursor']
        end = min(cursor + query['pageSize'], counts[collection])
        # Only a page exists in memory; the fixture does not construct 50,000 rows.
        items = [item(collection, index) for index in range(cursor, end)]
        page_calls.append((collection, cursor, len(items)))
        return {**copy.deepcopy(summary), 'collection': collection, 'cursor': cursor,
                'items': items, 'total': counts[collection],
                'nextCursor': end if end < counts[collection] else None}

    monkeypatch.setattr(client, '_request', request)
    return client, page_calls


@pytest.mark.asyncio
async def test_large_partial_import_rolls_back_the_faulted_batch_and_resumes(import_db, monkeypatch, tmp_path):
    from plugins.bank.entity.do.bank_do import QbSyncJobScope

    db = import_db
    assert db.bind.dialect.name == 'mysql'
    scope = await db.get(QbSyncJobScope, 30)
    scope.question_count = TOTAL
    scope.catalog_count = 3
    scope.question_catalog_count = TOTAL * 3
    await db.commit()
    queued = await request_incremental_import(db, 28)
    client, page_calls = generated_client(monkeypatch)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    real_submit = worker.submit_incremental_import_batch
    widths, committed_ms = [], []
    injected = False

    def fail_journal(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lower().startswith('insert into qb_question_import_batch'):
            raise RuntimeError('scale check: interrupted journal insert')

    async def submit(session, ticket, verdicts, *, expected_cursor):
        nonlocal injected
        widths.append(len(verdicts))
        fail = expected_cursor == 25_000 and not injected
        if fail:
            injected = True
            event.listen(session.bind.sync_engine, 'before_cursor_execute', fail_journal)
        started = time.perf_counter()
        try:
            result = await real_submit(session, ticket, verdicts, expected_cursor=expected_cursor)
            committed_ms.append((time.perf_counter() - started) * 1000)
            if expected_cursor % 5_000 == 0 or result['incrementalImport']['processedCount'] == TOTAL:
                print(f"committed cursor={result['incrementalImport']['processedCount']}", flush=True)
            return result
        finally:
            if fail:
                event.remove(session.bind.sync_engine, 'before_cursor_execute', fail_journal)

    monkeypatch.setattr(worker, 'submit_incremental_import_batch', submit)
    started = time.perf_counter()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.get(QbQuestionImport, queued['importId'], populate_existing=True)
    assert injected and (row.status, row.cursor, row.batch_no) == ('failed', 25_000, 250)
    count = select(func.count()).select_from(QbQuestion).where(QbQuestion.external_question_id.like('scale-%'))
    assert await db.scalar(count) == 24_999
    faulted_question = select(QbQuestion.question_id).where(QbQuestion.external_question_id == 'scale-25000')
    assert await db.scalar(faulted_question) is None
    pages_before_retry = len(page_calls)
    await db.rollback()
    retry = await request_incremental_import(db, 28)
    assert retry['importId'] == queued['importId'] and retry['processedCount'] == 25_000
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.get(QbQuestionImport, queued['importId'], populate_existing=True)
    assert (row.status, row.cursor, row.batch_no, row.accepted_count, row.quarantined_count) == (
        'partial', TOTAL, 499, TOTAL - len(BAD), len(BAD),
    )
    assert await db.scalar(count) == TOTAL - len(BAD)
    assert row.stats_json['questions']['inserted'] == TOTAL - len(BAD)
    assert len(page_calls) == pages_before_retry, 'retry must reuse the checked local spool'
    assert max(widths) == 100 and len(committed_ms) == 499
    relation_count = await db.scalar(select(func.count()).select_from(QbQuestionCatalog).join(
        QbQuestion, QbQuestion.question_id == QbQuestionCatalog.question_id,
    ).where(QbQuestion.external_question_id.like('scale-%')))
    assert relation_count == (TOTAL - len(BAD)) * 3
    read_started = time.perf_counter()
    coverage = (await book_coverage(db, [1]))[1]
    book_ms = (time.perf_counter() - read_started) * 1000
    assert coverage['usableQuestionCount'] == coverage['activeQuestionCount'] == TOTAL - len(BAD)
    assert coverage['uncheckedQuestionCount'] == coverage['unusableQuestionCount'] == 0
    read_started = time.perf_counter()
    directories = await catalog_coverage(db, 1)
    directory_ms = (time.perf_counter() - read_started) * 1000
    assert max(item['descendantUsableQuestionCount'] for item in directories.values()) == TOTAL - len(BAD)
    assert max(item['descendantQuestionCount'] for item in directories.values()) == TOTAL - len(BAD)
    read_started = time.perf_counter()
    page = await BankDao.list_questions(db, QuestionPageQueryModel(textbookId=1, usableOnly=True, pageSize=100))
    questions_ms = (time.perf_counter() - read_started) * 1000
    assert page.total == coverage['usableQuestionCount'] and len(page.rows) == 100
    assert max(book_ms, directory_ms, questions_ms) < 10_000
    print(f'scale usable reads: bookMs={book_ms:.2f}, directoryMs={directory_ms:.2f}, '
          f'questionListMs={questions_ms:.2f}, usable={coverage["usableQuestionCount"]}', flush=True)
    batches = await batch_results(db, 28, row.import_id, page_size=50)
    assert len(batches['items']) == 50 and batches['page']['total'] == 499
    issues = await issue_results(db, 28, row.import_id, page_size=50)
    assert {item['questionId'] for item in issues['items']} == {f'scale-{index}' for index in BAD}
    assert not issues['page']['hasNext'] and issues['page']['total'] == 3
    journals = (await db.scalars(select(QbQuestionImportBatch).order_by(QbQuestionImportBatch.batch_no))).all()
    assert sum(item.next_cursor - item.start_cursor for item in journals) == TOTAL
    assert all(left.next_cursor == right.start_cursor for left, right in zip(journals, journals[1:]))
    await db.rollback()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    assert len(committed_ms) == 499 and len(page_calls) == pages_before_retry
    ordered = sorted(committed_ms)
    print(f'scale evidence: questions={TOTAL}, relations={TOTAL * 3}, committedBatches=499, '
          f'accepted={TOTAL - len(BAD)}, quarantined={len(BAD)}, '
          f'elapsedSeconds={time.perf_counter() - started:.2f}, '
          f'batchP95ms={ordered[int(len(ordered) * .95)]:.2f}, batchMaxMs={max(ordered):.2f}', flush=True)
