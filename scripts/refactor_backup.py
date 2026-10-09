"""Quiesced local refactor backup and restore into a separate scratch schema.

Run after stopping Service and Collector. Production endpoints are never read.
A snapshot contains MySQL, SQLite, assets and browser profile files; treat it as
private data. Redis caches are rebuilt on restart, not restored into active keys.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[1]
COMPOSE=['docker','compose','-f',str(ROOT/'deploy/refactor/docker-compose.yml')]
RUNTIME=ROOT/'.codex/refactor-runtime'


def mysql(args, **kwargs):
    return subprocess.run([*COMPOSE,'exec','-T','-e','MYSQL_PWD=refactor-local-root','mysql','mysql',*args],check=True,**kwargs)


def backup(destination):
    destination=destination.resolve()
    if destination.exists():
        raise SystemExit('目标已经存在，请选择新文件')
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='lesson-backup-') as temporary:
        stage=Path(temporary)
        with (stage/'database.sql').open('wb') as stream:
            subprocess.run([*COMPOSE,'exec','-T','-e','MYSQL_PWD=refactor-local-root','mysql','mysqldump',
                '-uroot','--single-transaction','--routines','--triggers','--hex-blob','--no-tablespaces','lesson_refactor'],stdout=stream,check=True)
        # MySQL container entrypoint accepts mysqldump directly; SQLite backup
        # folds WAL contents into standalone database files.
        shutil.copytree(RUNTIME,stage/'runtime',ignore=shutil.ignore_patterns('*.sqlite3-wal','*.sqlite3-shm','*.sqlite-wal','*.sqlite-shm','*.sock'))
        for source in RUNTIME.rglob('*.sqlite3'):
            target=stage/'runtime'/source.relative_to(RUNTIME)
            target.unlink(missing_ok=True)
            with sqlite3.connect(source) as reader,sqlite3.connect(target) as writer:
                reader.backup(writer)
        metadata={'format':1,'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'workingTreeModified':bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT)),
            'sqlSha256':hashlib.sha256((stage/'database.sql').read_bytes()).hexdigest()}
        (stage/'metadata.json').write_text(json.dumps(metadata,ensure_ascii=False))
        temporary_output=destination.with_name(destination.name+'.tmp')
        try:
            with tarfile.open(temporary_output,'w:gz') as archive:
                for name in ('database.sql','runtime','metadata.json'):
                    archive.add(stage/name,arcname=name)
            temporary_output.chmod(0o600)
            os.replace(temporary_output,destination)
        finally:
            temporary_output.unlink(missing_ok=True)
    print(f'已备份：{destination}')


def restore(source, schema, destination):
    if not re.fullmatch(r'lesson_refactor_restore(?:_[a-z0-9]+)?',schema):
        raise SystemExit('仅允许恢复到 lesson_refactor_restore 或其测试后缀库')
    if destination.exists():
        raise SystemExit('恢复运行目录必须尚不存在')
    with tempfile.TemporaryDirectory(prefix='lesson-restore-') as temporary:
        stage=Path(temporary)
        with tarfile.open(source,'r:gz') as archive:
            archive.extractall(stage,filter='data')
        metadata=json.loads((stage/'metadata.json').read_text())
        if hashlib.sha256((stage/'database.sql').read_bytes()).hexdigest()!=metadata['sqlSha256']:
            raise SystemExit('数据库备份摘要不一致')
        # CREATE (without IF NOT EXISTS) deliberately refuses to overwrite a
        # previous restore or the running isolated primary database.
        mysql(['-uroot','-e',f'CREATE DATABASE `{schema}` CHARACTER SET utf8mb4'])
        with (stage/'database.sql').open('rb') as stream:
            mysql(['-uroot',schema],stdin=stream)
        shutil.copytree(stage/'runtime',destination)
    print(f'已恢复：{schema}；运行目录：{destination}')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--quiesced',action='store_true',required=True,help='确认隔离 Service/Collector 已停止写入')
    sub=parser.add_subparsers(dest='action',required=True)
    save=sub.add_parser('backup');save.add_argument('destination',type=Path)
    load=sub.add_parser('restore');load.add_argument('source',type=Path);load.add_argument('--schema',default='lesson_refactor_restore');load.add_argument('--runtime',type=Path,required=True)
    args=parser.parse_args()
    if args.action=='backup':backup(args.destination)
    else:restore(args.source,args.schema,args.runtime)
