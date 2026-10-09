"""Derived stem facts: bounded disk checks, cheap shared SQL eligibility.

Answers are deliberately absent from both the payload and the asset set.
File IO must finish before callers acquire the source write lock.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, exists, select, tuple_

from plugins.bank.entity.do.bank_do import QbQuestion, QbQuestionAsset, QbQuestionReadiness

MAX_STEM_CHARS = 120_000
MAX_STEM_ASSETS = 500
MAX_ASSET_BYTES = 64 * 1024 * 1024
QUESTION_COLUMNS = (
    'question_id',
    'subject_id',
    'source_provider',
    'external_question_id',
    'readiness_revision',
    'content_hash',
    'content_html',
    'plain_text',
)
ASSET_COLUMNS = (
    'question_id',
    'asset_key',
    'asset_type',
    'source_provider',
    'storage_path',
    'file_hash',
    'download_status',
    'mime_type',
    'width',
    'height',
)


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()


def _meaningful(value: str) -> bool:
    return bool(re.sub(r'[\s\u200b-\u200f\ufeff]+', '', value))


class _StemProbe(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.keys: set[str] = set()
        self.has_image = False
        self.has_table = False
        self.text: list[str] = []
        self.invalid = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag in {'script', 'iframe', 'object', 'embed', 'form', 'input', 'video', 'audio', 'source', 'svg'}:
            self.invalid = True
        if any(
            key.startswith('on') or str(value or '').strip().lower().startswith('javascript:') for key, value in attrs
        ):
            self.invalid = True
        if tag == 'table':
            self.has_table = True
        if tag == 'img':
            self.has_image = True
            key = str(values.get('data-asset-key') or '').strip()
            if not key or len(key) > 100:
                self.invalid = True
            else:
                self.keys.add(key)
            # A keyed image is rendered through the formal asset endpoint;
            # unkeyed external images cannot silently enter the usable pool.

    handle_startendtag = handle_starttag

    def handle_data(self, data):
        self.text.append(data)


def probe_stem(question: dict[str, Any]) -> dict[str, Any]:
    html = str(question.get('content_html') or '')
    plain = str(question.get('plain_text') or '')
    probe = _StemProbe()
    oversized = len(html) > MAX_STEM_CHARS or len(plain) > MAX_STEM_CHARS
    if not oversized:
        try:
            probe.feed(html)
            probe.close()
        except (ValueError, RecursionError):
            probe.invalid = True
    valid = not oversized and not probe.invalid and len(probe.keys) <= MAX_STEM_ASSETS
    # The renderer prefers HTML. A stale plain_text field cannot rescue
    # empty HTML that would print a blank question.
    valid = valid and (_meaningful(''.join(probe.text)) or bool(probe.keys) if html.strip() else _meaningful(plain))
    return {
        'stem_hash': _digest([html, plain]),
        'stem_valid': bool(valid),
        'has_image': probe.has_image,
        'has_table': probe.has_table,
        'keys': sorted(probe.keys) if len(probe.keys) <= MAX_STEM_ASSETS else [],
    }


def question_payload(row: Any) -> dict[str, Any]:
    return {key: getattr(row, key) for key in QUESTION_COLUMNS}


def asset_payload(row: Any) -> dict[str, Any]:
    return {key: getattr(row, key) for key in ASSET_COLUMNS}


def required_assets(probe: dict[str, Any], assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keys = set(probe['keys'])
    return sorted(
        (
            {key: row.get(key) for key in ASSET_COLUMNS if key != 'question_id'}
            for row in assets
            if row.get('asset_key') in keys
        ),
        key=lambda row: row['asset_key'],
    )


def _file_ready(root: Path, asset: dict[str, Any], max_bytes: int) -> int:
    digest = str(asset.get('file_hash') or '')
    relative = str(asset.get('storage_path') or '')
    path = PurePosixPath(relative)
    if (
        asset.get('download_status') != 'downloaded'
        or not re.fullmatch(r'[0-9a-fA-F]{64}', digest)
        or not relative
        or '\\' in relative
        or path.is_absolute()
        or '..' in path.parts
    ):
        return 0
    try:
        current = root.resolve()
        for part in path.parts:
            current = current / part
            if current.is_symlink():
                return 0
        if not current.is_file() or not 0 < current.stat().st_size <= min(MAX_ASSET_BYTES, max_bytes):
            return 0
        hasher = hashlib.sha256()
        size = 0
        with current.open('rb') as stream:
            while chunk := stream.read(64 * 1024):
                size += len(chunk)
                if size > min(MAX_ASSET_BYTES, max_bytes):
                    return 0
                hasher.update(chunk)
        return size if size > 0 and hasher.hexdigest() == digest.lower() else 0
    except (OSError, ValueError):
        return 0


def check_question(question: dict[str, Any], assets: list[dict[str, Any]], root: Path) -> dict[str, Any]:
    """Pure bounded preparation: no database connection, no answer asset IO."""
    probe = probe_stem(question)
    required = required_assets(probe, assets)
    complete = len(required) == len(probe['keys']) and len({row['asset_key'] for row in required}) == len(required)
    assets_ready = complete
    remaining = MAX_ASSET_BYTES  # Total necessary bytes per question, not per image.
    if complete:
        for row in required:
            size = _file_ready(root, row, remaining)
            if not size:
                assets_ready = False
                break
            remaining -= size
    status = 'ready' if probe['stem_valid'] and assets_ready else 'invalid'
    return {
        **question,
        **{key: probe[key] for key in ('stem_hash', 'stem_valid', 'has_image', 'has_table')},
        'asset_signature': _digest(required),
        'assets_ready': assets_ready,
        'status': status,
        'reason': None
        if status == 'ready'
        else (
            '题干为空、格式无效或超过检查预算'
            if not probe['stem_valid']
            else '题干必要素材缺失、内容摘要不一致或超过检查预算'
        ),
        'checked_at': datetime.now(timezone.utc).replace(tzinfo=None),
    }


def current_facts_predicate(question=QbQuestion, facts=QbQuestionReadiness):
    return and_(
        facts.question_id == question.question_id,
        question.readiness_revision.is_not(None),
        facts.question_revision == question.readiness_revision,
        facts.subject_id == question.subject_id,
        facts.source_provider == question.source_provider,
        facts.external_question_id.is_not_distinct_from(question.external_question_id),
        facts.content_hash.is_not_distinct_from(question.content_hash),
    )


def usable_predicate(question=QbQuestion):
    """Question-level predicate; callers additionally enforce enabled scope ownership."""
    return and_(
        question.status == '0',
        exists(
            select(1).where(
                current_facts_predicate(question),
                QbQuestionReadiness.status == 'ready',
                QbQuestionReadiness.stem_valid == 1,
                QbQuestionReadiness.assets_ready == 1,
            )
        ),
    )


async def fetch_required_assets(db, questions: list[dict[str, Any]], *, lock: bool = False):
    pairs = [(q['question_id'], key) for q in questions for key in probe_stem(q)['keys']]
    if not pairs:
        return []
    rows = []
    for offset in range(0, len(pairs), 1000):
        query = select(QbQuestionAsset).where(
            tuple_(QbQuestionAsset.question_id, QbQuestionAsset.asset_key).in_(pairs[offset : offset + 1000])
        )
        if lock:
            query = query.with_for_update()
        rows.extend((await db.scalars(query)).all())
    return rows


async def store_proofs(db, rows: list[Any], assets: list[Any], proofs: list[dict[str, Any]], *, compare_revision=True):
    """CAS against current body/assets, without IO, inside the writer transaction.

    New imports supply prepared source proofs, so their identity/body/assets
    must match but the formal revision was just assigned by the merge.
    """
    by_id = {row.question_id: row for row in rows}
    by_external = {(row.subject_id, row.source_provider, row.external_question_id): row for row in rows}
    current = {
        row.question_id: row
        for row in (
            await db.scalars(
                select(QbQuestionReadiness)
                .where(
                    QbQuestionReadiness.question_id.in_(by_id),
                )
                .with_for_update()
            )
        ).all()
    }
    stored = set()
    for proof in proofs:
        row = (
            by_id.get(proof.get('question_id'))
            if compare_revision
            else by_external.get(
                (
                    proof['subject_id'],
                    proof['source_provider'],
                    proof['external_question_id'],
                )
            )
        )
        if row is None:
            continue
        payload = question_payload(row)
        probe = probe_stem(payload)
        signature = _digest(
            required_assets(probe, [asset_payload(a) for a in assets if a.question_id == row.question_id])
        )
        if (
            any(
                payload[key] != proof.get(key)
                for key in ('subject_id', 'source_provider', 'external_question_id', 'content_hash')
            )
            or probe['stem_hash'] != proof['stem_hash']
            or signature != proof['asset_signature']
            or compare_revision
            and payload['readiness_revision'] != proof['readiness_revision']
        ):
            continue
        if row.readiness_revision is None:
            row.readiness_revision = uuid4().hex
        values = {
            key: proof[key]
            for key in (
                'subject_id',
                'source_provider',
                'external_question_id',
                'content_hash',
                'stem_hash',
                'asset_signature',
                'has_image',
                'has_table',
                'stem_valid',
                'assets_ready',
                'status',
                'reason',
                'checked_at',
            )
        }
        values['question_revision'] = row.readiness_revision
        fact = current.get(row.question_id)
        if fact is None:
            db.add(QbQuestionReadiness(question_id=row.question_id, **values))
        else:
            for key, value in values.items():
                setattr(fact, key, value)
        stored.add(row.question_id)
    return stored
