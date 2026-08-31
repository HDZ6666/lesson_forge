"""Application services for the bank plugin."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from datetime import datetime
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import HTTPException

from exceptions.exception import ServiceException
from plugins.bank.dao.bank_dao import BankDao
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionAsset,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.entity.vo.bank_vo import (
    BatchModel,
    BatchPageQueryModel,
    CatalogNodeModel,
    CatalogPageQueryModel,
    CatalogTreeModel,
    QuestionAssetModel,
    QuestionDetailModel,
    QuestionModel,
    QuestionPageQueryModel,
    QuestionTagInputModel,
    QuestionTagModel,
    QuestionWriteModel,
    TextbookModel,
    TextbookQueryModel,
    TextbookVersionModel,
    TextbookVersionQueryModel,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from common.vo import PageModel


def _dump(model: object) -> dict:
    """Dump a pydantic model with the frontend's camelCase field names."""
    return model.model_dump(by_alias=True, exclude_none=False)  # type: ignore[union-attr]


def _rows_page(page: PageModel, model_type: type) -> PageModel:
    page.rows = [_dump(model_type.model_validate(row)) for row in page.rows]
    return page


_HTML_DANGEROUS_TAGS = {'script', 'iframe', 'object', 'embed', 'style', 'form'}
_ACTIVE_URL_RE = re.compile(r'^[\s\x00-\x20]*(?:javascript|vbscript|data):', re.I)
_DANGEROUS_TAG_SOURCE_RE = re.compile(r'<\s*/?\s*(?:script|iframe|object|embed|style|form)(?:\s|/?>|$)', re.I)
_EVENT_ATTRIBUTE_SOURCE_RE = re.compile(r'(?:^|[\s<])on[a-z][\w:-]*\s*=', re.I)
_SRCDOC_SOURCE_RE = re.compile(r'(?:^|[\s<])srcdoc\s*=', re.I)
_MAX_RAW_DEPTH = 8
_MAX_RAW_STRING = 10000
_MAX_RAW_ITEMS = 1000
_MAX_RAW_KEY = 200
_WRITE_FIELDS = {
    'version': {'version_name', 'source_url', 'is_new', 'sort_order', 'status'},
    'textbook': {'version_id', 'textbook_name', 'grade', 'volume', 'source_url', 'sort_order', 'status'},
    'catalog': {'textbook_id', 'parent_id', 'node_name', 'node_type', 'source_url', 'sort_order', 'status'},
}


def _require_name(value: str | None, label: str) -> str:
    value = (value or '').strip()
    if not value:
        raise ServiceException(message=f'{label}不能为空')
    return value


class _HTMLSecurityParser(HTMLParser):
    """Reject executable HTML while leaving supported question markup intact."""

    def _reject(self, message: str) -> None:
        raise ServiceException(message=message)

    def _check_attributes(self, attrs: list[tuple[str, str | None]]) -> None:
        for raw_name, raw_value in attrs:
            name = raw_name.lower()
            value = unescape(raw_value or '')
            if name.startswith('on'):
                self._reject('HTML包含不允许的事件属性')
            if name == 'srcdoc':
                self._reject('HTML包含不允许的srcdoc属性')
            if name == 'style':
                self._reject('HTML包含不允许的style属性')
            if _ACTIVE_URL_RE.match(value):
                self._reject('HTML包含不允许的主动URL')

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in _HTML_DANGEROUS_TAGS:
            self._reject('HTML包含不允许的脚本、框架或表单标签')
        self._check_attributes(attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)


def _safe_html(value: str | None, label: str) -> str | None:
    if value is not None:
        source = unescape(value)
        if (
            _DANGEROUS_TAG_SOURCE_RE.search(source)
            or _EVENT_ATTRIBUTE_SOURCE_RE.search(source)
            or _SRCDOC_SOURCE_RE.search(source)
        ):
            raise ServiceException(message=f'{label}包含不允许的脚本、框架或事件属性')
        parser = _HTMLSecurityParser(convert_charrefs=True)
        try:
            parser.feed(value)
            parser.close()
        except ServiceException:
            raise
        except Exception as exc:
            raise ServiceException(message=f'{label} HTML格式不安全') from exc
    return value


