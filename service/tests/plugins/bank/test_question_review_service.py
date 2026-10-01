"""Compare one bounded Collector preview page with the current formal rows."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from plugins.bank.entity.do.bank_do import QbQuestion
from plugins.bank.entity.vo.bank_vo import TaskComparisonQueryModel
from plugins.bank.service import question_review_service as module


def test_review_diff_preserves_known_answer_when_collection_skipped_it() -> None:
    fetched = {'contentHtml': '<p>same</p>', 'plainText': 'same', 'answerStatus': 'unknown'}
    current = {**fetched, 'answerStatus': 'public', 'answerHtml': '<p>known</p>', 'status': '0'}
    assert module._question_diff_fields(fetched, current) == []
    assert module._question_diff_fields({**fetched, 'contentHtml': '<p>changed</p>'}, current) == ['contentHtml']
    assert module._question_diff_fields(fetched, {**current, 'status': '1'}) == ['status']


def test_review_diff_uses_full_content_hash_for_truncated_preview() -> None:
    current = {'contentHash': 'abc', 'contentHtml': '<p>' + 'x' * 5000 + '</p>',
               'plainText': 'x' * 2000, 'answerStatus': 'unknown', 'status': '0'}
    preview = {'contentHash': 'abc', 'contentHtml': current['contentHtml'][:4000],
               'plainText': current['plainText'][:1000], 'answerStatus': 'unknown'}
    assert module._question_diff_fields(preview, current) == []
    assert module._question_diff_fields({**preview, 'contentHash': 'def'}, current) == ['contentHash']


@pytest.mark.asyncio
async def test_review_page_labels_new_changed_and_unchanged_questions(monkeypatch: pytest.MonkeyPatch) -> None:
    class Result:
        def __init__(self, rows: list[QbQuestion]) -> None:
            self.rows = rows

        def scalars(self) -> Result:
            return self

        def all(self) -> list[QbQuestion]:
            return self.rows

    class Db:
        async def execute(self, _query: object) -> Result:
            return Result([
                QbQuestion(question_id=1, source_provider='zujuan', external_question_id='same',
                           content_html='<p>same</p>', plain_text='same', answer_status='unknown', status='0'),
                QbQuestion(question_id=2, source_provider='zujuan', external_question_id='changed',
                           content_html='<p>old</p>', plain_text='old', answer_status='unknown', status='0'),
            ])

    class Client:
        def run_questions_preview(self, *_args: object, **_kwargs: object) -> dict:
            return {
                'rows': [
                    {'sourceProvider': 'zujuan', 'externalQuestionId': key, 'contentHtml': f'<p>{value}</p>',
                     'plainText': value, 'answerStatus': 'unknown'}
                    for key, value in (('same', 'same'), ('changed', 'new'), ('new', 'new'))
                ],
                'total': 3,
            }

    scope = SimpleNamespace(collector_run_id=17, external_textbook_id='tb')
    review = SimpleNamespace(excluded_json=[], revision=2)
    monkeypatch.setattr(module.QuestionReviewService, 'context', AsyncMock(return_value=(None, scope, review)))
    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module, 'validate_preview', lambda *_args: None)
    query = SimpleNamespace(catalog_id=None, question_type=None, keyword=None, page_num=1, page_size=20,
                            selection='all')

    result = await module.QuestionReviewService.questions(Db(), 18, query)

    assert [row['comparisonStatus'] for row in result['rows']] == ['unchanged', 'modified', 'new']
    assert result['rows'][1]['diffFields'] == ['contentHash']
    assert result['rows'][0]['current']['currentLocalId'] == 1
    assert result['rows'][2]['current'] is None
    assert result['revision'] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(('status', 'previous', 'count', 'expected'), [
    ('completed', None, 10, ['new']),
    ('completed', 8, 10, ['increased']),
    ('completed', 12, 10, ['decreased']),
    ('completed', 10, 10, ['existing']),
    ('running', 100, 10, ['running']),
    ('failed', 100, 10, ['incomplete']),
])
async def test_directory_counts_do_not_label_incomplete_scans_as_decreased(monkeypatch, status, previous, count, expected):
    node = {'sourceProvider': 'zujuan', 'externalTextbookId': 'book', 'externalCatalogId': 'node',
            'nodeName': '矩形性质理解', 'nodeType': 'knowledge', 'parentExternalId': None, 'questionCount': count}
    baseline = [] if previous is None else [{**node, 'questionCount': previous}]
    review = SimpleNamespace(baseline_json={'origin': 'task_start', 'rows': baseline}, excluded_json=[], captured_at=datetime.now())
    scope = SimpleNamespace(external_textbook_id='book', collector_run_id=1, status=status)
    monkeypatch.setattr(module.QuestionReviewService, 'context', AsyncMock(return_value=(SimpleNamespace(options_json={}), scope, review)))
    monkeypatch.setattr(module, '_current_catalogs', AsyncMock(return_value=baseline))

    class Client:
        def run_catalogs_preview(self, *_args, **_kwargs):
            return {'available': True, 'run': {'id': 1, 'provider': 'zujuan', 'textbookExternalIds': ['book']}, 'rows': [node], 'total': 1}

    monkeypatch.setattr(module, 'CollectorClient', Client)
    result = await module.QuestionReviewService.catalogs(None, 17, TaskComparisonQueryModel())
    assert result['rows'][0]['reviewTags'] == expected
    assert result['rows'][0]['oldQuestionCount'] == previous


@pytest.mark.asyncio
async def test_directory_comparison_uses_current_formal_rows_not_old_baseline(monkeypatch):
    node = {'sourceProvider': 'zujuan', 'externalTextbookId': 'book', 'externalCatalogId': 'node',
            'nodeName': '新名称', 'nodeType': 'knowledge', 'parentExternalId': None, 'sortOrder': 2,
            'questionCount': 10}
    original = [{**node, 'nodeName': '旧名称', 'questionCount': 3}]
    current = [{**node, 'questionCount': 10, 'status': '0'}]
    review = SimpleNamespace(baseline_json={'origin': 'task_start', 'rows': original}, excluded_json=[],
                             captured_at=datetime.now())
    scope = SimpleNamespace(external_textbook_id='book', collector_run_id=1, status='completed')
    monkeypatch.setattr(module.QuestionReviewService, 'context', AsyncMock(return_value=(SimpleNamespace(options_json={}), scope, review)))
    monkeypatch.setattr(module, '_current_catalogs', AsyncMock(return_value=current))

    class Client:
        def run_catalogs_preview(self, *_args, **_kwargs):
            return {'available': True, 'run': {'id': 1, 'provider': 'zujuan', 'textbookExternalIds': ['book']},
                    'rows': [node], 'total': 1}

    monkeypatch.setattr(module, 'CollectorClient', Client)
    result = await module.QuestionReviewService.catalogs(None, 17, TaskComparisonQueryModel())
    assert result['rows'][0]['reviewTags'] == ['existing']
    assert result['rows'][0]['oldQuestionCount'] == 10
    assert result['currentTree'][0]['nodeName'] == '新名称'
