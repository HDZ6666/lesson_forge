"""Source observations and real scan gaps persist with the sealed import."""

import copy
import importlib.util
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionCatalog,
    QbQuestionImport,
    QbQuestionImportIntake,
    QbSyncJobScope,
)
from plugins.bank.entity.vo.bank_vo import TextbookCoverageModel, TextbookModel
from plugins.bank.service import import_intake_worker as intake_worker
from plugins.bank.service import incremental_import_worker as worker
from plugins.bank.service.bank_service import BankService
from plugins.bank.service.book_coverage import book_coverage
from plugins.bank.service.import_intake import claim_import_intake, complete_import_intake, register_import_intake
from plugins.bank.service.import_results import list_import_history
from plugins.bank.service.incremental_import import request_incremental_import
from plugins.bank.service.question_apply_service import _normalise_snapshot_summary
from plugins.bank.service.run_coverage import normalise_run_coverage, run_coverage_status
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_import_worker import _client
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


def evidence():
    return {
        'format': 'run-coverage-v1', 'collectorRunId': 27, 'textbookExternalId': 'tb1',
        'sourceReport': {'count': 4, 'observedAt': '2026-10-01T00:00:00Z', 'basis': 'textbook_root_probe'},
        'scan': {'availableCatalogCount': 3, 'selectedCatalogCount': 2, 'observedCatalogCount': 1,
                 'scanCompletedCatalogCount': 1, 'dataCompletedCatalogCount': 0, 'unscannedCatalogCount': 1,
                 'failedPageCount': 1, 'duplicatePageCount': 0, 'parseErrorCount': 0, 'assetErrorCount': 0,
                 'targetsKnown': True, 'catalogSelectionTruncated': False,
                 'startPage': 1, 'maxPages': 0, 'questionLimit': 0},
    }


def normalized(value=None):
    return normalise_run_coverage(evidence() if value is None else value, 27, 'tb1', datetime(2026, 10, 1, 1))


def test_source_difference_is_never_presented_as_an_exact_gap():
    report = run_coverage_status(normalized(), 3)
    assert report['sourceCountDifference'] == 1 and report['differenceIsExactGap'] is False
    assert report['scan']['unscannedCatalogCount'] == 1 and report['hasKnownGaps']
    report = run_coverage_status(normalized(), 5)
    assert report['sourceCountDifference'] == -1
    assert report['sourceReport']['observedAt'] == '2026-10-01T00:00:00.000Z'


def test_legacy_unknown_evidence_is_not_fabricated_from_counts_or_finish_time():
    assert normalise_run_coverage(None, 27, 'tb1', None) is None
    value = evidence()
    value['sourceReport'] = {'count': None, 'observedAt': None, 'basis': None}
    value['scan'] = {key: None for key in value['scan']}
    value['scan']['targetsKnown'] = False
    report = run_coverage_status(normalized(value), 3)
    assert report['sourceCountDifference'] is None
    assert report['scan']['unscannedCatalogCount'] is None and not report['hasKnownGaps']
    value['sourceReport'] = {'count': 0, 'observedAt': None, 'basis': 'textbook_root_probe'}
    assert normalized(value)['sourceReport']['count'] == 0


def test_summary_and_page_headers_use_the_same_frozen_evidence(monkeypatch):
    _client_value, summary, _calls = _client(monkeypatch)
    summary['run']['scope']['sealedCoverageEvidence'] = evidence()
    # Bounded pages can omit the redundant top-level projection.
    header = _normalise_snapshot_summary(summary, 28, 'tb1', sealed_for_import=True)
    assert header['run_coverage'] == normalized()
    summary['coverage'] = copy.deepcopy(evidence())
    summary['coverage']['sourceReport']['observedAt'] = '2026-10-01T08:00:00+08:00'
    assert _normalise_snapshot_summary(summary, 28, 'tb1', sealed_for_import=True)['run_coverage'] == normalized()
    summary['coverage']['sourceReport']['count'] = 5
    with pytest.raises(ServiceException, match='与封存记录不一致'):
        _normalise_snapshot_summary(summary, 28, 'tb1', sealed_for_import=True)
    summary['coverage'] = None
    with pytest.raises(ServiceException, match='与封存记录不一致'):
        _normalise_snapshot_summary(summary, 28, 'tb1', sealed_for_import=True)


def test_coverage_fields_are_a_read_contract_separate_from_management_writes():
    schema = TextbookCoverageModel.model_json_schema(by_alias=True)
    assert {'formalQuestionCount', 'activeQuestionCount'} <= set(schema['required'])
    assert 'latestSourceObservation' in schema['properties']
    payload = TextbookModel(textbookName='教材', formalQuestionCount=999, activeQuestionCount=999)
    assert 'formal_question_count' not in payload.model_dump()
    assert 'active_question_count' not in payload.model_dump()


