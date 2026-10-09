from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from plugins.bank.source_write_contract import SOURCE_WRITE_LOCK_NAME

MAX_MYSQL_BIGINT = 9_223_372_036_854_775_807
MAX_BATCH_NO_LENGTH = 128
ZIP_FILE_TYPE_MASK = 0o170000
ZIP_SYMLINK_TYPE = 0o120000

SNAPSHOT_TABLES = (
    'qb_textbook_version',
    'qb_textbook',
    'qb_catalog_node',
    'qb_question',
    'qb_question_catalog',
    'qb_question_tag',
    'qb_question_asset',
)
DATASET_TABLES = (*SNAPSHOT_TABLES, 'qb_dataset_meta')
BANK_TABLES = DATASET_TABLES
REQUIRED_MEMBERS = frozenset(
    {'manifest.json', 'snapshot.sqlite3', 'diff-report.json', 'validation.json', 'checksums.sha256'}
)
SNAPSHOT_COLUMNS = {
    'qb_textbook_version': {
        'provider',
        'external_id',
        'version_name',
        'subject',
        'grade',
        'edition',
        'source_url',
        'metadata_json',
    },
    'qb_textbook': {
        'provider',
        'external_id',
        'version_external_id',
        'textbook_name',
        'subject',
        'grade',
        'edition',
        'volume',
        'source_url',
        'metadata_json',
    },
    'qb_catalog_node': {
        'provider',
        'external_id',
        'textbook_external_id',
        'parent_external_id',
        'node_level',
        'node_type',
        'name',
        'source_path',
        'active',
        'metadata_json',
    },
    'qb_question': {
        'provider',
        'external_id',
        'textbook_version_external_id',
        'textbook_external_id',
        'detail_url',
        'source_short',
        'source_title',
        'source_url',
        'source_original_json',
        'question_type',
        'question_type_id',
        'difficulty_label',
        'difficulty_code',
        'ease_coefficient',
        'content_html',
        'plain_text',
        'content_hash',
        'subquestion_count',
        'child_count',
        'has_image',
        'has_formula',
        'has_table',
        'is_new',
        'assemble_count',
        'reference_count',
        'year',
        'region',
        'exam_type',
        'answer_html',
        'solution_html',
        'answer_status',
        'first_seen_at',
        'last_seen_at',
        'active',
    },
    'qb_question_catalog': {
        'provider',
        'question_external_id',
        'catalog_external_id',
        'relation_type',
        'evidence_type',
        'query_fingerprint',
        'observed_at',
    },
    'qb_question_tag': {
        'provider',
        'question_external_id',
        'dimension',
        'tag_external_id',
        'tag_value',
        'relation_type',
        'evidence_type',
        'query_fingerprint',
        'observed_at',
    },
    'qb_question_asset': {
        'provider',
        'question_external_id',
        'asset_key',
        'asset_type',
        'source_url',
        'content_sha256',
        'storage_path',
        'mime_type',
        'byte_size',
        'observed_at',
    },
}
IDENT_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
BATCH_RE = re.compile(r'^[1-9][0-9]*$')
HEX64_RE = re.compile(r'^[0-9a-fA-F]{64}$')
ASSET_KEY_RE = re.compile(r'^[A-Za-z0-9_.-]+-[0-9a-f]{16}$')
HTML_ASSET_RE = re.compile(r"\bdata-asset-key\s*=\s*(?:\"([^\"]+)\"|'([^']+)'|([^\s>]+))", re.I)
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024
MAX_MEMBERS = 100_000
MAX_PENDING_BATCHES = 100


class PackageError(ValueError):
    """A package or publication invariant failed."""


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not IDENT_RE.fullmatch(value):
        raise PackageError(f'非法 SQL 标识符: {value!r}')
    return f'`{value}`'


def _batch_id(value: int | str) -> int:
    if isinstance(value, bool):
        raise PackageError('batchId 必须是正整数')
    try:
        text = str(int(value))
    except (TypeError, ValueError) as exc:
        raise PackageError('batchId 必须是正整数') from exc
    if not BATCH_RE.fullmatch(text) or int(text) > MAX_MYSQL_BIGINT:
        raise PackageError('batchId 必须是合法 BIGINT 正整数')
    return int(text)


def _qi(table: str) -> str:
    return _identifier(table)


def _sqlite_qi(table: str) -> str:
    return _qi(table).replace('`', '"')


def _next_name(base: str, batch_id: int) -> str:
    _batch_id(batch_id)
    if base not in DATASET_TABLES:
        raise PackageError(f'不允许的业务表: {base}')
    return f'{base}_next_{batch_id}'


def _old_name(base: str, batch_id: int) -> str:
    # ``old_0`` is the first publication's valid outgoing group.
    if isinstance(batch_id, bool) or int(batch_id) < 0 or int(batch_id) > MAX_MYSQL_BIGINT:
        raise PackageError('old 表批次后缀必须是非负 BIGINT')
    if base not in DATASET_TABLES:
        raise PackageError(f'不允许的业务表: {base}')
    return f'{base}_old_{batch_id}'


def build_rename_sql(outgoing_batch: int, incoming_batch: int, *, rollback_from_old: int | None = None) -> str:
    """Return exactly one, deterministic eight-table MySQL RENAME statement."""
    incoming = _batch_id(incoming_batch)
    outgoing = 0 if outgoing_batch in (None, '', 0, '0') else _batch_id(outgoing_batch)
    pairs: list[tuple[str, str]] = []
    if rollback_from_old is None:
        pairs.extend((_next_name(base, incoming), base) for base in DATASET_TABLES)
        # MySQL evaluates all pairs atomically.  The old group is named after
        # the batch that was outgoing, not after the incoming artifact.
        for base in DATASET_TABLES:
            pairs.insert(DATASET_TABLES.index(base), (base, _old_name(base, outgoing)))
    else:
        target = _batch_id(rollback_from_old)
        current = outgoing
        for base in DATASET_TABLES:
            pairs.append((base, _old_name(base, current)))
            pairs.append((_old_name(base, target), base))
    return 'RENAME TABLE ' + ', '.join(f'{_qi(old)} TO {_qi(new)}' for old, new in pairs) + ';'


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _safe_member(name: str) -> bool:
    if not name or '\\' in name or '\x00' in name or name.startswith('/'):
        return False
    if name.endswith('/'):
        return False
    path = PurePosixPath(name)
    return str(path) == name and '..' not in path.parts and (name in REQUIRED_MEMBERS or name.startswith('assets/'))


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackageError(f'{path.name} 不是合法 JSON: {exc}') from exc


