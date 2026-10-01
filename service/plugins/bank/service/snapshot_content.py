"""Validate the current list-API content contract without claiming detail capture."""

from __future__ import annotations

import hashlib
import re
from html.parser import HTMLParser
from typing import TYPE_CHECKING, Any

from exceptions.exception import ServiceException

if TYPE_CHECKING:
    from collections.abc import Mapping

_SHA256 = re.compile(r'^[0-9a-f]{64}$')


class _ContentProbe(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.keys: set[str] = set()
        self.text: list[str] = []
        self.unresolved_image = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == 'img':
            attributes = dict(attrs)
            key = str(attributes.get('data-asset-key') or '').strip()
            if not key or attributes.get('src') or attributes.get('data-src'):
                self.unresolved_image = True
            else:
                self.keys.add(key)

    def handle_data(self, data: str) -> None:
        self.text.append(data)


def _pick(row: Mapping[str, Any], snake: str, camel: str) -> Any:
    return row[snake] if snake in row else row.get(camel)


def validate_list_content(row: Mapping[str, Any], assets: Mapping[str, Mapping[str, Any]]) -> None:
    """Require canonical content and every referenced image in the immutable snapshot.

    Older list collectors used ``html && plainText`` as their completeness
    flag, falsely rejecting an image-only equation. Accept that narrow legacy
    case only when the HTML has no text, all images are declared, and their
    positive byte counts and hashes can subsequently be verified by asset IO.
    The stored detail/content flags are never rewritten.
    """
    external_id = _pick(row, 'question_external_id', 'externalQuestionId')
    html = str(_pick(row, 'content_html', 'contentHtml') or '')
    plain = str(_pick(row, 'plain_text', 'plainText') or '')
    digest = str(_pick(row, 'content_hash', 'contentHash') or '')
    list_digest = str(_pick(row, 'list_content_hash', 'listContentHash') or '')
    if not _SHA256.fullmatch(digest) or digest != list_digest or digest != hashlib.sha256((html or plain).encode()).hexdigest():
        raise ServiceException(message=f'题目 {external_id} 列表题干内容摘要不一致')
    probe = _ContentProbe()
    probe.feed(html)
    probe.close()
    if probe.unresolved_image or not probe.keys.issubset(assets):
        raise ServiceException(message=f'题目 {external_id} 的题干素材引用不完整')
    complete = _pick(row, 'content_complete', 'contentComplete')
    if complete not in (True, 1, '1', 'true'):
        image_only = (
            complete in (False, 0, '0', 'false')
            and not plain.strip() and not ''.join(probe.text).strip() and bool(probe.keys)
        )
        for key in probe.keys:
            asset = assets[key]
            try:
                size = int(_pick(asset, 'byte_size', 'byteSize') or 0)
            except (ValueError, TypeError):
                size = 0
            image_only = image_only and size > 0 and bool(_SHA256.fullmatch(str(
                _pick(asset, 'content_sha256', 'contentSha256') or '',
            )))
        if not image_only:
            raise ServiceException(message=f'题目 {external_id} 列表题干不完整')
    if not plain.strip() and not ''.join(probe.text).strip() and not probe.keys:
        raise ServiceException(message=f'题目 {external_id} 列表题干没有有效内容')
    status = str(_pick(row, 'answer_status', 'answerStatus') or '').lower()
    if status not in ('unknown', 'not_collected'):
        raise ServiceException(message=f'题目 {external_id} 列表题干不应声明已采集答案')