@pytest.mark.parametrize('path,value', [
    (('format',), 'other'), (('collectorRunId',), 28), (('textbookExternalId',), 'tb2'),
    (('sourceReport', 'count'), -1), (('sourceReport', 'count'), True),
    (('sourceReport', 'observedAt'), '2026-10-01T02:00:00Z'),
    (('sourceReport', 'observedAt'), '2026-10-01T00:00:00'),
    (('sourceReport', 'basis'), 'sum_of_chapters'),
    (('scan', 'failedPageCount'), '1'), (('scan', 'unscannedCatalogCount'), True),
    (('scan', 'unscannedCatalogCount'), 2), (('scan', 'targetsKnown'), 'true'),
    (('scan', 'scanCompletedCatalogCount'), 2), (('scan', 'startPage'), 0),
    (('scan', 'catalogSelectionTruncated'), 1), (('scan', 'url'), 'https://example.invalid'),
])
def test_malformed_or_foreign_evidence_is_rejected(path, value):
    sample = evidence()
    target = sample
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    with pytest.raises(ServiceException, match='覆盖证据无效'):
        normalized(sample)


async def save_observation(db, run_id, count, observed_at, *, book_id=1):
    scope = await db.get(QbSyncJobScope, 30)
    scope.collector_run_id = run_id
    scope.local_textbook_id = book_id
    scope.external_textbook_id = f'tb{book_id}'
    scope.snapshot_locked_at = datetime(2026, 10, 1, run_id - 26)
    await db.commit()
    state = await request_incremental_import(db, 28)
    row = await db.get(QbQuestionImport, state['importId'])
    value = evidence()
    value.update(collectorRunId=run_id, textbookExternalId=scope.external_textbook_id)
    value['sourceReport'] = {'count': count, 'observedAt': observed_at,
                             'basis': 'textbook_root_probe' if count is not None else None}
    row.run_coverage_json = normalise_run_coverage(value, run_id, row.external_textbook_id, row.snapshot_locked_at)
    await db.commit()
    return row.import_id


@pytest.mark.asyncio
async def test_book_keeps_latest_dated_observation_across_limited_and_late_imports(import_db):
    db = import_db
    await save_observation(db, 27, 4, '2026-10-01T00:00:00Z')
    latest = await save_observation(db, 28, 3, '2026-10-01T00:30:00Z')
    await save_observation(db, 29, None, None)
    await save_observation(db, 30, 5, '2026-10-01T00:15:00Z')
    await save_observation(db, 31, 6, None)
    other = await save_observation(db, 32, 0, '2026-10-01T00:50:00Z', book_id=2)
    current = await book_coverage(db, [1, 2])
    assert current[1]['latestSourceObservation']['importId'] == latest
    assert current[1]['latestSourceObservation']['count'] == 3
    assert current[2]['latestSourceObservation']['count'] == 0
    # An import header cannot claim another current book's source identity.
    row = await db.get(QbQuestionImport, other)
    row.external_textbook_id = 'tb1'
    await db.commit()
    assert (await book_coverage(db, [2]))[2]['latestSourceObservation'] is None


@pytest.mark.asyncio
async def test_formal_and_enabled_counts_deduplicate_and_exclude_foreign_subjects(import_db):
    db = import_db
    now = datetime.now()
    times = {'create_time': now, 'update_time': now}
    db.add_all([
        QbCatalogNode(catalog_id=10, textbook_id=1, subject_id=1, source_provider='manual',
                      node_name='另一目录', node_type='chapter', status='0', **times),
        QbCatalogNode(catalog_id=11, textbook_id=1, subject_id=1, source_provider='manual',
                      node_name='停用目录', node_type='chapter', status='1', **times),
        QbCatalogNode(catalog_id=12, textbook_id=1, subject_id=2, source_provider='manual',
                      node_name='错属学科目录', node_type='chapter', status='0', **times),
        QbQuestion(question_id=4, subject_id=1, source_provider='zujuan', external_question_id='inactive-only',
                   plain_text='仅属于停用目录', status='0', **times),
        QbQuestion(question_id=5, subject_id=2, source_provider='zujuan', external_question_id='missing',
                   plain_text='另一学科的相同来源 ID', status='0', **times),
    ])
    for question, catalog in ((1, 1), (3, 1), (3, 10), (4, 11), (5, 1), (3, 12)):
        db.add(QbQuestionCatalog(question_id=question, catalog_id=catalog, relation_type='query_catalog',
                                 evidence_type='query_membership', sort_order=0, **times))
    await db.commit()
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(db.bind.sync_engine, 'before_cursor_execute', record)
    try:
        result = await book_coverage(db, [1, 2])
        assert len(statements) == 9  # Separate cheap directory counts; all queries remain batched across books.
    finally:
        event.remove(db.bind.sync_engine, 'before_cursor_execute', record)
    assert result[1]['formalQuestionCount'] == 3 and result[1]['activeQuestionCount'] == 1
    assert result[2]['formalQuestionCount'] == 1 and result[2]['activeQuestionCount'] == 0
    detail = await BankService.textbook_detail(db, 1)
    assert detail['formalQuestionCount'] == 3 and detail['activeQuestionCount'] == 1
    assert detail['latestSourceObservation'] is None