@dataclass(frozen=True)
class VerifiedPackage:
    path: Path
    root: Path
    manifest: Mapping[str, Any]
    validation: Mapping[str, Any]
    snapshot: Path
    checksums: Mapping[str, str]

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class QbPkgVerifier:
    """Verify a qbpkg without invoking unzip/zip or any shell command."""

    def __init__(self, *, max_member_bytes: int = MAX_MEMBER_BYTES, max_package_bytes: int = MAX_PACKAGE_BYTES) -> None:
        self.max_member_bytes = max_member_bytes
        self.max_package_bytes = max_package_bytes

    def verify(self, package: str | os.PathLike[str], *, keep_root: bool = False) -> VerifiedPackage:  # noqa: PLR0912, PLR0915
        package_path = Path(package).resolve()
        if not package_path.is_file():
            raise PackageError(f'发布包不存在: {package_path}')
        if package_path.stat().st_size > self.max_package_bytes:
            raise PackageError('发布包超过大小上限')
        # Resolve the temp root as well as each member.  macOS commonly has a
        # ``/var`` -> ``/private/var`` symlink, which otherwise looks like a
        # false Zip-Slip escape.
        temp = Path(tempfile.mkdtemp(prefix='qbpkg-verify-')).resolve()
        try:
            with zipfile.ZipFile(package_path, 'r') as archive:
                infos = archive.infolist()
                if len(infos) > MAX_MEMBERS:
                    raise PackageError('ZIP 成员数量超过上限')
                names = [item.filename for item in infos]
                if len(names) != len(set(names)):
                    raise PackageError('ZIP 存在重复成员')
                if set(names) != REQUIRED_MEMBERS | {name for name in names if name.startswith('assets/')}:
                    raise PackageError('ZIP 存在白名单外成员')
                for item in infos:
                    if not _safe_member(item.filename):
                        raise PackageError(f'ZIP 路径不安全或不在白名单: {item.filename!r}')
                    if item.file_size > self.max_member_bytes:
                        raise PackageError(f'ZIP 成员过大: {item.filename}')
                    # A symlink can escape during extraction even if its name is safe.
                    if ((item.external_attr >> 16) & ZIP_FILE_TYPE_MASK) == ZIP_SYMLINK_TYPE:
                        raise PackageError(f'ZIP 成员不得为符号链接: {item.filename}')
                total = sum(item.file_size for item in infos)
                if total > self.max_package_bytes:
                    raise PackageError('ZIP 解压总大小超过上限')
                for item in infos:
                    target = (temp / item.filename).resolve()
                    if temp not in target.parents:
                        raise PackageError('ZIP 解压路径越界')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item, 'r') as source, target.open('wb') as dest:
                        shutil.copyfileobj(source, dest, 1024 * 1024)
            if not REQUIRED_MEMBERS.issubset(set(names)):
                raise PackageError('缺少 qbpkg 必需成员')
            checksums = self._read_checksums(temp / 'checksums.sha256', set(names))
            for name, expected in checksums.items():
                actual = _sha256_file(temp / name)
                if actual.lower() != expected.lower():
                    raise PackageError(f'成员校验和不匹配: {name}')
            manifest = _json(temp / 'manifest.json')
            validation = _json(temp / 'validation.json')
            _json(temp / 'diff-report.json')
            if not isinstance(manifest, dict) or not isinstance(validation, dict):
                raise PackageError('manifest/validation 必须是 JSON 对象')
            self._validate_manifest(manifest, temp / 'snapshot.sqlite3')
            if validation.get('pass') is not True or validation.get('blocking'):
                raise PackageError('包内 validation.json 已报告阻断')
            self._validate_snapshot(temp / 'snapshot.sqlite3', manifest, temp)
            result = VerifiedPackage(package_path, temp, manifest, validation, temp / 'snapshot.sqlite3', checksums)
            if keep_root:
                return result
            # The caller needs the extracted files while processing.  It can
            # use the context-style cleanup helper after completion.
            return result
        except (zipfile.BadZipFile, EOFError) as exc:
            shutil.rmtree(temp, ignore_errors=True)
            raise PackageError(f'ZIP 无法读取: {exc}') from exc
        except Exception:
            shutil.rmtree(temp, ignore_errors=True)
            raise

    @staticmethod
    def _read_checksums(path: Path, members: set[str]) -> dict[str, str]:
        lines = [line for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
        records: dict[str, str] = {}
        for line in lines:
            match = re.fullmatch(r'([0-9a-fA-F]{64})  (.+)', line)
            if not match or not _safe_member(match.group(2)) or match.group(2) == 'checksums.sha256':
                raise PackageError(f'checksums.sha256 行格式非法: {line!r}')
            if match.group(2) in records:
                raise PackageError('checksums.sha256 存在重复路径')
            records[match.group(2)] = match.group(1).lower()
        expected = sorted(members - {'checksums.sha256'})
        if list(records) != expected:
            raise PackageError('checksums.sha256 未按字典序覆盖全部成员')
        return records

    @staticmethod
    def _validate_manifest(manifest: Mapping[str, Any], snapshot: Path) -> None:
        required = (
            'formatVersion',
            'schemaVersion',
            'batchNo',
            'createdAt',
            'sourceProvider',
            'dataset',
            'counts',
            'snapshotSha256',
            'fullSnapshot',
            'rangeEvidence',
        )
        missing = [field for field in required if manifest.get(field) is None]
        if missing:
            raise PackageError(f'manifest 缺少字段: {", ".join(missing)}')
        if str(manifest['formatVersion']) != '1' or str(manifest['schemaVersion']) != '2':
            raise PackageError('不支持的 qbpkg format/schema 版本')
        if manifest.get('fullSnapshot') is not True:
            raise PackageError('qbpkg 必须是 full snapshot')
        if not isinstance(manifest['sourceProvider'], str) or not manifest['sourceProvider']:
            raise PackageError('sourceProvider 不能为空')
        dataset = manifest['dataset']
        if not isinstance(dataset, dict) or dataset.get('provider') != manifest['sourceProvider']:
            raise PackageError('manifest dataset/provider 不一致')
        if not HEX64_RE.fullmatch(str(manifest['snapshotSha256'])):
            raise PackageError('snapshotSha256 非 SHA-256')
        if _sha256_file(snapshot) != str(manifest['snapshotSha256']).lower():
            raise PackageError('snapshotSha256 不匹配')
        evidence = manifest['rangeEvidence']
        if not isinstance(evidence, dict) or not any(
            evidence.get(k) is True or evidence.get(k) in ('success', 'completed')
            for k in ('completed', 'complete', 'finished', 'status')
        ):
            raise PackageError('缺少同步完成证据')

    @staticmethod
    def _validate_snapshot(path: Path, manifest: Mapping[str, Any], package_root: Path) -> None:  # noqa: PLR0912
        try:
            db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
            db.row_factory = sqlite3.Row
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise PackageError('SQLite integrity_check 失败')
            if db.execute('PRAGMA foreign_key_check').fetchall():
                raise PackageError('SQLite foreign_key_check 失败')
            actual = tuple(
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            )
            if set(actual) != set(SNAPSHOT_TABLES):
                raise PackageError('snapshot 表集合不是七张正式业务表')
            provider = str(manifest['sourceProvider'])
            for table, required in SNAPSHOT_COLUMNS.items():
                columns = {row[1] for row in db.execute(f'PRAGMA table_info({_sqlite_qi(table)})')}
                if columns != required:
                    raise PackageError(f'snapshot {table} 字段不符合契约')
                count = db.execute(f'SELECT COUNT(*) FROM {_sqlite_qi(table)}').fetchone()[0]
                expected = manifest.get('counts', {}).get(table)
                if expected is None or int(expected) != count:
                    raise PackageError(f'snapshot {table} 数量与 manifest 不一致')
                if db.execute(f'SELECT 1 FROM {_sqlite_qi(table)} WHERE provider <> ? LIMIT 1', (provider,)).fetchone():
                    raise PackageError(f'snapshot {table} provider 不一致')
            for table, join in (
                (
                    'qb_question_catalog',
                    'LEFT JOIN qb_question q ON q.provider=x.provider AND q.external_id=x.question_external_id LEFT JOIN qb_catalog_node c ON c.provider=x.provider AND c.external_id=x.catalog_external_id WHERE q.external_id IS NULL OR c.external_id IS NULL',
                ),
                (
                    'qb_question_tag',
                    'LEFT JOIN qb_question q ON q.provider=x.provider AND q.external_id=x.question_external_id WHERE q.external_id IS NULL',
                ),
                (
                    'qb_question_asset',
                    'LEFT JOIN qb_question q ON q.provider=x.provider AND q.external_id=x.question_external_id WHERE q.external_id IS NULL',
                ),
            ):
                if db.execute(f'SELECT 1 FROM {table} x {join} LIMIT 1').fetchone():
                    raise PackageError(f'snapshot {table} 存在孤儿关系')
            if db.execute('SELECT 1 FROM qb_question WHERE reference_count IS NOT NULL LIMIT 1').fetchone():
                raise PackageError('reference_count 必须保持 NULL')
            for row in db.execute(
                'SELECT asset_key, asset_type, source_url, content_sha256, storage_path FROM qb_question_asset'
            ):
                if not row['asset_type'] or not row['source_url'] or not ASSET_KEY_RE.fullmatch(str(row['asset_key'])):
                    raise PackageError('素材字段或 asset_key 非法')
                expected_key = f'{row["asset_type"]}-{hashlib.sha256(str(row["source_url"]).encode()).hexdigest()[:16]}'
                if str(row['asset_key']) != expected_key:
                    raise PackageError('素材 asset_key 与 source_url 不一致')
                if row['content_sha256'] is not None and not HEX64_RE.fullmatch(str(row['content_sha256'])):
                    raise PackageError('素材 content_sha256 非法')
                if row['storage_path'] and (
                    not row['content_sha256'] or not str(row['storage_path']).startswith('assets/')
                ):
                    raise PackageError('素材 storage_path 非法')
            assets = {
                (row['provider'], row['question_external_id'], row['asset_key'])
                for row in db.execute('SELECT provider, question_external_id, asset_key FROM qb_question_asset')
            }
            for row in db.execute(
                'SELECT provider, external_id, content_html, answer_html, solution_html FROM qb_question'
            ):
                for html_field in ('content_html', 'answer_html', 'solution_html'):
                    for match in HTML_ASSET_RE.finditer(row[html_field] or ''):
                        if (
                            row['provider'],
                            row['external_id'],
                            match.group(1) or match.group(2) or match.group(3),
                        ) not in assets:
                            raise PackageError(f'{html_field} 引用了不存在的 asset_key')
            for row in db.execute(
                'SELECT content_sha256, storage_path FROM qb_question_asset WHERE content_sha256 IS NOT NULL AND storage_path IS NOT NULL'
            ):
                if row['storage_path'].startswith('assets/') and not (package_root / row['storage_path']).is_file():
                    raise PackageError(f'包内素材缺失: {row["storage_path"]}')
                if row['storage_path'].startswith('assets/'):
                    asset_path = package_root / row['storage_path']
                    if _sha256_file(asset_path).lower() != str(row['content_sha256']).lower():
                        raise PackageError(f'包内素材 SHA-256 不匹配: {row["storage_path"]}')
        except sqlite3.Error as exc:
            raise PackageError(f'无法读取 snapshot.sqlite3: {exc}') from exc
        finally:
            try:
                db.close()
            except UnboundLocalError:
                pass


def verify_package(package: str | os.PathLike[str]) -> VerifiedPackage:
    return QbPkgVerifier().verify(package, keep_root=True)


@dataclass
class PublisherConfig:
    asset_root: Path = Path(os.environ.get('BANK_ASSET_ROOT') or 'data/bank')
    lock_name: str = SOURCE_WRITE_LOCK_NAME
    lock_timeout: int = 30
    stale_after_seconds: int = 24 * 3600

    def __post_init__(self) -> None:
        if self.lock_name != SOURCE_WRITE_LOCK_NAME:
            raise PackageError('离线发布必须使用统一题库写入锁，不能指定其他锁名')


class MySQLPublisher:
    """Build, validate and atomically publish qbpkg data into MySQL."""

    def __init__(self, connection: Any, config: PublisherConfig | None = None) -> None:
        self.connection = connection
        self.config = config or PublisherConfig()

    def _cursor(self) -> Any:
        return self.connection.cursor()

    def _execute(self, sql: str, args: Iterable[Any] = ()) -> Any:
        cursor = self._cursor()
        cursor.execute(sql, tuple(args))
        return cursor

    def _fetchone(self, sql: str, args: Iterable[Any] = ()) -> Mapping[str, Any] | None:
        cursor = self._execute(sql, args)
        row = cursor.fetchone()
        if row is None:
            return None
        if isinstance(row, Mapping):
            return row
        fields = [item[0] for item in (cursor.description or ())]
        return dict(zip(fields, row, strict=True))

    def _fetchall(self, sql: str, args: Iterable[Any] = ()) -> list[Mapping[str, Any]]:
        cursor = self._execute(sql, args)
        rows = cursor.fetchall() or []
        if not rows:
            return []
        if isinstance(rows[0], Mapping):
            return list(rows)
        fields = [item[0] for item in (cursor.description or ())]
        return [dict(zip(fields, row, strict=True)) for row in rows]

    def _commit(self) -> None:
        self.connection.commit()

    def _rollback(self) -> None:
        try:
            self.connection.rollback()
        except Exception:
            pass

    def acquire_lock(self) -> None:
        row = self._fetchone('SELECT GET_LOCK(%s, %s) AS acquired', (SOURCE_WRITE_LOCK_NAME, self.config.lock_timeout))
        value = next(iter(row.values())) if row else 0
        if int(value or 0) != 1:
            raise PackageError('无法取得题库发布锁')

    def release_lock(self) -> None:
        try:
            self._execute('SELECT RELEASE_LOCK(%s)', (SOURCE_WRITE_LOCK_NAME,))
        except Exception:
            pass

    def register(
        self, package: str | os.PathLike[str], *, batch_no: str | None = None, batch_id: int | None = None
    ) -> int:
        verified = QbPkgVerifier().verify(package)
        try:
            manifest = verified.manifest
            batch_no = str(batch_no or manifest['batchNo'])
            if not batch_no or len(batch_no) > MAX_BATCH_NO_LENGTH:
                raise PackageError('batch_no 非法')
            values = (
                batch_no,
                'full',
                manifest['sourceProvider'],
                str(manifest['schemaVersion']),
                str(Path(package).resolve()),
                _sha256_file(Path(package).resolve()),
                'building',
                int(manifest['counts'].get('qb_question', 0)),
                int(manifest['counts'].get('qb_catalog_node', 0)),
                int(manifest['counts'].get('qb_question_tag', 0)),
                int(manifest['counts'].get('qb_question_asset', 0)),
            )
            column_names = [
                'batch_no',
                'batch_type',
                'source_provider',
                'schema_version',
                'artifact_uri',
                'artifact_sha256',
                'status',
                'question_count',
                'catalog_count',
                'tag_count',
                'asset_count',
            ]
            columns = ','.join(_qi(name) for name in column_names)
            placeholders = ','.join(['%s'] * 11)
            sql = f'INSERT INTO {_qi("qb_sync_batch")} ({columns}) VALUES ({placeholders})'
            if batch_id is not None:
                bid = _batch_id(batch_id)
                sql = f'INSERT INTO {_qi("qb_sync_batch")} ({_qi("batch_id")},{columns}) VALUES (%s,{placeholders})'
                values = (bid, *values)
            try:
                self._execute(sql, values)
                self._commit()
            except Exception as exc:
                self._rollback()
                raise PackageError(f'注册批次失败: {exc}') from exc
            if batch_id is not None:
                return int(batch_id)
            return int(next(iter(self._fetchone('SELECT LAST_INSERT_ID() AS batch_id').values())))
        finally:
            shutil.rmtree(verified.root, ignore_errors=True)

    def process(self, batch_id: int, package: str | os.PathLike[str]) -> dict[str, Any]:
        bid = _batch_id(batch_id)
        verified = QbPkgVerifier().verify(package)
        self.acquire_lock()
        try:
            self._set_batch(bid, 'validating', error=None)
            report = self._build_candidate(bid, verified)
            if not report['pass']:
                self._set_batch(bid, 'failed', error=json.dumps(report, ensure_ascii=False))
                self._drop_exact_group('next', bid)
                raise PackageError('候选数据二次校验失败')
            self._set_batch(bid, 'validated', report=report)
            self._set_batch(bid, 'approval_pending', report=report)
            return report
        except Exception:
            self._rollback()
            try:
                self._set_batch(bid, 'failed', error='候选构建或验证失败')
                self._drop_exact_group('next', bid)
            except Exception:
                pass
            raise
        finally:
            shutil.rmtree(verified.root, ignore_errors=True)
            self.release_lock()

    def publish(self, batch_id: int, package: str | os.PathLike[str] | None = None) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
        bid = _batch_id(batch_id)
        row = self._fetchone('SELECT * FROM qb_sync_batch WHERE batch_id=%s', (bid,))
        if not row:
            raise PackageError(f'批次不存在: {bid}')
        status = row.get('status')
        if status == 'published':
            self.acquire_lock()
            try:
                meta = self._current_meta()
                if not meta or int(meta.get('current_batch_id') or 0) != bid:
                    raise PackageError('已发布批次的正式 qb_dataset_meta 未指向本批次')
                return {'pass': True, 'batch_id': bid, 'idempotent': True}
            finally:
                self.release_lock()
        if status not in ('approved', 'publishing'):
            raise PackageError(f'批次状态不允许发布: {row.get("status")}')
        artifact = package or row.get('artifact_uri')
        if not artifact:
            raise PackageError('批次缺少 artifact_uri')
        verified = QbPkgVerifier().verify(artifact)
        switched = False
        self.acquire_lock()
        try:
            self._set_batch(bid, 'publishing', error=None)
            scope = (
                verified.manifest.get('dataset', {}).get('scopeKey')
                or f'{verified.manifest["sourceProvider"]}:{verified.manifest["dataset"].get("versionExternalId", "")}:{verified.manifest["dataset"].get("textbookExternalId", "")}'
            )
            existing_next = self._existing_group('next', bid)
            if len(existing_next) == len(DATASET_TABLES):
                report = self._validate_candidate(
                    bid, {base: _next_name(base, bid) for base in DATASET_TABLES}, verified.manifest, scope
                )
            else:
                report = self._build_candidate(bid, verified)
            if not report['pass']:
                self._set_batch(bid, 'failed', error=json.dumps(report, ensure_ascii=False))
                self._drop_exact_group('next', bid)
                raise PackageError('候选数据二次校验失败')
            meta = self._current_meta()
            outgoing = int(meta.get('current_batch_id') or 0) if meta else 0
            self._execute(
                f'UPDATE {_qi(_next_name("qb_dataset_meta", bid))} SET previous_batch_id=%s WHERE current_batch_id=%s',
                (outgoing or None, bid),
            )
            self._commit()
            self._reset_candidate_readiness(_next_name("qb_question", bid))
            sql = build_rename_sql(outgoing, bid)
            self._execute(sql)
            self._commit()
            switched = True
            current = self._current_meta()
            if not current or int(current.get('current_batch_id') or 0) != bid:
                raise PackageError('切换后正式 qb_dataset_meta 未指向新批次')
            self._set_batch(bid, 'published', previous=outgoing, report=report)
            return {'pass': True, 'batch_id': bid, 'previous_batch_id': outgoing, 'report': report}
        except Exception as exc:
            self._rollback()
            if not switched:
                try:
                    self._set_batch(bid, 'failed', error=str(exc))
                    self._drop_exact_group('next', bid)
                except Exception:
                    pass
            raise
        finally:
            shutil.rmtree(verified.root, ignore_errors=True)
            self.release_lock()

    def rollback(self, request_batch: int) -> dict[str, Any]:  # noqa: PLR0912
        request_id = _batch_id(request_batch)
        self.acquire_lock()
        try:
            request = self._fetchone(f'SELECT * FROM {_qi("qb_sync_batch")} WHERE {_qi("batch_id")}=%s', (request_id,))
            if not request or request.get('batch_type') != 'rollback' or request.get('status') != 'publishing':
                raise PackageError('回退必须使用后端创建且处于 publishing 的 rollback 请求批次')
            target = int(request.get('restored_from_batch_id') or 0)
            if target <= 0:
                raise PackageError('rollback 请求缺少 restored_from_batch_id')
            meta = self._current_meta()
            if not meta:
                raise PackageError('没有正式数据集元数据')
            current = int(meta.get('current_batch_id') or 0)
            if current <= 0:
                raise PackageError('当前批次无效，拒绝回退')
            if target == current:
                raise PackageError('目标批次已经是当前批次，拒绝回退')
            old_tables = self._existing_group('old', target)
            if len(old_tables) == len(DATASET_TABLES):
                self._execute(
                    f'UPDATE {_qi(_old_name("qb_dataset_meta", target))} '
                    f'SET {_qi("current_batch_id")}=%s, {_qi("previous_batch_id")}=%s',
                    (request_id, current),
                )
                self._commit()
                self._reset_candidate_readiness(_old_name("qb_question", target))
                self._execute(build_rename_sql(current, request_id, rollback_from_old=target))
                self._commit()
            else:
                if old_tables:
                    raise PackageError('目标旧表组不完整，拒绝回退')
                batch = self._fetchone(f'SELECT * FROM {_qi("qb_sync_batch")} WHERE {_qi("batch_id")}=%s', (target,))
                if not batch or not batch.get('artifact_uri'):
                    raise PackageError('目标旧表不存在且无归档 artifact')
                verified = QbPkgVerifier().verify(batch['artifact_uri'])
                try:
                    report = self._build_candidate(request_id, verified)
                    if not report['pass']:
                        raise PackageError('归档 artifact 候选校验失败')
                    self._execute(
                        f'UPDATE {_qi(_next_name("qb_dataset_meta", request_id))} '
                        f'SET {_qi("previous_batch_id")}=%s WHERE {_qi("current_batch_id")}=%s',
                        (current, request_id),
                    )
                    self._commit()
                finally:
                    shutil.rmtree(verified.root, ignore_errors=True)
                self._reset_candidate_readiness(_next_name("qb_question", request_id))
                self._execute(build_rename_sql(current, request_id))
                self._commit()
            current_meta = self._current_meta()
            if not current_meta or int(current_meta.get('current_batch_id') or 0) != request_id:
                raise PackageError('回退切换后正式 qb_dataset_meta 未指向 rollback 请求')
            self._set_batch(request_id, 'rolled_back', previous=current, restored_from=target)
            return {
                'pass': True,
                'request_batch_id': request_id,
                'target_batch_id': target,
                'current_batch_id': request_id,
                'previous_batch_id': current,
            }
        finally:
            self.release_lock()

    def recover(self, batch_id: int | None = None) -> dict[str, Any]:
        self.acquire_lock()
        try:
            meta = self._current_meta()
            current = int(meta.get('current_batch_id') or 0) if meta else None
            candidates = (
                [int(batch_id)]
                if batch_id is not None
                else [
                    int(row['batch_id'])
                    for row in self._fetchall("SELECT batch_id FROM qb_sync_batch WHERE status='publishing'")
                ]
            )
            repaired: list[int] = []
            stale: list[int] = []
            for bid in candidates:
                row = self._fetchone('SELECT batch_type,status FROM qb_sync_batch WHERE batch_id=%s', (bid,))
                if not row:
                    continue
                if current == bid:
                    repaired_status = 'rolled_back' if row.get('batch_type') == 'rollback' else 'published'
                    self._set_batch(bid, repaired_status)
                    repaired.append(bid)
                elif len(self._existing_group('next', bid)) == len(DATASET_TABLES):
                    stale.append(bid)
            return {'current_batch_id': current, 'repaired': repaired, 'stale_next': stale}
        finally:
            self.release_lock()

    def run_pending(self, *, limit: int = 10) -> dict[str, Any]:
        """Consume persisted publish/rollback requests for an external scheduler."""
        if limit < 1 or limit > MAX_PENDING_BATCHES:
            raise PackageError('待处理批次数量限制必须在 1 到 100 之间')
        rows = self._fetchall(
            "SELECT batch_id,batch_type FROM qb_sync_batch WHERE status='publishing' "
            'ORDER BY update_time,batch_id LIMIT %s',
            (limit,),
        )
        completed: list[int] = []
        failed: list[dict[str, Any]] = []
        for row in rows:
            batch_id = int(row['batch_id'])
            try:
                if row.get('batch_type') == 'rollback':
                    self.rollback(batch_id)
                else:
                    self.publish(batch_id)
                completed.append(batch_id)
            except Exception as exc:  # The next run may retry a recoverable request.
                failed.append({'batch_id': batch_id, 'error': str(exc)})
        return {'completed': completed, 'failed': failed}

    def cleanup(self, *, now: float | None = None, retain_seconds: int | None = None) -> dict[str, Any]:
        self.acquire_lock()
        try:
            meta = self._current_meta() or {}
            protected = {
                int(value)
                for value in (meta.get('current_batch_id'), meta.get('previous_batch_id'))
                if value not in (None, '')
            }
            groups = self._groups()
            unknown = []
            for row in self._fetchall('SHOW TABLES'):
                name = str(next(iter(row.values())))
                if ('_old_' in name or '_next_' in name) and name.startswith('qb_'):
                    valid_name = bool(re.fullmatch(r'qb_[A-Za-z0-9_]+_(?:old|next)_[0-9]+', name))
                    if not valid_name or not any(name in values for values in groups.values()):
                        unknown.append(name)
            if unknown:
                return {'deleted': [], 'reported': [f'unknown:{name}' for name in sorted(unknown)], 'stopped': True}
            incomplete = [key for key, values in groups.items() if len(values) != len(DATASET_TABLES)]
            if incomplete:
                return {
                    'deleted': [],
                    'reported': [f'incomplete:{kind}:{bid}' for kind, bid in incomplete],
                    'stopped': True,
                }
            deleted: list[str] = []
            cutoff = (now if now is not None else time.time()) - (
                retain_seconds if retain_seconds is not None else self.config.stale_after_seconds
            )
            for (kind, bid), names in groups.items():
                if kind not in {'old', 'next'} or bid in protected:
                    continue
                batch = self._fetchone(
                    f'SELECT artifact_uri,artifact_sha256,status,published_at,archived_at,update_time FROM {_qi("qb_sync_batch")} WHERE {_qi("batch_id")}=%s',
                    (bid,),
                )
                if not batch or not batch.get('artifact_uri') or not batch.get('artifact_sha256'):
                    continue
                if kind == 'next' and batch.get('status') in {
                    'building',
                    'validating',
                    'validated',
                    'approval_pending',
                    'approved',
                    'publishing',
                }:
                    continue
                artifact = Path(batch['artifact_uri'])
                if not artifact.is_file() or _sha256_file(artifact) != str(batch['artifact_sha256']).lower():
                    continue
                timestamp = batch.get('archived_at') or batch.get('published_at') or batch.get('update_time')
                if not timestamp or self._timestamp(timestamp) > cutoff:
                    continue
                ordered_names = sorted(names)
                self._execute('DROP TABLE ' + ', '.join(_qi(name) for name in ordered_names))
                deleted.extend(ordered_names)
                self._commit()
            return {'deleted': deleted, 'reported': [], 'stopped': False}
        finally:
            self.release_lock()

    @staticmethod
    def _timestamp(value: Any) -> float:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.timestamp()
        try:
            return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
        except ValueError:
            return time.time()

    def _set_batch(
        self,
        bid: int,
        status: str,
        *,
        error: str | None = None,
        previous: int | None = None,
        restored_from: int | None = None,
        report: Any = None,
    ) -> None:
        updates = [f'{_qi("status")}=%s', f'{_qi("update_time")}=NOW()']
        values: list[Any] = [status]
        if error is not None:
            updates.append(f'{_qi("error_message")}=%s')
            values.append(error[:2000])
        if previous is not None:
            updates.append(f'{_qi("previous_batch_id")}=%s')
            values.append(previous or None)
        if restored_from is not None:
            updates.append(f'{_qi("restored_from_batch_id")}=%s')
            values.append(restored_from)
        if report is not None:
            updates.append(f'{_qi("validation_report_json")}=%s')
            values.append(json.dumps(report, ensure_ascii=False, separators=(',', ':')))
        if status == 'publishing':
            updates.append(f'{_qi("started_at")}=NOW()')
        if status == 'validated':
            updates.append(f'{_qi("validated_at")}=NOW()')
        if status == 'published':
            updates.append(f'{_qi("published_at")}=NOW()')
        self._execute(
            f'UPDATE {_qi("qb_sync_batch")} SET {", ".join(updates)} WHERE {_qi("batch_id")}=%s', (*values, bid)
        )
        self._commit()

    def _current_meta(self) -> Mapping[str, Any] | None:
        return self._fetchone(f'SELECT * FROM {_qi("qb_dataset_meta")} ORDER BY update_time DESC LIMIT 1')

    def _existing_group(self, kind: str, bid: int) -> list[str]:
        suffix = f'_{kind}_{_batch_id(bid)}'
        names = []
        for row in self._fetchall('SHOW TABLES'):
            name = str(next(iter(row.values())))
            if name.endswith(suffix) and name.rsplit(suffix, 1)[0] in DATASET_TABLES:
                names.append(name)
        return names

    def _groups(self) -> dict[tuple[str, int], list[str]]:
        groups: dict[tuple[str, int], list[str]] = {}
        pattern = re.compile(
            r'^(qb_(?:textbook_version|textbook|catalog_node|question|question_catalog|question_tag|question_asset|dataset_meta))_(old|next)_([0-9]+)$'
        )
        for row in self._fetchall('SHOW TABLES'):
            name = str(next(iter(row.values())))
            match = pattern.fullmatch(name)
            if match:
                if match.group(2) == 'next' and int(match.group(3)) <= 0:
                    continue
                key = (match.group(2), int(match.group(3)))
                groups.setdefault(key, []).append(name)
        return groups

    def _drop_exact_group(self, kind: str, bid: int) -> None:
        names = self._existing_group(kind, bid)
        if names:
            self._execute('DROP TABLE ' + ', '.join(_qi(name) for name in sorted(names)))
            self._commit()

    def _table_exists(self, name: str) -> bool:
        return bool(self._fetchone('SHOW TABLES LIKE %s', (name,)))

    def _reset_candidate_readiness(self, table: str) -> None:
        # Derived facts stay outside the atomic dataset table group. Reset
        # revisions BEFORE RENAME, including pre-migration rollback tables,
        # so reused IDs cannot inherit facts from another dataset.
        if not re.fullmatch(r'qb_question_(?:next|old)_[0-9]+', table):
            raise PackageError('无效的题干检查候选表')
        if not self._table_exists('qb_question_readiness'):
            return  # Compatibility with the pre-readiness standalone schema.
        columns = self._fetchall(f'SHOW COLUMNS FROM {_qi(table)}')
        if not any(row.get('Field') == 'readiness_revision' for row in columns):
            self._execute(f'ALTER TABLE {_qi(table)} ADD COLUMN readiness_revision CHAR(32) NULL')
        self._execute(f'UPDATE {_qi(table)} SET readiness_revision=NULL')
        self._commit()

    def _build_candidate(self, bid: int, package: VerifiedPackage) -> dict[str, Any]:
        next_names = {base: _next_name(base, bid) for base in DATASET_TABLES}
        for name in next_names.values():
            if self._table_exists(name):
                raise PackageError(f'候选表已存在，拒绝覆盖: {name}')
        for base, target in next_names.items():
            self._execute(f'CREATE TABLE {_qi(target)} LIKE {_qi(base)}')
        try:
            return self._load_candidate(bid, package, next_names)
        except Exception:
            self._rollback()
            self._drop_exact_group('next', bid)
            raise

    def _load_candidate(self, bid: int, package: VerifiedPackage, names: Mapping[str, str]) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
        db = sqlite3.connect(f'file:{package.snapshot}?mode=ro', uri=True)
        db.row_factory = sqlite3.Row
        provider = str(package.manifest['sourceProvider'])
        now = datetime.now(timezone.utc).replace(tzinfo=None).strftime('%Y-%m-%d %H:%M:%S')
        try:
            maps: dict[str, dict[str, int]] = {key: {} for key in ('version', 'textbook', 'catalog', 'question')}
            for target in ('qb_textbook_version', 'qb_textbook', 'qb_catalog_node', 'qb_question'):
                self._execute(f'INSERT INTO {_qi(names[target])} SELECT * FROM {_qi(target)}')
            # A full package replaces only its own provider.  Manual data and
            # data imported by other providers stay visible in the candidate.
            self._deactivate_provider_rows(names, provider)
            for row in self._fetchall(
                f'SELECT source_provider,external_version_id,version_id FROM {_qi(names["qb_textbook_version"])} WHERE subject_id=1'
            ):
                if row['external_version_id'] is not None:
                    maps['version'][f'{row["source_provider"]}\0{row["external_version_id"]}'] = int(row['version_id'])
            for row in self._fetchall(
                f'SELECT source_provider,external_textbook_id,textbook_id FROM {_qi(names["qb_textbook"])} WHERE subject_id=1'
            ):
                if row['external_textbook_id'] is not None:
                    maps['textbook'][f'{row["source_provider"]}\0{row["external_textbook_id"]}'] = int(
                        row['textbook_id']
                    )
            for row in self._fetchall(
                f'SELECT source_provider,external_node_id,catalog_id FROM {_qi(names["qb_catalog_node"])} WHERE subject_id=1'
            ):
                if row['external_node_id'] is not None:
                    maps['catalog'][f'{row["source_provider"]}\0{row["external_node_id"]}'] = int(row['catalog_id'])
            for row in self._fetchall(
                f'SELECT source_provider,external_question_id,question_id FROM {_qi(names["qb_question"])} WHERE subject_id=1'
            ):
                if row['external_question_id'] is not None:
                    maps['question'][f'{row["source_provider"]}\0{row["external_question_id"]}'] = int(
                        row['question_id']
                    )
            # Identity rows are upserted in dependency order, preserving local IDs.
            for row in db.execute('SELECT * FROM qb_textbook_version'):
                key = f'{row["provider"]}\0{row["external_id"]}'
                local = maps['version'].get(key)
                status = '0'
                values = (
                    row['provider'],
                    row['external_id'],
                    row['version_name'],
                    row['source_url'],
                    _yes_no(row['metadata_json'], 'is_new'),
                    0,
                    status,
                    bid,
                    None,
                    now,
                    now,
                )
                columns = 'source_provider,external_version_id,version_name,source_url,is_new,sort_order,status,last_sync_batch_id,last_seen_at,create_time,update_time'
                if local:
                    self._update_by_id(names['qb_textbook_version'], 'version_id', local, columns, values)
                else:
                    maps['version'][key] = self._insert_returning_id(names['qb_textbook_version'], columns, values)
            for row in db.execute('SELECT * FROM qb_textbook'):
                key = f'{row["provider"]}\0{row["external_id"]}'
                local = maps['textbook'].get(key)
                version_id = maps['version'].get(f'{row["provider"]}\0{row["version_external_id"]}')
                if not version_id:
                    raise PackageError(f'教材引用未知版本: {row["external_id"]}')
                status = '0'
                values = (
                    version_id,
                    row['provider'],
                    row['external_id'],
                    row['textbook_name'],
                    row['grade'],
                    row['volume'],
                    row['source_url'],
                    0,
                    status,
                    bid,
                    None,
                    now,
                    now,
                )
                columns = 'version_id,source_provider,external_textbook_id,textbook_name,grade,volume,source_url,sort_order,status,last_sync_batch_id,last_seen_at,create_time,update_time'
                if local:
                    self._update_by_id(names['qb_textbook'], 'textbook_id', local, columns, values)
                else:
                    maps['textbook'][key] = self._insert_returning_id(names['qb_textbook'], columns, values)
            catalog_rows = list(
                db.execute('SELECT * FROM qb_catalog_node ORDER BY COALESCE(node_level, 999), external_id')
            )
            pending = catalog_rows[:]
            while pending:
                progress = False
                remaining = []
                for row in pending:
                    textbook_id = (
                        maps['textbook'].get(f'{row["provider"]}\0{row["textbook_external_id"]}')
                        if row['textbook_external_id']
                        else None
                    )
                    parent = (
                        maps['catalog'].get(f'{row["provider"]}\0{row["parent_external_id"]}')
                        if row['parent_external_id']
                        else None
                    )
                    if row['textbook_external_id'] and not textbook_id:
                        raise PackageError(f'目录引用未知教材: {row["external_id"]}')
                    if row['parent_external_id'] and not parent:
                        remaining.append(row)
                        continue
                    key = f'{row["provider"]}\0{row["external_id"]}'
                    local = maps['catalog'].get(key)
                    status = '0' if row['active'] in (1, True, '1') else '1'
                    values = (
                        textbook_id,
                        parent,
                        row['provider'],
                        row['external_id'],
                        row['name'],
                        row['node_type'] or 'other',
                        row['source_path'],
                        0,
                        status,
                        bid,
                        None,
                        now,
                        now,
                    )
                    columns = 'textbook_id,parent_id,source_provider,external_node_id,node_name,node_type,source_url,sort_order,status,last_sync_batch_id,last_seen_at,create_time,update_time'
                    if local:
                        self._update_by_id(names['qb_catalog_node'], 'catalog_id', local, columns, values)
                    else:
                        maps['catalog'][key] = self._insert_returning_id(names['qb_catalog_node'], columns, values)
                    progress = True
                if not progress:
                    raise PackageError('目录父外部 ID 无法解析')
                pending = remaining
            for row in db.execute('SELECT * FROM qb_question'):
                key = f'{row["provider"]}\0{row["external_id"]}'
                local = maps['question'].get(key)
                values = self._question_values(row, bid, now)
                columns = 'source_provider,external_question_id,source_url,source_question_no,source_text,paper_name,academic_year,year,grade,term,province,exam_type,question_type,difficulty,difficulty_coefficient,content_html,plain_text,answer_html,analysis_html,answer_status,subquestion_count,external_updated_at,assemble_count,reference_count,reference_papers_json,is_fresh,content_hash,raw_data_json,last_sync_batch_id,last_seen_at,status,create_time,update_time'
                values = (row['provider'], row['external_id'], *values)
                if local:
                    self._update_by_id(names['qb_question'], 'question_id', local, columns, values)
                else:
                    maps['question'][key] = self._insert_returning_id(names['qb_question'], columns, values)
            # Relationship tables do not carry provider identity themselves.
            # Preserve rows belonging to manual/other-provider questions while
            # rebuilding the current provider's rows from the package below.
            self._copy_non_current_provider_relations(names, provider)
            self._load_relations(db, names, maps, bid, now)
            self._load_tags(db, names, maps, bid, now)
            self._load_assets(db, package.root, names, maps, bid, now, provider)
            self._execute(f'INSERT INTO {_qi(names["qb_dataset_meta"])} SELECT * FROM {_qi("qb_dataset_meta")}')
            scope = (
                package.manifest.get('dataset', {}).get('scopeKey')
                or f'{provider}:{package.manifest["dataset"].get("versionExternalId", "")}:{package.manifest["dataset"].get("textbookExternalId", "")}'
            )
            self._upsert_meta(names['qb_dataset_meta'], scope, provider, bid, package.manifest, now)
            self._commit()
            return self._validate_candidate(bid, names, package.manifest, scope)
        finally:
            db.close()

    def _deactivate_provider_rows(self, names: Mapping[str, str], provider: str) -> None:
        """Deactivate missing identity rows without touching other providers."""
        for target in ('qb_textbook_version', 'qb_textbook', 'qb_catalog_node', 'qb_question'):
            self._execute(
                f"UPDATE {_qi(names[target])} SET status='1' WHERE source_provider=%s AND subject_id=1",
                (provider,),
            )

    def _copy_non_current_provider_relations(self, names: Mapping[str, str], provider: str) -> None:
        """Copy manual/other-provider relations before loading this package."""
        for relation in ('qb_question_catalog', 'qb_question_tag', 'qb_question_asset'):
            self._execute(
                f'INSERT INTO {_qi(names[relation])} SELECT r.* FROM {_qi(relation)} r '
                f'JOIN {_qi("qb_question")} q ON q.question_id=r.question_id WHERE (q.source_provider<>%s OR q.subject_id<>1)',
                (provider,),
            )

    @staticmethod
    def _question_values(row: Mapping[str, Any], bid: int, now: str) -> tuple[Any, ...]:
        year = str(row['year']).strip() if row['year'] is not None else None
        year_number = int(year) if year and re.fullmatch(r'[0-9]{1,4}', year) else None
        # source_short is the short text, while source_question_no is not
        # present in the snapshot contract and therefore remains NULL.
        status = '0' if row['active'] in (1, True, '1') else '1'
        answer_status = {
            'not_collected': 'unknown',
            'public_captured': 'available',
        }.get(str(row['answer_status']), 'unknown')
        return (
            row['detail_url'],
            None,
            row['source_short'],
            row['source_title'],
            None,
            year_number,
            None,
            None,
            row['region'],
            row['exam_type'],
            row['question_type'],
            row['difficulty_label'],
            row['ease_coefficient'],
            row['content_html'],
            row['plain_text'],
            row['answer_html'],
            row['solution_html'],
            answer_status,
            row['subquestion_count'],
            None,
            row['assemble_count'],
            None,
            None,
            _yes_no(row['is_new'], None),
            row['content_hash'],
            row['source_original_json'],
            bid,
            _mysql_datetime(row['last_seen_at']),
            status,
            now,
            now,
        )

    def _update_by_id(self, table: str, id_column: str, local: int, columns: str, values: tuple[Any, ...]) -> None:
        names = columns.split(',')
        assignments = ','.join(f'{_qi(name)}=%s' for name in names)
        self._execute(f'UPDATE {_qi(table)} SET {assignments} WHERE {_qi(id_column)}=%s', (*values, local))

    def _insert_returning_id(self, table: str, columns: str, values: tuple[Any, ...]) -> int:
        self._execute(
            f'INSERT INTO {_qi(table)} ({",".join(_qi(name) for name in columns.split(","))}) VALUES ({",".join(["%s"] * len(values))})',
            values,
        )
        row = self._fetchone('SELECT LAST_INSERT_ID() AS id')
        if not row:
            raise PackageError('无法取得新行本地主键')
        return int(next(iter(row.values())))

    def _load_relations(
        self,
        db: sqlite3.Connection,
        names: Mapping[str, str],
        maps: Mapping[str, Mapping[str, int]],
        bid: int,
        now: str,
    ) -> None:
        for row in db.execute('SELECT * FROM qb_question_catalog'):
            qid = maps['question'].get(f'{row["provider"]}\0{row["question_external_id"]}')
            cid = maps['catalog'].get(f'{row["provider"]}\0{row["catalog_external_id"]}')
            if not qid or not cid:
                raise PackageError('目录关系引用未知题目或目录')
            columns = 'question_id,catalog_id,relation_type,evidence_type,sort_order,last_sync_batch_id,last_seen_at,create_time,update_time'
            self._insert(
                names['qb_question_catalog'],
                columns,
                (
                    qid,
                    cid,
                    row['relation_type'],
                    row['evidence_type'],
                    0,
                    bid,
                    _mysql_datetime(row['observed_at']),
                    now,
                    now,
                ),
            )

    def _load_tags(
        self,
        db: sqlite3.Connection,
        names: Mapping[str, str],
        maps: Mapping[str, Mapping[str, int]],
        bid: int,
        now: str,
    ) -> None:
        for row in db.execute('SELECT * FROM qb_question_tag'):
            qid = maps['question'].get(f'{row["provider"]}\0{row["question_external_id"]}')
            if not qid:
                raise PackageError('标签关系引用未知题目')
            columns = 'question_id,tag_type,tag_name,evidence_type,sort_order,last_sync_batch_id,last_seen_at,create_time,update_time'
            self._insert(
                names['qb_question_tag'],
                columns,
                (
                    qid,
                    row['dimension'],
                    row['tag_value'],
                    row['evidence_type'],
                    0,
                    bid,
                    _mysql_datetime(row['observed_at']),
                    now,
                    now,
                ),
            )

    def _load_assets(
        self,
        db: sqlite3.Connection,
        root: Path,
        names: Mapping[str, str],
        maps: Mapping[str, Mapping[str, int]],
        bid: int,
        now: str,
        provider: str,
    ) -> None:
        self.config.asset_root.mkdir(parents=True, exist_ok=True)
        for row in db.execute('SELECT * FROM qb_question_asset'):
            qid = maps['question'].get(f'{row["provider"]}\0{row["question_external_id"]}')
            if not qid:
                raise PackageError('素材关系引用未知题目')
            storage = None
            status = 'pending'
            file_hash = row['content_sha256']
            if file_hash and HEX64_RE.fullmatch(str(file_hash)):
                hash_hex = str(file_hash).lower()
                relative = str(row['storage_path'] or '')
                source = (root / relative).resolve() if relative.startswith('assets/') else None
                if source and root not in source.parents:
                    raise PackageError('素材包路径越界')
                if source and source.is_file() and _sha256_file(source) == hash_hex:
                    suffix = source.suffix.lower()[:10]
                    destination = self.config.asset_root / hash_hex[:2] / f'{hash_hex}{suffix}'
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if destination.exists() and _sha256_file(destination) != str(file_hash).lower():
                        raise PackageError('内容寻址素材冲突')
                    if not destination.exists():
                        shutil.copyfile(source, destination)
                    storage = str(destination.relative_to(self.config.asset_root))
                    status = 'ready'
                elif source:
                    raise PackageError(f'素材内容校验失败: {relative}')
            columns = 'question_id,source_provider,asset_key,asset_type,source_url,storage_path,mime_type,file_hash,sort_order,download_status,last_sync_batch_id,last_seen_at,create_time,update_time'
            self._insert(
                names['qb_question_asset'],
                columns,
                (
                    qid,
                    provider,
                    row['asset_key'],
                    row['asset_type'],
                    row['source_url'],
                    storage,
                    row['mime_type'],
                    file_hash,
                    0,
                    status,
                    bid,
                    _mysql_datetime(row['observed_at']),
                    now,
                    now,
                ),
            )

    def _insert(self, table: str, columns: str, values: tuple[Any, ...]) -> None:
        self._execute(
            f'INSERT INTO {_qi(table)} ({",".join(_qi(name) for name in columns.split(","))}) VALUES ({",".join(["%s"] * len(values))})',
            values,
        )

    def _upsert_meta(
        self, table: str, scope: str, provider: str, bid: int, manifest: Mapping[str, Any], now: str
    ) -> None:
        values = (
            scope,
            provider,
            bid,
            None,
            str(manifest['schemaVersion']),
            str(manifest['snapshotSha256']),
            now,
            now,
            now,
        )
        columns = 'scope_key,source_provider,current_batch_id,previous_batch_id,schema_version,dataset_hash,published_at,create_time,update_time'
        quoted = ','.join(_qi(name) for name in columns.split(','))
        self._execute(
            f'INSERT INTO {_qi(table)} ({quoted}) VALUES ({",".join(["%s"] * len(values))}) ON DUPLICATE KEY UPDATE source_provider=VALUES(source_provider),current_batch_id=VALUES(current_batch_id),schema_version=VALUES(schema_version),dataset_hash=VALUES(dataset_hash),published_at=VALUES(published_at),update_time=VALUES(update_time)',
            values,
        )

    def _validate_candidate(
        self, bid: int, names: Mapping[str, str], manifest: Mapping[str, Any], scope: str
    ) -> dict[str, Any]:
        report: dict[str, Any] = {'pass': True, 'blocking': [], 'counts': {}}
        provider = str(manifest['sourceProvider'])
        for base in SNAPSHOT_TABLES:
            active_clause = (
                f" WHERE {_qi('status')}='0' AND {_qi('source_provider')}=%s AND subject_id=1"
                if base in {'qb_textbook_version', 'qb_textbook', 'qb_catalog_node', 'qb_question'}
                else ''
            )
            args: tuple[Any, ...] = (provider,) if active_clause else ()
            if base in {'qb_question_catalog', 'qb_question_tag', 'qb_question_asset'}:
                count_sql = (
                    f'SELECT COUNT(*) AS n FROM {_qi(names[base])} r JOIN {_qi(names["qb_question"])} q '
                    f"ON q.question_id=r.question_id WHERE q.source_provider=%s AND q.subject_id=1 AND q.status='0'"
                )
                row = self._fetchone(count_sql, (provider,))
            else:
                row = self._fetchone(f'SELECT COUNT(*) AS n FROM {_qi(names[base])}{active_clause}', args)
            count = int(row['n'])
            report['counts'][base] = count
            if base in manifest.get('counts', {}) and count != int(manifest['counts'][base]):
                report['blocking'].append(f'count:{base}')
        checks = (
            (
                f'SELECT 1 FROM {_qi(names["qb_textbook_version"])} WHERE {_qi("external_version_id")} IS NOT NULL GROUP BY subject_id,{_qi("source_provider")},{_qi("external_version_id")} HAVING COUNT(*)>1 LIMIT 1',
                'duplicate:version',
            ),
            (
                f'SELECT 1 FROM {_qi(names["qb_textbook"])} WHERE {_qi("external_textbook_id")} IS NOT NULL GROUP BY subject_id,{_qi("source_provider")},{_qi("external_textbook_id")} HAVING COUNT(*)>1 LIMIT 1',
                'duplicate:textbook',
            ),
            (
                f'SELECT 1 FROM {_qi(names["qb_catalog_node"])} WHERE {_qi("external_node_id")} IS NOT NULL GROUP BY subject_id,{_qi("source_provider")},{_qi("external_node_id")} HAVING COUNT(*)>1 LIMIT 1',
                'duplicate:catalog',
            ),
            (
                f'SELECT 1 FROM {_qi(names["qb_question"])} WHERE {_qi("external_question_id")} IS NOT NULL GROUP BY subject_id,{_qi("source_provider")},{_qi("external_question_id")} HAVING COUNT(*)>1 LIMIT 1',
                'duplicate:question',
            ),
            (
                f'SELECT 1 FROM {_qi(names["qb_question_catalog"])} r LEFT JOIN {_qi(names["qb_question"])} q ON q.question_id=r.question_id LEFT JOIN {_qi(names["qb_catalog_node"])} c ON c.catalog_id=r.catalog_id WHERE q.question_id IS NULL OR c.catalog_id IS NULL LIMIT 1',
                'orphan:relation',
            ),
            (
                f'SELECT 1 FROM {_qi(names["qb_question_tag"])} r LEFT JOIN {_qi(names["qb_question"])} q ON q.question_id=r.question_id WHERE q.question_id IS NULL LIMIT 1',
                'orphan:tag',
            ),
            (
                f'SELECT 1 FROM {_qi(names["qb_question_asset"])} r LEFT JOIN {_qi(names["qb_question"])} q ON q.question_id=r.question_id WHERE q.question_id IS NULL LIMIT 1',
                'orphan:asset',
            ),
            (
                (
                    f'SELECT 1 FROM {_qi(names["qb_question"])} '
                    f'WHERE source_provider=%s AND reference_count IS NOT NULL LIMIT 1'
                ),
                'reference_count',
            ),
        )
        for sql, code in checks:
            args = (provider,) if code == 'reference_count' else ()
            if self._fetchone(sql, args):
                report['blocking'].append(code)
        meta = self._fetchone(f'SELECT * FROM {_qi(names["qb_dataset_meta"])} WHERE scope_key=%s', (scope,))
        if (
            not meta
            or int(meta.get('current_batch_id') or 0) != bid
            or str(meta.get('dataset_hash')) != str(manifest['snapshotSha256'])
        ):
            report['blocking'].append('dataset_meta')
        report['pass'] = not report['blocking']
        return report


def _yes_no(value: Any, field: str | None) -> str | None:
    if field:
        try:
            parsed = json.loads(value or '{}')
            value = parsed.get(field)
        except (TypeError, json.JSONDecodeError):
            value = None
    if value in (1, True, '1', 'true', 'Y', 'y'):
        return 'Y'
    if value in (0, False, '0', 'false', 'N', 'n'):
        return 'N'
    return None


def _mysql_datetime(value: Any) -> str | None:
    """Normalize ISO timestamps from SQLite to MySQL DATETIME text."""
    if value in (None, ''):
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        except ValueError:
            # Do not invent a date for malformed source data.  The package
            # validator permits opaque timestamps, but MySQL DATETIME does not.
            return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed.strftime('%Y-%m-%d %H:%M:%S')


# Small compatibility aliases make the worker convenient to use from a
# scheduler without coupling callers to the implementation class name.
PackageVerifier = QbPkgVerifier
BankPublisher = MySQLPublisher
generate_rename_sql = build_rename_sql
