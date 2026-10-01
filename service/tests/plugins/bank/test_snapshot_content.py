"""List content integrity and compatibility with sealed image-only questions."""
import copy
import hashlib

import pytest

from exceptions.exception import ServiceException
from plugins.bank.service.snapshot_content import validate_list_content


def content(html='<p>题干</p>', **changes):
    row = dict(question_external_id='q1', content_html=html, plain_text='',
               content_hash=hashlib.sha256(html.encode()).hexdigest(),
               list_content_hash=hashlib.sha256(html.encode()).hexdigest(),
               content_complete=1, answer_status='not_collected')
    return {**row, **changes}


def test_legacy_image_only_keeps_original_flags():
    row = content('<img data-asset-key="f1">', content_complete=0)
    before = copy.deepcopy(row)
    validate_list_content(row, {'f1': {'byte_size': 1426, 'content_sha256': 'a' * 64}})
    assert row == before


@pytest.mark.parametrize('row,assets', [
    (content(content_hash='a' * 64), {}),
    (content(content_complete=0), {}),
    (content('<img data-asset-key="f1">'), {}),
    (content('<img src="https://example.com/a.png">'), {}),
    (content('<img data-asset-key="f1">', content_complete=0), {'f1': {'content_sha256': 'a' * 64}}),
    (content(answer_status='public_captured'), {}),
    (content('<p> </p>'), {}),
])
def test_rejects_incomplete_or_changed_content(row, assets):
    with pytest.raises(ServiceException):
        validate_list_content(row, assets)