@pytest.mark.asyncio
async def test_intake_and_worker_preserve_observation_and_gaps_in_history(import_db, monkeypatch, tmp_path):
    db = import_db
    client, summary, _calls = _client(monkeypatch)
    summary['coverage'] = evidence()
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    await intake_worker.dispatch_import_intakes_once(session_factory=factory, client=client)
    row = await db.scalar(select(QbQuestionImport))
    saved = copy.deepcopy(row.run_coverage_json)
    import_id = row.import_id
    assert saved == normalized()
    await db.rollback()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.get(QbQuestionImport, import_id, populate_existing=True)
    assert row.status == 'partial' and row.run_coverage_json == saved
    history = await list_import_history(db, 28)
    report = history['items'][0]['runCoverage']
    assert report['collectedQuestionCount'] == 3 and report['sourceReport']['count'] == 4
    assert report['scan']['unscannedCatalogCount'] == 1 and not report['differenceIsExactGap']


@pytest.mark.asyncio
async def test_changed_sealed_observation_stops_preparation_without_writes(import_db, monkeypatch, tmp_path):
    db = import_db
    client, summary, _calls = _client(monkeypatch)
    summary['coverage'] = evidence()
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    await intake_worker.dispatch_import_intakes_once(session_factory=factory, client=client)
    summary['coverage']['sourceReport']['count'] = 5
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.scalar(select(QbQuestionImport))
    assert row.status == 'failed' and row.cursor == 0 and row.run_coverage_json == normalized()


@pytest.mark.asyncio
async def test_observation_counts_and_queue_roll_back_together(import_db, monkeypatch):
    db = import_db
    client, summary, _calls = _client(monkeypatch)
    summary['coverage'] = evidence()
    scope = await db.get(QbSyncJobScope, 30)
    scope.snapshot_locked_at = None
    scope.question_count = 0
    await db.commit()
    intake = await register_import_intake(db, 30)
    ticket = await claim_import_intake(db, intake['intakeId'])

    async def interrupted():
        raise RuntimeError('simulate commit failure')

    monkeypatch.setattr(db, 'commit', interrupted)
    validated = _normalise_snapshot_summary(summary, 28, 'tb1', sealed_for_import=True)
    with pytest.raises(RuntimeError, match='commit failure'):
        await complete_import_intake(db, ticket, validated)
    assert await db.scalar(select(func.count()).select_from(QbQuestionImport)) == 0
    scope = await db.get(QbSyncJobScope, 30, populate_existing=True)
    assert scope.question_count == 0 and scope.snapshot_locked_at is None
    intake = await db.get(QbQuestionImportIntake, ticket['intakeId'], populate_existing=True)
    assert intake.status == 'probing' and intake.import_id is None


@pytest.mark.asyncio
async def test_coverage_migration_is_additive_and_repeatable(import_db):
    db = import_db
    if db.bind.dialect.name != 'mysql':
        pytest.skip('requires the explicitly isolated MySQL check')
    state = await request_incremental_import(db, 28)
    await db.execute(text('ALTER TABLE qb_question_import DROP COLUMN run_coverage_json'))
    path = Path(__file__).parents[3] / 'plugins/bank/migrations/mysql/018_run_coverage.py'
    spec = importlib.util.spec_from_file_location('coverage_migration', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    await migration.run(db)
    await db.commit()
    row = await db.get(QbQuestionImport, state['importId'], populate_existing=True)
    assert row.run_coverage_json is None and row.question_count == 3 and row.status == 'queued'
    row.run_coverage_json = normalized()
    await db.commit()
    await migration.run(db)
    await migration.run(db)
    await db.commit()
    assert (await db.get(QbQuestionImport, row.import_id, populate_existing=True)).run_coverage_json == normalized()
