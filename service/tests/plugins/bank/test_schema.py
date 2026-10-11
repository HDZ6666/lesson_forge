from __future__ import annotations

import re
from pathlib import Path

import pytest

from plugins.core.discovery.scanner import PluginScanner

BANK_ROOT = Path(__file__).resolve().parents[3] / 'plugins' / 'bank'
MIGRATION = BANK_ROOT / 'migrations' / 'mysql' / '001_init.sql'
SEED = BANK_ROOT / 'seeds' / 'mysql' / '001_dict.sql'
FRONTEND_BANK_ROOT = BANK_ROOT.parents[1].parent / 'pc' / 'plugins' / 'bank'

TABLES = (
    'qb_textbook_version',
    'qb_textbook',
    'qb_catalog_node',
    'qb_question',
    'qb_question_catalog',
    'qb_question_tag',
    'qb_question_asset',
    'qb_sync_batch',
    'qb_dataset_meta',
)
TABLE_COUNT = len(TABLES)
SYNC_CENTER_ORDER = 7
SYNC_TEXTBOOK_ORDER = 8
SYNC_QUESTION_ORDER = 9


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def table_block(sql: str, table: str) -> str:
    match = re.search(
        rf'CREATE TABLE IF NOT EXISTS {re.escape(table)}\s*\((.*?)\) ENGINE=InnoDB',
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    assert match, f'missing table block: {table}'
    return match.group(1)


def test_bank_manifest_is_mysql_only_and_references_real_resources() -> None:
    plugin = PluginScanner(BANK_ROOT.parent).load_manifest(BANK_ROOT / 'plugin.yaml')

    assert plugin.manifest.id == 'bank'
    assert plugin.manifest.manifest_version == 1
    assert plugin.manifest.backend.module == 'plugins.bank'
    assert plugin.manifest.backend.routers.auto_scan is True
    assert plugin.manifest.backend.migrations == [
        'migrations/mysql/001_init.sql',
        'migrations/mysql/002_sync_review.sql',
        'migrations/mysql/003_sync_job.sql',
        'migrations/mysql/004_sync_job_compat.py',
        'migrations/mysql/005_sync_job_v2.py',
        'migrations/mysql/006_sync_task_modules.py',
        'migrations/mysql/007_sync_task_delete.py',
        'migrations/mysql/008_textbook_apply.py',
        'migrations/mysql/009_question_apply.py',
        'migrations/mysql/010_question_resume.py',
        'migrations/mysql/011_remove_local_collector_options.py',
        'migrations/mysql/012_question_task_review.sql',
        'migrations/mysql/013_subject_scope.py',
        'migrations/mysql/014_incremental_import.sql',
        'migrations/mysql/015_snapshot_lock_precision.py',
        'migrations/mysql/016_import_preparation.py',
        'migrations/mysql/017_import_intake.sql',
        'migrations/mysql/018_run_coverage.py',
        'migrations/mysql/019_question_readiness.py',
        'migrations/mysql/020_sync_dispatch.py',
        'migrations/mysql/021_sync_plans_and_issues.py',
        'migrations/mysql/022_sync_plan_names.py',
        'migrations/mysql/023_plan_concurrency.py',
        'migrations/mysql/024_plan_workflow.py',
        'migrations/mysql/025_catalog_book_identity.py',
        'migrations/mysql/026_task_executions.py',
    ]
    assert plugin.manifest.backend.seeds == ['seeds/mysql/001_dict.sql']
    assert plugin.manifest.compatibility.databases == ['mysql']
    assert plugin.manifest.frontend.delivery.type == 'source'
    assert plugin.manifest.frontend.plugin_id == 'bank'
    assert (BANK_ROOT / plugin.manifest.backend.migrations[0]).is_file()
    assert (BANK_ROOT / plugin.manifest.backend.seeds[0]).is_file()
    assert not any('postgresql' in resource for resource in plugin.manifest.backend.migrations)
    assert not any('postgresql' in resource for resource in plugin.manifest.backend.seeds)


def test_bank_manifest_has_management_and_sync_menus_and_declared_permissions() -> None:
    plugin = PluginScanner(BANK_ROOT.parent).load_manifest(BANK_ROOT / 'plugin.yaml')
    root_menu = plugin.manifest.frontend.menus[0]
    children = root_menu.children
    permission_codes = set(plugin.manifest.permission_codes)

    assert root_menu.name == '题库管理'
    assert [menu.name for menu in children] == [
        '学科管理',
        '版本管理',
        '教材管理',
        '目录管理',
        '题目管理',
        '教材浏览',
        '发布批次',
        '同步中心',
        '同步教材',
        '同步题库',
    ]
    assert [menu.component for menu in children] == [
        'plugin/bank/subject/index',
        'plugin/bank/version/index',
        'plugin/bank/textbook/index',
        'plugin/bank/catalog/index',
        'plugin/bank/question-manage/index',
        'plugin/bank/browse/index',
        'plugin/bank/batch/index',
        'plugin/bank/sync/index',
        'plugin/bank/sync-textbook/index',
        'plugin/bank/sync-question/index',
    ]
    assert [menu.name for menu in plugin.manifest.frontend.menus[1].children] == ['同步总览', '学科计划', '教材发现', '教材任务']
    assert all(menu.visible == '1' for menu in children[-4:])
    assert children[-3].route_name == 'BankSyncCenter'
    assert children[-3].order_num == SYNC_CENTER_ORDER
    assert children[-2].route_name == 'BankSyncTextbookOverview'
    assert children[-2].order_num == SYNC_TEXTBOOK_ORDER
    assert children[-1].route_name == 'BankSyncQuestionOverview'
    assert children[-1].order_num == SYNC_QUESTION_ORDER
    assert {menu.perms for menu in children if menu.perms} <= permission_codes
    assert {
        'bank:version:list',
        'bank:browse:list',
        'bank:version:query',
        'bank:version:add',
        'bank:version:edit',
        'bank:version:remove',
        'bank:textbook:list',
        'bank:textbook:query',
        'bank:textbook:add',
        'bank:textbook:edit',
        'bank:textbook:remove',
        'bank:catalog:list',
        'bank:catalog:query',
        'bank:catalog:add',
        'bank:catalog:edit',
        'bank:catalog:remove',
        'bank:question:list',
        'bank:question:query',
        'bank:question:add',
        'bank:question:edit',
        'bank:question:remove',
        'bank:question:asset',
        'bank:asset:list',
        'bank:asset:query',
        'bank:batch:list',
        'bank:batch:query',
        'bank:batch:approve',
        'bank:batch:publish',
        'bank:batch:rollback',
        'bank:sync:version:list',
        'bank:sync:textbook:list',
        'bank:sync:catalog:list',
        'bank:sync:question:list',
        'bank:sync:review',
        'bank:sync:run',
        'bank:sync:center:list',
        'bank:sync:textbook:query',
        'bank:sync:textbook:add',
        'bank:sync:textbook:cancel',
        'bank:sync:textbook:retry',
        'bank:sync:textbook:remove',
        'bank:sync:question:query',
        'bank:sync:question:add',
        'bank:sync:question:cancel',
        'bank:sync:question:retry',
        'bank:sync:question:remove',
        'bank:sync:question:apply',
        'bank:sync:question:resume',
    } <= permission_codes
    assert {'bank:batch:approve', 'bank:batch:publish', 'bank:batch:rollback'} <= permission_codes


def test_bank_migration_has_exactly_nine_non_destructive_mysql_tables() -> None:
    sql = read(MIGRATION)
    assert len(re.findall(r'CREATE TABLE IF NOT EXISTS', sql, flags=re.IGNORECASE)) == TABLE_COUNT
    assert not re.search(r'\bDROP\s+TABLE\b|\bDROP\s+DATABASE\b', sql, flags=re.IGNORECASE)
    assert not re.search(r'\bFOREIGN\s+KEY\b|\bREFERENCES\b', sql, flags=re.IGNORECASE)
    assert set(re.findall(r'CREATE TABLE IF NOT EXISTS\s+(qb_[a-z_]+)', sql, flags=re.IGNORECASE)) == set(TABLES)
    assert sql.lower().count('engine=innodb') == TABLE_COUNT
    assert sql.lower().count('default charset=utf8mb4') == TABLE_COUNT
    assert "DEFAULT 'zujuan'" not in sql


def test_sync_review_migration_has_review_only_table_and_constraints() -> None:
    sql = read(BANK_ROOT / 'migrations' / 'mysql' / '002_sync_review.sql')
    block = table_block(sql, 'qb_sync_review')
    assert all(
        column in block
        for column in (
            'entity_type',
            'source_provider',
            'external_id',
            'staged_hash',
            'staged_data_json',
            'current_local_id',
            'comparison_status',
            'review_status',
            'review_comment',
            'reviewed_by',
            'reviewed_at',
            'create_time',
            'update_time',
        )
    )
    assert 'UNIQUE KEY uk_qb_sync_review_identity (entity_type, source_provider, external_id)' in block
    assert 'REFERENCES' not in sql.upper()


def test_textbook_apply_migration_matches_provider_scoped_audit_contract() -> None:
    source = read(BANK_ROOT / 'migrations' / 'mysql' / '008_textbook_apply.py')

    assert 'PRIMARY KEY (source_provider)' in source
    assert 'KEY idx_qb_textbook_apply_state_task (current_task_id)' in source
    assert 'KEY idx_qb_textbook_apply_state_run (current_metadata_run_id)' in source
    assert 'source_provider, create_time, update_time' in source
    assert "VALUES ('zujuan', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)" in source
    assert 'KEY idx_qb_textbook_apply_history_provider_time (source_provider, applied_at)' in source
    assert "CHECK (action IN ('apply', 'rollback', 'restore'))" in source
    state_sql = source.split('_STATE_SQL = """', 1)[1].split('"""', 1)[0]
    history_sql = source.split('_HISTORY_SQL = """', 1)[1].split('"""', 1)[0]
    assert 'FOREIGN KEY' not in state_sql.upper() + history_sql.upper()
    assert 'REFERENCES' not in state_sql.upper() + history_sql.upper()
    assert "ON DUPLICATE KEY UPDATE source_provider = VALUES(source_provider)" in source


def test_question_apply_migration_matches_scope_state_history_and_apply_permission_contract() -> None:
    source = read(BANK_ROOT / 'migrations' / 'mysql' / '009_question_apply.py')
    state_sql = source.split('_STATE_SQL = """', 1)[1].split('"""', 1)[0]
    history_sql = source.split('_HISTORY_SQL = """', 1)[1].split('"""', 1)[0]

    assert 'PRIMARY KEY (source_provider, external_textbook_id)' in state_sql
    assert 'current_task_id' in state_sql
    assert 'current_collector_run_id' in state_sql
    assert 'state_token' in state_sql
    assert 'KEY idx_qb_question_apply_state_task (current_task_id)' in state_sql
    assert 'KEY idx_qb_question_apply_state_run (current_collector_run_id)' in state_sql
    assert 'PRIMARY KEY (history_id)' in history_sql
    assert 'KEY idx_qb_question_apply_history_scope_time (source_provider, external_textbook_id, applied_at)' in history_sql
    assert 'KEY idx_qb_question_apply_history_task (source_provider, task_id)' in history_sql
    assert 'collector_run_id' in history_sql
    assert 'state_token' in history_sql
    assert "CHECK (action IN ('apply', 'rollback', 'restore'))" in history_sql
    assert 'FOREIGN KEY' not in (state_sql + history_sql).upper()
    assert 'REFERENCES' not in (state_sql + history_sql).upper()

    plugin = PluginScanner(BANK_ROOT.parent).load_manifest(BANK_ROOT / 'plugin.yaml')
    assert 'bank:sync:question:apply' in set(plugin.manifest.permission_codes)


def test_bank_core_external_id_uniques_include_provider_and_allow_nulls() -> None:
    sql = read(MIGRATION)
    expected_keys = {
        'qb_textbook_version': 'uk_qb_version_provider_external (source_provider, external_version_id)',
        'qb_textbook': 'uk_qb_textbook_provider_external (source_provider, external_textbook_id)',
        'qb_catalog_node': 'uk_qb_catalog_provider_external (source_provider, external_node_id)',
        'qb_question': 'uk_qb_question_provider_external (source_provider, external_question_id)',
    }
    for table, key in expected_keys.items():
        block = table_block(sql, table)
        external_column = key.split('external_')[-1].rstrip(')')
        assert re.search(
            rf'\bexternal_{external_column}\b\s+VARCHAR\([^)]*\)\s+DEFAULT NULL', block, flags=re.IGNORECASE
        )
        assert key in block
        assert re.search(r'source_provider\s+VARCHAR\([^)]*\)\s+NOT NULL(?!\s+DEFAULT)', block, flags=re.IGNORECASE)


def test_bank_question_and_relationship_fields_match_contract() -> None:
    sql = read(MIGRATION)
    question = table_block(sql, 'qb_question')

    for column in (
        'source_provider',
        'external_question_id',
        'source_question_no',
        'source_text',
        'paper_name',
        'academic_year',
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
        'last_sync_batch_id',
        'last_seen_at',
    ):
        assert re.search(rf'\b{column}\b', question), column
    assert re.search(r'difficulty_coefficient\s+DECIMAL\(6,4\)', question, flags=re.IGNORECASE)
    assert re.search(r'score\s+DECIMAL\(8,2\)', question, flags=re.IGNORECASE)
    assert re.search(r'content_html\s+LONGTEXT', question, flags=re.IGNORECASE)
    assert re.search(r'reference_papers_json\s+JSON', question, flags=re.IGNORECASE)
    assert re.search(r'raw_data_json\s+JSON', question, flags=re.IGNORECASE)

    relation = table_block(sql, 'qb_question_catalog')
    tag = table_block(sql, 'qb_question_tag')
    asset = table_block(sql, 'qb_question_asset')
    assert 'source_provider' not in relation and 'external_relation_id' not in relation
    assert 'UNIQUE KEY uk_qb_question_catalog (question_id, catalog_id, relation_type, evidence_type)' in relation
    assert 'query_catalog' in relation and 'knowledge' in relation
    assert 'query_membership' in relation and 'provider_asserted' in relation
    assert 'source_provider' not in tag and 'external_tag_id' not in tag
    assert 'UNIQUE KEY uk_qb_question_tag (question_id, tag_type, tag_name, evidence_type)' in tag
    assert 'evidence_type' in tag
    assert 'external_asset_id' not in asset
    assert re.search(r'source_provider\s+VARCHAR\([^)]*\)\s+NOT NULL(?!\s+DEFAULT)', asset, flags=re.IGNORECASE)
    assert 'UNIQUE KEY uk_qb_question_asset (question_id, asset_key)' in asset
    assert 'KEY idx_qb_question_asset_file_hash (file_hash)' in asset


def test_bank_sync_batch_and_dataset_meta_match_publish_contract() -> None:
    sql = read(MIGRATION)
    batch = table_block(sql, 'qb_sync_batch')
    dataset = table_block(sql, 'qb_dataset_meta')
    expected_batch_columns = (
        'batch_id',
        'batch_no',
        'batch_type',
        'source_provider',
        'schema_version',
        'artifact_uri',
        'artifact_sha256',
        'status',
        'previous_batch_id',
        'restored_from_batch_id',
        'question_count',
        'catalog_count',
        'tag_count',
        'asset_count',
        'validation_report_json',
        'diff_report_json',
        'error_message',
        'approved_by',
        'approved_at',
        'started_at',
        'validated_at',
        'published_at',
        'archived_at',
        'create_time',
        'update_time',
    )
    assert all(column in batch for column in expected_batch_columns)
    assert 'UNIQUE KEY uk_qb_sync_batch_no (batch_no)' in batch
    for old_column in (
        'external_batch_id',
        'scope_key',
        'batch_name',
        'item_count',
        'created_count',
        'updated_count',
        'skipped_count',
        'failed_count',
        'report_json',
        'metadata_json',
        'approval_status',
        'publish_status',
        'rollback_status',
    ):
        assert not re.search(rf'\b{old_column}\b\s+', batch)
    statuses = {
        'building',
        'validating',
        'validated',
        'approval_pending',
        'approved',
        'publishing',
        'published',
        'failed',
        'archived',
        'rolled_back',
    }
    status_check = re.search(r'status IN \(([^)]*)\)', batch)
    assert status_check
    assert set(re.findall(r"'([^']+)'", status_check.group(1))) == statuses
    assert "batch_type IN ('full', 'rollback')" in batch

    assert 'PRIMARY KEY (scope_key)' in dataset
    assert all(
        column in dataset
        for column in (
            'scope_key',
            'current_batch_id',
            'previous_batch_id',
            'schema_version',
            'dataset_hash',
            'published_at',
            'update_time',
        )
    )
    assert 'switched_at' not in dataset and 'hash_algorithm' not in dataset and 'metadata_json' not in dataset


def test_bank_seed_is_idempotent_and_uses_contract_values() -> None:
    seed = read(SEED)
    expected_dict_types = {
        'qb_volume',
        'qb_grade',
        'qb_term',
        'qb_catalog_node_type',
        'qb_question_type',
        'qb_difficulty',
        'qb_exam_type',
        'qb_answer_status',
        'qb_scene',
        'qb_category',
        'qb_exam_method',
        'qb_source_feature',
        'qb_asset_type',
        'qb_asset_status',
        'qb_batch_status',
    }
    assert expected_dict_types <= set(re.findall(r"'((?:qb)_[a-z_]+)'", seed))
    assert seed.upper().count('WHERE NOT EXISTS') >= len(expected_dict_types)
    assert 'INSERT INTO SYS_DICT_TYPE' in seed.upper() and 'INSERT INTO SYS_DICT_DATA' in seed.upper()
    assert not re.search(r'INSERT\s+INTO\s+qb_[a-z_]+', seed, flags=re.IGNORECASE)
    assert 'UNIQUE (dict_type' not in seed.lower() and 'alter table sys_dict_data' not in seed.lower()
    for value in (
        '上册',
        '下册',
        '六年级',
        '九年级',
        '上学期',
        '下学期',
        '单选题',
        '解答题',
        '容易',
        '适中',
        '困难',
        '单元测',
        '预习',
        '典型题',
        '运算化简',
        '名校',
    ):
        assert f"'{value}'" in seed
    for old_value in ('upper', 'lower', 'grade_6', 'single_choice', 'easy', 'unit_test', 'preview', 'typical'):
        assert f"'{old_value}'" not in seed
    batch_statuses = {
        'building',
        'validating',
        'validated',
        'approval_pending',
        'approved',
        'publishing',
        'published',
        'failed',
        'archived',
        'rolled_back',
    }
    batch_values = set(re.findall(r"SELECT\s+\d+,\s*'[^']+',\s*'([^']+)'\s*,\s*'qb_batch_status'", seed))
    assert batch_values == batch_statuses
    assert not {'pending', 'running', 'succeeded'} & batch_values


@pytest.mark.parametrize('view', ('version', 'textbook', 'catalog', 'question-manage', 'browse', 'batch', 'sync'))
def test_bank_page_views_exist(view: str) -> None:
    assert (FRONTEND_BANK_ROOT / 'views' / view / 'index.vue').is_file()


@pytest.mark.parametrize(
    'relative_path',
    (
        'plugin.yaml',
        'controller/__init__.py',
        'migrations/mysql/001_init.sql',
        'migrations/mysql/004_sync_job_compat.py',
        'migrations/mysql/005_sync_job_v2.py',
        'migrations/mysql/011_remove_local_collector_options.py',
        'seeds/mysql/001_dict.sql',
    ),
)
def test_bank_required_backend_files_are_inside_plugin(relative_path: str) -> None:
    assert (BANK_ROOT / relative_path).is_file()