def _safe_raw(value: object, depth: int = 0) -> object:
    if depth > _MAX_RAW_DEPTH:
        raise ServiceException(message='rawDataJson嵌套层级过深')
    if value is None or isinstance(value, (str, int, float, bool)):
        if isinstance(value, str) and len(value) > _MAX_RAW_STRING:
            raise ServiceException(message='rawDataJson字符串过长')
        return value
    if isinstance(value, list):
        if len(value) > _MAX_RAW_ITEMS:
            raise ServiceException(message='rawDataJson数组过大')
        return [_safe_raw(item, depth + 1) for item in value]
    if isinstance(value, Mapping):
        if len(value) > _MAX_RAW_ITEMS:
            raise ServiceException(message='rawDataJson对象过大')
        result: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > _MAX_RAW_KEY or key.startswith(('$', '__')):
                raise ServiceException(message='rawDataJson包含不安全字段名')
            result[key] = _safe_raw(item, depth + 1)
        return result
    raise ServiceException(message='rawDataJson仅支持 JSON 基础类型')


def _check_immutable(values: dict, row: object, fields: set[str]) -> None:
    for field in fields:
        if field in values and values[field] != getattr(row, field, None):
            raise ServiceException(message=f'{field}为系统来源字段，不允许修改')


async def _commit_or_rollback(db: AsyncSession, operation: object) -> object:
    try:
        result = await operation  # type: ignore[misc]
        await db.commit()
        return result
    except Exception:
        await db.rollback()
        raise


