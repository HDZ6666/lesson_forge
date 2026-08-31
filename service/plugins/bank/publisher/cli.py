"""Command line entry point for the bank publication worker.

Usage (from ``service``): ``python -m plugins.bank.publisher.cli verify ...``.
Database commands read connection options from ``BANK_MYSQL_*`` environment
variables unless explicitly supplied.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import pymysql

from .worker import MySQLPublisher, PackageError, PublisherConfig, verify_package


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='bank-publisher')
    sub = parser.add_subparsers(dest='command', required=True)
    verify = sub.add_parser('verify', help='验证 qbpkg')
    verify.add_argument('package', type=Path)
    register = sub.add_parser('register', help='注册 qbpkg 批次')
    _db_args(register)
    register.add_argument('package', type=Path)
    register.add_argument('--batch-id', type=int)
    register.add_argument('--batch-no')
    process = sub.add_parser('process', help='构建并验证候选表')
    _db_args(process)
    process.add_argument('batch_id', type=int)
    process.add_argument('package', type=Path)
    publish = sub.add_parser('publish', help='原子切换候选表')
    _db_args(publish)
    publish.add_argument('batch_id', type=int)
    publish.add_argument('--package', type=Path)
    rollback = sub.add_parser('rollback', help='热回退到历史批次')
    _db_args(rollback)
    rollback.add_argument('batch_id', type=int)
    recover = sub.add_parser('recover', help='恢复已切换但未更新状态的批次')
    _db_args(recover)
    recover.add_argument('--batch-id', type=int)
    pending = sub.add_parser('run-pending', help='消费管理端提交的发布和回退请求')
    _db_args(pending)
    pending.add_argument('--limit', type=int, default=10)
    cleanup = sub.add_parser('cleanup', help='清理过期且可验证的旧表')
    _db_args(cleanup)
    cleanup.add_argument('--retain-seconds', type=int)
    return parser


def _db_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--host', default=os.getenv('BANK_MYSQL_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.getenv('BANK_MYSQL_PORT', '3306')))
    parser.add_argument('--user', default=os.getenv('BANK_MYSQL_USER', 'root'))
    parser.add_argument('--password', default=os.getenv('BANK_MYSQL_PASSWORD', ''))
    parser.add_argument('--database', default=os.getenv('BANK_MYSQL_DATABASE', 'ruoyi'))
    parser.add_argument('--asset-root', type=Path, default=Path(os.getenv('BANK_ASSET_ROOT', './data/bank-assets')))


def _publisher(args: argparse.Namespace) -> MySQLPublisher:
    connection = pymysql.connect(
        host=args.host,
        port=args.port,
        user=args.user,
        password=args.password,
        database=args.database,
        charset='utf8mb4',
        autocommit=False,
        cursorclass=pymysql.cursors.DictCursor,
    )
    return MySQLPublisher(connection, PublisherConfig(asset_root=args.asset_root))


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == 'verify':
            package = verify_package(args.package)
            try:
                result = {'pass': True, 'manifest': package.manifest}
            finally:
                package.close()
        else:
            publisher = _publisher(args)
            try:
                if args.command == 'register':
                    result = {
                        'batch_id': publisher.register(args.package, batch_no=args.batch_no, batch_id=args.batch_id)
                    }
                elif args.command == 'process':
                    result = publisher.process(args.batch_id, args.package)
                elif args.command == 'publish':
                    result = publisher.publish(args.batch_id, args.package)
                elif args.command == 'rollback':
                    result = publisher.rollback(args.batch_id)
                elif args.command == 'recover':
                    result = publisher.recover(args.batch_id)
                elif args.command == 'run-pending':
                    result = publisher.run_pending(limit=args.limit)
                else:
                    result = publisher.cleanup(retain_seconds=args.retain_seconds)
            finally:
                publisher.connection.close()
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0
    except (PackageError, OSError, ValueError) as exc:
        print(json.dumps({'pass': False, 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())
