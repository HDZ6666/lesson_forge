from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from plugins.bank.entity.vo.bank_vo import TaskComparisonQueryModel
from plugins.bank.service import question_review_service as module


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
    class Client:
        def run_catalogs_preview(self, *_args, **_kwargs):
            return {'available': True, 'run': {'id': 1, 'provider': 'zujuan', 'textbookExternalIds': ['book']}, 'rows': [node], 'total': 1}
    monkeypatch.setattr(module, 'CollectorClient', Client)
    result = await module.QuestionReviewService.catalogs(None, 17, TaskComparisonQueryModel())
    assert result['rows'][0]['reviewTags'] == expected
    assert result['rows'][0]['oldQuestionCount'] == previous