class BankService:
    """Business rules and serialization for bank endpoints."""

    @classmethod
    async def list_versions(cls, db: AsyncSession, query: TextbookVersionQueryModel) -> PageModel:
        return _rows_page(await BankDao.list_versions(db, query), TextbookVersionModel)

    @classmethod
    async def list_textbooks(cls, db: AsyncSession, query: TextbookQueryModel) -> PageModel:
        return _rows_page(await BankDao.list_textbooks(db, query), TextbookModel)

    @classmethod
    async def version_detail(cls, db: AsyncSession, version_id: int) -> dict:
        row = await BankDao.get_version(db, version_id)
        if row is None:
            raise ServiceException(message='版本不存在')
        counts = await BankDao.version_textbook_counts(db, [version_id])
        row.textbook_count = counts.get(version_id, 0)
        return _dump(TextbookVersionModel.model_validate(row))

    @classmethod
    async def textbook_detail(cls, db: AsyncSession, textbook_id: int) -> dict:
        row = await BankDao.get_textbook(db, textbook_id)
        if row is None:
            raise ServiceException(message='教材不存在')
        stats = await BankDao.textbook_stats(db, [textbook_id])
        row.catalog_count, row.question_count = stats.get(textbook_id, (0, 0))
        return _dump(TextbookModel.model_validate(row))

    @classmethod
    async def catalog_detail(cls, db: AsyncSession, catalog_id: int) -> dict:
        row = await BankDao.get_catalog(db, catalog_id)
        if row is None:
            raise ServiceException(message='目录不存在')
        direct = await BankDao.catalog_question_counts(db, [catalog_id])
        row.direct_question_count = direct.get(catalog_id, 0)
        row.descendant_question_count = await cls._descendant_question_count(db, catalog_id)
        return _dump(CatalogNodeModel.model_validate(row))

    @classmethod
    async def list_catalogs(cls, db: AsyncSession, query: CatalogPageQueryModel) -> PageModel:
        page = await BankDao.list_catalogs(db, query)
        rows = page.rows
        textbook_ids = {
            int(cls._row_value(row, 'textbook_id', 'textbookId'))
            for row in rows
            if cls._row_value(row, 'textbook_id', 'textbookId') is not None
        }
        all_nodes: dict[int, list] = {}
        all_direct: dict[int, int] = {}
        include_disabled = BankDao._include_disabled(query)
        for textbook_id in textbook_ids:
            nodes = await BankDao.get_catalog_nodes(db, textbook_id, status=None)
            all_nodes[textbook_id] = nodes
            all_direct.update(
                await BankDao.catalog_question_counts(
                    db, [node.catalog_id for node in nodes], include_disabled=include_disabled
                )
            )
        all_totals: dict[int, int] = {}
        for nodes in all_nodes.values():
            all_totals.update(cls._catalog_totals(nodes, all_direct))
        for row in rows:
            catalog_id = cls._row_value(row, 'catalog_id', 'catalogId')
            if catalog_id is None:
                continue
            direct = all_direct.get(int(catalog_id), 0)
            descendant = all_totals.get(int(catalog_id), direct)
            if isinstance(row, dict):
                row['direct_question_count'] = direct
                row['descendant_question_count'] = descendant
            else:
                row.direct_question_count = direct
                row.descendant_question_count = descendant
        return _rows_page(page, CatalogNodeModel)

    @staticmethod
    def _row_value(row: object, snake_name: str, camel_name: str) -> object:
        if isinstance(row, dict):
            return row.get(camel_name, row.get(snake_name))
        return getattr(row, snake_name, None)

    @classmethod
    async def catalog_tree(cls, db: AsyncSession, textbook_id: int, include_disabled: bool = False) -> list[dict]:
        """Return active nodes for browsing, or all nodes for management."""
        nodes = await BankDao.get_catalog_nodes(db, textbook_id, status=None if include_disabled else '0')
        direct = await BankDao.catalog_question_counts(
            db, [node.catalog_id for node in nodes], include_disabled=include_disabled
        )
        totals = cls._catalog_totals(nodes, direct)
        result: dict[int, dict] = {}
        for node in nodes:
            node.direct_question_count = direct.get(node.catalog_id, 0)
            node.descendant_question_count = totals.get(node.catalog_id, 0)
            result[node.catalog_id] = _dump(CatalogTreeModel.model_validate(node))
        for node in result.values():
            node['children'] = []
        roots: list[dict] = []
        for node in result.values():
            parent_id = node.get('parentId')
            if parent_id in result:
                result[parent_id]['children'].append(node)
            else:
                roots.append(node)
        return roots

    @staticmethod
    def _catalog_totals(nodes: list, direct: dict[int, int]) -> dict[int, int]:
        """Aggregate each node's direct questions into all of its ancestors."""
        totals = {int(node.catalog_id): int(direct.get(node.catalog_id, 0)) for node in nodes}
        parents = {int(node.catalog_id): node.parent_id for node in nodes}
        for node_id, count in list(totals.items()):
            current = node_id
            seen = {node_id}
            while parents.get(current) is not None:
                parent = int(parents[current])
                if parent in seen:
                    break
                seen.add(parent)
                totals[parent] = totals.get(parent, 0) + count
                current = parent
        return totals

    @classmethod
    async def _descendant_question_count(cls, db: AsyncSession, catalog_id: int) -> int:
        row = await BankDao.get_catalog(db, catalog_id)
        if row is None:
            return 0
        nodes = await BankDao.get_catalog_nodes(db, row.textbook_id, status=None)
        direct = await BankDao.catalog_question_counts(db, [node.catalog_id for node in nodes])
        return cls._catalog_totals(nodes, direct).get(catalog_id, 0)

    @classmethod
    async def list_questions(cls, db: AsyncSession, query: QuestionPageQueryModel) -> PageModel:
        return _rows_page(await BankDao.list_questions(db, query), QuestionModel)

    @classmethod
    async def add_version(cls, db: AsyncSession, payload: TextbookVersionModel) -> dict:
        row = QbTextbookVersion(
            source_provider='manual',
            external_version_id=None,
            version_name=_require_name(payload.version_name, '版本名称'),
            source_url=payload.source_url,
            is_new=payload.is_new,
            sort_order=payload.sort_order or 0,
            status=payload.status or '0',
            create_time=datetime.now(),
            update_time=datetime.now(),
        )
        await _commit_or_rollback(db, BankDao.add_entity(db, row))
        return await cls.version_detail(db, row.version_id)

    @classmethod
    async def update_version(cls, db: AsyncSession, payload: TextbookVersionModel) -> dict:
        row = await BankDao.get_version(db, payload.version_id or 0)
        if row is None:
            raise ServiceException(message='版本不存在')
        values = payload.model_dump(exclude_unset=True, exclude_none=False)
        _check_immutable(
            values,
            row,
            {
                'version_id',
                'source_provider',
                'external_version_id',
                'last_sync_batch_id',
                'last_seen_at',
                'create_time',
            },
        )
        if row.source_provider != 'manual':
            allowed = {'version_name', 'source_url', 'is_new', 'sort_order', 'status'}
        else:
            allowed = _WRITE_FIELDS['version']
        values = {key: value for key, value in values.items() if key in allowed}
        if 'version_name' in values:
            values['version_name'] = _require_name(values['version_name'], '版本名称')
        values['update_time'] = datetime.now()
        await _commit_or_rollback(db, BankDao.update_entity(db, row, values))
        return await cls.version_detail(db, row.version_id)

    @classmethod
    async def delete_versions(cls, db: AsyncSession, ids: list[int]) -> None:
        rows = [await BankDao.get_version(db, item) for item in ids]
        if any(row is None for row in rows):
            raise ServiceException(message='版本不存在')
        if any(row.source_provider != 'manual' for row in rows if row):
            raise ServiceException(message='同步来源版本只允许停用，不能物理删除')
        counts = await BankDao.relation_counts(db, QbTextbook, QbTextbook.version_id, ids)
        if counts:
            raise ServiceException(message='版本下存在教材，不能删除')
        await _commit_or_rollback(db, BankDao.delete_versions(db, ids))

    @classmethod
    async def add_textbook(cls, db: AsyncSession, payload: TextbookModel) -> dict:
        if not payload.version_id or await BankDao.get_version(db, payload.version_id) is None:
            raise ServiceException(message='所属版本不存在')
        row = QbTextbook(
            version_id=payload.version_id,
            source_provider='manual',
            external_textbook_id=None,
            textbook_name=_require_name(payload.textbook_name, '教材名称'),
            grade=payload.grade,
            volume=payload.volume,
            source_url=payload.source_url,
            sort_order=payload.sort_order or 0,
            status=payload.status or '0',
            create_time=datetime.now(),
            update_time=datetime.now(),
        )
        await _commit_or_rollback(db, BankDao.add_entity(db, row))
        return await cls.textbook_detail(db, row.textbook_id)

    @classmethod
    async def update_textbook(cls, db: AsyncSession, payload: TextbookModel) -> dict:
        row = await BankDao.get_textbook(db, payload.textbook_id or 0)
        if row is None:
            raise ServiceException(message='教材不存在')
        values = payload.model_dump(exclude_unset=True, exclude_none=False)
        _check_immutable(
            values,
            row,
            {
                'textbook_id',
                'source_provider',
                'external_textbook_id',
                'last_sync_batch_id',
                'last_seen_at',
                'create_time',
            },
        )
        if row.source_provider != 'manual' and 'version_id' in values and values['version_id'] != row.version_id:
            raise ServiceException(message='同步来源教材不能修改所属版本')
        allowed = (
            _WRITE_FIELDS['textbook']
            if row.source_provider == 'manual'
            else {'textbook_name', 'source_url', 'grade', 'volume', 'sort_order', 'status'}
        )
        values = {key: value for key, value in values.items() if key in allowed}
        if 'textbook_name' in values:
            values['textbook_name'] = _require_name(values['textbook_name'], '教材名称')
        if 'version_id' in values and (
            not values['version_id'] or await BankDao.get_version(db, values['version_id']) is None
        ):
            raise ServiceException(message='所属版本不存在')
        values['update_time'] = datetime.now()
        await _commit_or_rollback(db, BankDao.update_entity(db, row, values))
        return await cls.textbook_detail(db, row.textbook_id)

    @classmethod
    async def delete_textbooks(cls, db: AsyncSession, ids: list[int]) -> None:
        rows = [await BankDao.get_textbook(db, item) for item in ids]
        if any(row is None for row in rows):
            raise ServiceException(message='教材不存在')
        if any(row.source_provider != 'manual' for row in rows if row):
            raise ServiceException(message='同步来源教材只允许停用，不能物理删除')
        counts = await BankDao.textbook_catalog_counts(db, ids)
        if counts:
            raise ServiceException(message='教材下存在目录，不能删除')
        counts = await BankDao.textbook_question_counts(db, ids)
        if counts:
            raise ServiceException(message='教材下存在题目，不能删除')
        await _commit_or_rollback(db, BankDao.delete_textbooks(db, ids))

    @classmethod
    async def add_catalog(cls, db: AsyncSession, payload: CatalogNodeModel) -> dict:
        textbook = await BankDao.get_textbook(db, payload.textbook_id or 0)
        if textbook is None:
            raise ServiceException(message='所属教材不存在')
        await cls._validate_catalog_parent(db, payload.textbook_id, payload.parent_id)
        row = QbCatalogNode(
            textbook_id=payload.textbook_id,
            parent_id=payload.parent_id,
            source_provider='manual',
            external_node_id=None,
            node_name=_require_name(payload.node_name, '目录名称'),
            node_type=_require_name(payload.node_type, '目录类型'),
            source_url=payload.source_url,
            sort_order=payload.sort_order or 0,
            status=payload.status or '0',
            create_time=datetime.now(),
            update_time=datetime.now(),
        )
        await _commit_or_rollback(db, BankDao.add_entity(db, row))
        return await cls.catalog_detail(db, row.catalog_id)

    @classmethod
    async def update_catalog(cls, db: AsyncSession, payload: CatalogNodeModel) -> dict:
        row = await BankDao.get_catalog(db, payload.catalog_id or 0)
        if row is None:
            raise ServiceException(message='目录不存在')
        values = payload.model_dump(exclude_unset=True, exclude_none=False)
        _check_immutable(
            values,
            row,
            {'catalog_id', 'source_provider', 'external_node_id', 'last_sync_batch_id', 'last_seen_at', 'create_time'},
        )
        if row.source_provider != 'manual' and any(
            key in values and values[key] != getattr(row, key) for key in ('textbook_id', 'parent_id')
        ):
            raise ServiceException(message='同步来源目录不能修改所属层级')
        allowed = (
            _WRITE_FIELDS['catalog']
            if row.source_provider == 'manual'
            else {'node_name', 'source_url', 'node_type', 'sort_order', 'status'}
        )
        values = {key: value for key, value in values.items() if key in allowed}
        textbook_id = values.get('textbook_id', row.textbook_id)
        parent_id = values.get('parent_id', row.parent_id)
        if textbook_id != row.textbook_id and row.source_provider != 'manual':
            raise ServiceException(message='同步来源目录不能修改所属教材')
        if textbook_id != row.textbook_id and await BankDao.catalog_child_counts(db, [row.catalog_id]):
            raise ServiceException(message='含有子目录的节点不能直接移动教材')
        if await BankDao.get_textbook(db, textbook_id) is None:
            raise ServiceException(message='所属教材不存在')
        await cls._validate_catalog_parent(db, textbook_id, parent_id, row.catalog_id)
        if 'node_name' in values:
            values['node_name'] = _require_name(values['node_name'], '目录名称')
        if 'node_type' in values:
            values['node_type'] = _require_name(values['node_type'], '目录类型')
        values['update_time'] = datetime.now()
        await _commit_or_rollback(db, BankDao.update_entity(db, row, values))
        return await cls.catalog_detail(db, row.catalog_id)

    @classmethod
    async def _validate_catalog_parent(
        cls, db: AsyncSession, textbook_id: int | None, parent_id: int | None, self_id: int | None = None
    ) -> None:
        if parent_id is None:
            return
        if self_id and parent_id == self_id:
            raise ServiceException(message='目录不能以自身为父节点')
        parent = await BankDao.get_catalog(db, parent_id)
        if parent is None or parent.textbook_id != textbook_id:
            raise ServiceException(message='父目录必须属于同一教材')
        if self_id:
            chain = await BankDao.catalog_parent_chain(db, parent_id)
            if self_id in chain:
                raise ServiceException(message='目录不能移动到自身后代节点')

    @classmethod
    async def delete_catalogs(cls, db: AsyncSession, ids: list[int]) -> None:
        rows = [await BankDao.get_catalog(db, item) for item in ids]
        if any(row is None for row in rows):
            raise ServiceException(message='目录不存在')
        if any(row.source_provider != 'manual' for row in rows if row):
            raise ServiceException(message='同步来源目录只允许停用，不能物理删除')
        if await BankDao.catalog_child_counts(db, ids):
            raise ServiceException(message='目录下存在子节点，不能删除')
        if await BankDao.catalog_relation_counts(db, ids):
            raise ServiceException(message='目录下存在题目关系，不能删除')
        await _commit_or_rollback(db, BankDao.delete_catalogs(db, ids))

    @classmethod
    async def add_question(cls, db: AsyncSession, payload: QuestionWriteModel) -> dict:
        catalog_ids = await cls._validate_question_catalogs(db, payload.catalog_ids, required=True)
        tags = cls._question_tags(payload.tags)
        values = cls._question_values(payload, creating=True)
        row = QbQuestion(
            source_provider='manual',
            external_question_id=None,
            answer_status=values.pop('answer_status', None) or 'unknown',
            create_time=datetime.now(),
            update_time=datetime.now(),
            **values,
        )

        async def operation() -> QbQuestion:
            await BankDao.add_entity(db, row)
            await BankDao.replace_question_catalogs(db, row.question_id, catalog_ids)
            await BankDao.replace_question_tags(db, row.question_id, tags)
            return row

        await _commit_or_rollback(db, operation())
        return await cls.question_detail(db, row.question_id)

    @classmethod
    async def _validate_question_catalogs(
        cls, db: AsyncSession, catalog_ids: list[int] | None, *, required: bool
    ) -> list[int]:
        if catalog_ids is None:
            if required:
                raise ServiceException(message='人工题目至少需要一个目录关联')
            return []
        if not catalog_ids:
            if required:
                raise ServiceException(message='人工题目至少需要一个目录关联')
            return []
        if any(catalog_id <= 0 for catalog_id in catalog_ids) or len(catalog_ids) != len(set(catalog_ids)):
            raise ServiceException(message='目录关联必须是去重后的正整数')
        rows = await BankDao.get_catalogs(db, catalog_ids)
        if len(rows) != len(catalog_ids):
            raise ServiceException(message='目录不存在')
        textbook_ids = {int(row.textbook_id) for row in rows}
        if len(textbook_ids) != 1:
            raise ServiceException(message='题目关联目录必须属于同一教材')
        if any(getattr(row, 'status', '0') != '0' for row in rows):
            raise ServiceException(message='题目只能关联启用中的目录')
        return list(catalog_ids)

    @staticmethod
    def _question_tags(tags: list[QuestionTagInputModel] | None) -> list[dict[str, str]]:
        if tags is None:
            return []
        values: list[dict[str, str]] = []
        seen: set[tuple[str, str, str]] = set()
        for tag in tags:
            tag_type = tag.tag_type.strip()
            tag_name = tag.tag_name.strip()
            relation_type = tag.relation_type.strip()
            if not tag_type or not tag_name:
                raise ServiceException(message='题目标签维度和名称不能为空')
            if not relation_type:
                raise ServiceException(message='题目标签关系类型不能为空')
            key = (tag_type, tag_name, relation_type)
            if key in seen:
                raise ServiceException(message='题目标签不能重复')
            seen.add(key)
            value = {'tag_type': tag_type, 'tag_name': tag_name}
            if relation_type != 'provider_asserted':
                value['relation_type'] = relation_type
            values.append(value)
        return values

    @classmethod
    def _question_values(cls, payload: QuestionWriteModel, creating: bool = False) -> dict:
        dumped = payload.model_dump(exclude_unset=True, exclude_none=False)
        if creating and not (
            str(dumped.get('content_html') or '').strip() or str(dumped.get('plain_text') or '').strip()
        ):
            raise ServiceException(message='题干 HTML 与纯文本至少填写一个')
        for field in ('content_html', 'answer_html', 'analysis_html'):
            if field in dumped:
                dumped[field] = _safe_html(dumped[field], field)
        if 'raw_data_json' in dumped:
            dumped['raw_data_json'] = _safe_raw(dumped['raw_data_json'])
        allowed = {
            'source_url',
            'source_question_no',
            'source_text',
            'paper_name',
            'academic_year',
            'year',
            'grade',
            'term',
            'province',
            'city',
            'district',
            'school_name',
            'exam_type',
            'question_type',
            'difficulty',
            'difficulty_coefficient',
            'score',
            'content_html',
            'plain_text',
            'answer_html',
            'analysis_html',
            'answer_status',
            'subquestion_count',
            'website_time_text',
            'external_updated_at',
            'assemble_count',
            'reference_count',
            'reference_papers_json',
            'is_fresh',
            'content_hash',
            'raw_data_json',
            'status',
        }
        return {key: value for key, value in dumped.items() if key in allowed}

    @classmethod
    async def update_question(cls, db: AsyncSession, payload: QuestionWriteModel) -> dict:
        row = await BankDao.get_question(db, payload.question_id or 0)
        if row is None:
            raise ServiceException(message='题目不存在')
        dumped = payload.model_dump(exclude_unset=True, exclude_none=False)
        _check_immutable(
            dumped,
            row,
            {
                'question_id',
                'source_provider',
                'external_question_id',
                'last_sync_batch_id',
                'last_seen_at',
                'create_time',
            },
        )
        if row.source_provider != 'manual':
            values = {'status': dumped['status']} if 'status' in dumped else {}
            if (
                {key for key in dumped if key not in {'question_id', 'status'}}
                or 'status' not in dumped
                or dumped.get('status') not in {'0', '1'}
            ):
                raise ServiceException(message='同步来源题目只允许修改启停状态')
        else:
            values = cls._question_values(payload)
            if not (
                str(values.get('content_html', row.content_html) or '').strip()
                or str(values.get('plain_text', row.plain_text) or '').strip()
            ):
                raise ServiceException(message='题干 HTML 与纯文本至少保留一个非空值')
        relation_fields = {'catalog_ids', 'tags'} & dumped.keys()
        catalog_ids: list[int] | None = None
        tags: list[dict[str, str]] | None = None
        if row.source_provider == 'manual' and 'catalog_ids' in relation_fields:
            if payload.catalog_ids is None:
                raise ServiceException(message='catalogIds必须是数组')
            catalog_ids = await cls._validate_question_catalogs(db, payload.catalog_ids, required=True)
        if row.source_provider == 'manual' and 'tags' in relation_fields:
            if payload.tags is None:
                raise ServiceException(message='tags必须是数组')
            tags = cls._question_tags(payload.tags)
        if not values and not relation_fields:
            raise ServiceException(message='没有可修改字段')
        values['update_time'] = datetime.now()

        async def operation() -> QbQuestion:
            await BankDao.update_entity(db, row, values)
            if catalog_ids is not None:
                await BankDao.replace_question_catalogs(db, row.question_id, catalog_ids)
            if tags is not None:
                await BankDao.replace_question_tags(db, row.question_id, tags)
            return row

        await _commit_or_rollback(db, operation())
        return await cls.question_detail(db, row.question_id)

    @classmethod
    async def delete_questions(cls, db: AsyncSession, ids: list[int]) -> None:
        rows = [await BankDao.get_question(db, item) for item in ids]
        if any(row is None for row in rows):
            raise ServiceException(message='题目不存在')
        if any(row.source_provider != 'manual' for row in rows if row):
            raise ServiceException(message='同步来源题目不能物理删除')
        await _commit_or_rollback(db, BankDao.delete_questions(db, ids))

    @classmethod
    async def question_detail(cls, db: AsyncSession, question_id: int) -> dict:
        row = await BankDao.get_question_detail(db, question_id)
        if row is None:
            raise ServiceException(message='题目不存在')
        data = _dump(QuestionDetailModel.model_validate(row))
        catalog_rows = await BankDao.get_question_catalogs(db, question_id)
        tag_rows = await BankDao.get_question_tags(db, question_id)
        data['catalogIds'] = [
            int(relation.catalog_id) for relation in catalog_rows if relation.relation_type == 'query_catalog'
        ]
        data['tags'] = [_dump(QuestionTagModel.model_validate(tag)) for tag in tag_rows]
        return data

    @classmethod
    async def list_assets(
        cls, db: AsyncSession, question_id: int | None = None, asset_type: str | None = None
    ) -> list[dict]:
        return [
            _dump(QuestionAssetModel.model_validate(row))
            for row in await BankDao.list_assets(db, question_id, asset_type)
        ]

    @classmethod
    async def get_asset_by_key(cls, db: AsyncSession, question_id: int, asset_key: str) -> QbQuestionAsset | None:
        return await BankDao.get_asset_by_key(db, question_id, asset_key)

    @staticmethod
    def resolve_asset_path(storage_path: str | None) -> Path:
        """Resolve a stored relative path and reject traversal/symlink escapes."""
        if not storage_path:
            raise HTTPException(status_code=404, detail='素材文件不存在')
        root = Path(os.environ.get('BANK_ASSET_ROOT', 'data/bank/assets')).expanduser().resolve()
        raw = Path(storage_path).expanduser()
        candidate = (raw if raw.is_absolute() else root / raw).resolve(strict=False)
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail='素材路径不合法') from exc
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail='素材文件不存在')
        return candidate

    @classmethod
    async def list_batches(cls, db: AsyncSession, query: BatchPageQueryModel) -> PageModel:
        return _rows_page(await BankDao.list_batches(db, query), BatchModel)

    @classmethod
    async def batch_detail(cls, db: AsyncSession, batch_id: int) -> dict:
        row = await BankDao.get_batch(db, batch_id)
        if row is None:
            raise ServiceException(message='发布批次不存在')
        return _dump(BatchModel.model_validate(row))

    @staticmethod
    async def approve_batch(db: AsyncSession, batch_id: int, username: str) -> dict:
        if await BankDao.approve_batch(db, batch_id, username) != 1:
            row = await BankDao.get_batch(db, batch_id)
            if row is None:
                raise ServiceException(message='发布批次不存在')
            raise ServiceException(message='批次当前状态不可审批')
        return await BankService.batch_detail(db, batch_id)

    @staticmethod
    async def publish_batch(db: AsyncSession, batch_id: int) -> dict:
        if await BankDao.request_publish(db, batch_id) != 1:
            row = await BankDao.get_batch(db, batch_id)
            if row is None:
                raise ServiceException(message='发布批次不存在')
            raise ServiceException(message='批次当前状态不可发布')
        return await BankService.batch_detail(db, batch_id)

    @staticmethod
    async def rollback_batch(db: AsyncSession, batch_id: int) -> dict:
        target = await BankDao.get_batch(db, batch_id)
        if target is None:
            raise ServiceException(message='发布批次不存在')
        if target.status not in {'published', 'archived'}:
            raise ServiceException(message='只有已发布或已归档批次可以回退')
        return _dump(BatchModel.model_validate(await BankDao.create_rollback_batch(db, target)))
