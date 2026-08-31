"""Read catalog crawl progress from collector SQLite.

The tree uses each node's own site total as the denominator and distinct
question IDs in that node plus descendants as the crawled numerator.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from plugins.bank.service.collector_sqlite import connect_collector_sqlite


def _unique_count(questions_by_catalog: dict[str, set[str]], ids: list[str]) -> int:
    seen: set[str] = set()
    for catalog_id in ids:
        seen.update(questions_by_catalog.get(catalog_id, ()))
    return len(seen)


def build_catalog_progress_tree(
    nodes: list[dict[str, Any]],
    memberships: list[dict[str, str]],
    stats: dict[str, dict[str, Any]],
    current_by_catalog: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    current_by_catalog = current_by_catalog or {}
    questions_by_catalog: dict[str, set[str]] = {}
    for row in memberships:
        catalog_id = str(row.get('catalogExternalId') or '')
        question_id = str(row.get('questionExternalId') or '')
        if not catalog_id or not question_id:
            continue
        questions_by_catalog.setdefault(catalog_id, set()).add(question_id)

    by_id = {str(node['externalId']): node for node in nodes}
    children_of: dict[str, list[str]] = {}
    for node in nodes:
        node_id = str(node['externalId'])
        parent_id = str(node['parentExternalId'] or '')
        children_of.setdefault(parent_id, []).append(node_id)

    descendant_cache: dict[str, list[str]] = {}

    def descendant_ids(node_id: str) -> list[str]:
        cached = descendant_cache.get(node_id)
        if cached is not None:
            return cached
        ids = [node_id]
        for child_id in children_of.get(node_id, []):
            ids.extend(descendant_ids(child_id))
        descendant_cache[node_id] = ids
        return ids

    def build_node(node_id: str) -> dict[str, Any]:
        node = by_id[node_id]
        stat = stats.get(node_id) or {}
        expected_total = stat.get('expectedTotal')
        expected_pages = stat.get('expectedPages')
        last_completed = int(stat.get('lastCompletedPage') or 0)
        return {
            'externalId': node_id,
            'name': node.get('name'),
            'level': int(node.get('level') or 0),
            'path': node.get('path') or node.get('name'),
            'parentExternalId': str(node['parentExternalId']) if node.get('parentExternalId') else None,
            'expectedTotal': None if expected_total is None else int(expected_total),
            'expectedPages': None if expected_pages is None else int(expected_pages),
            'lastCompletedPage': last_completed,
            'crawledUnique': _unique_count(questions_by_catalog, descendant_ids(node_id)),
            'current': current_by_catalog.get(node_id),
            'children': [build_node(child_id) for child_id in children_of.get(node_id, [])],
        }

    roots: list[dict[str, Any]] = []
    seen_root: set[str] = set()
    for node in nodes:
        node_id = str(node['externalId'])
        parent_id = str(node.get('parentExternalId') or '')
        if parent_id and parent_id in by_id:
            continue
        if node_id in seen_root:
            continue
        seen_root.add(node_id)
        roots.append(build_node(node_id))

    def walk_pages(items: list[dict[str, Any]], key: str) -> int:
        return sum(int(item.get(key) or 0) + walk_pages(item.get('children') or [], key) for item in items)

    pages_done = walk_pages(roots, 'lastCompletedPage')
    pages_total = walk_pages(roots, 'expectedPages')
    progress = None
    if pages_total > 0:
        progress = min(100.0, round(min(pages_done, pages_total) / pages_total * 1000) / 10)
    return {
        'questionUnique': _unique_count(
            questions_by_catalog,
            [str(node['externalId']) for node in nodes],
        ),
        'catalogCount': len(nodes),
        'pagesDone': pages_done,
        'pagesTotal': pages_total,
        'progressPercent': progress,
        'current': list(current_by_catalog.values()),
        'catalogs': roots,
        'available': True,
        'message': 'collector SQLite 可用',
    }


def read_catalog_progress_sync(path: Path) -> dict[str, Any]:  # noqa: PLR0912
    path = Path(path)
    empty = {
        'questionUnique': 0,
        'catalogCount': 0,
        'pagesDone': 0,
        'pagesTotal': 0,
        'progressPercent': None,
        'current': [],
        'catalogs': [],
        'available': False,
        'message': '',
    }
    if not path.is_file():
        empty['message'] = f'collector SQLite 不存在：{path}'
        return empty
    db: sqlite3.Connection | None = None
    try:
        db = connect_collector_sqlite(path)
        db.row_factory = sqlite3.Row
        tables = {row['name'] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'textbook_nodes' not in tables:
            empty['message'] = 'collector SQLite 缺少 textbook_nodes'
            return empty
        nodes = [
            {
                'externalId': str(row['external_id']),
                'parentExternalId': row['parent_external_id'],
                'level': row['node_level'],
                'name': row['name'],
                'path': row['name'],
            }
            for row in db.execute(
                'SELECT external_id, parent_external_id, node_level, name FROM textbook_nodes',
            )
        ]
        memberships: list[dict[str, str]] = []
        if 'question_catalog_memberships' in tables:
            memberships = [
                {
                    'catalogExternalId': str(row['catalog_external_id']),
                    'questionExternalId': str(row['question_external_id']),
                }
                for row in db.execute(
                    'SELECT catalog_external_id, question_external_id FROM question_catalog_memberships',
                )
            ]
        stats: dict[str, dict[str, Any]] = {}
        if 'catalog_list_stats' in tables:
            for row in db.execute(
                """SELECT catalog_external_id, expected_total, expected_pages, last_completed_page, updated_at
                   FROM catalog_list_stats ORDER BY updated_at DESC""",
            ):
                catalog_id = str(row['catalog_external_id'])
                if catalog_id in stats:
                    continue
                stats[catalog_id] = {
                    'expectedTotal': row['expected_total'],
                    'expectedPages': row['expected_pages'],
                    'lastCompletedPage': row['last_completed_page'],
                }
        current_by_catalog: dict[str, dict[str, Any]] = {}
        if 'sync_progress' in tables:
            for row in db.execute(
                """SELECT run_id, worker_id, catalog_external_id, catalog_name, catalog_path,
                          current_page, expected_pages, expected_total, updated_at
                   FROM sync_progress ORDER BY updated_at DESC""",
            ):
                if not row['catalog_external_id']:
                    continue
                catalog_id = str(row['catalog_external_id'])
                if catalog_id in current_by_catalog:
                    continue
                current_by_catalog[catalog_id] = {
                    'runId': row['run_id'],
                    'workerId': row['worker_id'],
                    'currentPage': row['current_page'],
                    'catalogName': row['catalog_name'],
                    'catalogPath': row['catalog_path'],
                }
        snapshot = build_catalog_progress_tree(nodes, memberships, stats, current_by_catalog)
        snapshot['available'] = True
        snapshot['message'] = 'collector SQLite 可用'
        return snapshot
    except sqlite3.Error as exc:
        empty['message'] = f'collector SQLite 读取失败：{exc}'
        return empty
    finally:
        if db is not None:
            db.close()
