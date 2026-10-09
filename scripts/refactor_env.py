"""Run a development/test command with the refactor worktree's local settings.

Usage from the repository: python3 scripts/refactor_env.py -- <command> ...
The child runs in service/. No production dotenv files are loaded. Docker's
isolated MySQL/Redis can be started with deploy/refactor/docker-compose.yml.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def environment() -> dict[str, str]:
    runtime = ROOT / '.codex' / 'refactor-runtime'
    env = os.environ.copy()
    # Do not inherit database, collector, key or runtime configuration from
    # the caller. Every relevant application setting is explicit below.
    for key in list(env):
        if key.startswith(('APP_', 'DB_', 'REDIS_', 'BANK_', 'COLLECTOR_', 'SERVICE_', 'TRANSPORT_CRYPTO_', 'JWT_')):
            del env[key]
    env.update({
        'APP_ENV': 'dev', 'APP_HOST': '127.0.0.1', 'APP_PORT': '19099',
        'APP_ROOT_PATH': '', 'APP_RELOAD': 'false', 'APP_WORKERS': '1',
        'APP_DEFAULT_ENABLED_PLUGINS': 'bank,lesson',
        'DB_DEFAULT_SOURCE': 'primary',
        'DB_SOURCES': json.dumps({'primary': {
            'db_type': 'mysql', 'db_host': '127.0.0.1', 'db_port': 13316,
            'db_username': 'lesson_refactor', 'db_password': 'refactor-local-db',
            'db_database': 'lesson_refactor', 'db_echo': False,
            'db_connect_timeout': 3, 'db_pool_size': 5,
        }}),
        'REDIS_HOST': '127.0.0.1', 'REDIS_PORT': '16379',
        'REDIS_USERNAME': '', 'REDIS_PASSWORD': '', 'REDIS_DATABASE': '0',
        'BANK_COLLECTOR_URL': 'http://127.0.0.1:19110',
        'BANK_COLLECTOR_TOKEN': 'refactor-local-collector',
        'BANK_AUTO_SYNC_ENABLED': 'false',
        'BANK_AUTOMATIC_SYNC_ENABLED': '0',
        'BANK_ASSET_ROOT': str(runtime / 'bank'),
        'SERVICE_CACHE_ROOT': str(runtime / 'cache'),
        'SERVICE_STORAGE_ROOT': str(runtime / 'storage'),
        'SERVICE_LOG_ROOT': str(runtime / 'logs'),
        'COLLECTOR_DB': str(runtime / 'collector' / 'zujuan.sqlite3'),
        'COLLECTOR_DATA_DIR': str(runtime / 'collector' / 'data'),
        'COLLECTOR_PROFILE_DIR': str(runtime / 'collector' / 'profile'),
        'COLLECTOR_API_HOST': '127.0.0.1', 'COLLECTOR_API_PORT': '19110',
        'COLLECTOR_API_TOKEN': 'refactor-local-collector',
        'COLLECTOR_LIST_CONCURRENCY': '1', 'COLLECTOR_ASSET_CONCURRENCY': '2',
        'COLLECTOR_DELAY_MIN_MS': '4000', 'COLLECTOR_DELAY_MAX_MS': '6000',
        'TRANSPORT_CRYPTO_ENABLED': 'false', 'TRANSPORT_CRYPTO_MODE': 'off',
        'JWT_SECRET_KEY': 'refactor-local-only-not-for-production',
        'PYTHONPATH': str(ROOT / 'service'),
    })
    return env


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cwd', choices=('service', 'collector', 'pc', 'root'), default='service')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('provide a command after --')
    cwd = ROOT if args.cwd == 'root' else ROOT / args.cwd
    # The plugin manager requires dev mode. Refuse machine-local dotenv files
    # rather than risk them overriding the isolated settings above.
    if (ROOT / 'service' / '.env.dev').exists() or (ROOT / 'service' / '.env').exists():
        parser.error('isolated runner requires service/.env and service/.env.dev to be absent')
    raise SystemExit(subprocess.call(command, cwd=cwd, env=environment()))
