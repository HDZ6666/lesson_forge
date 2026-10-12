"""Incremental reader for concatenated gzip event members. Never reads question data."""
from __future__ import annotations

import collections
import json
import zlib
from pathlib import Path

# Docker named volumes used by the production compose file. Can be overridden
# by monitor --diagnostic-root when a host uses a different Docker data root.
DEFAULT_ROOTS = [
    '/var/lib/docker/volumes/lesson-forge-collector-data/_data/zujuan/diagnostics',
    '/var/lib/docker/volumes/lesson-forge-service-runtime/_data/logs/bank-events',
]
KEEP = {'resource_guard_triggered','source_cooldown_enter','source_manual_enter','source_manual_resume',
        'verification_detected','verification_wait_enter','verification_wait_failed','verification_api_recovered',
        'request_retry_scheduled','collector_api_aborted','intake_failed','intake_started','intake_execution_finished',
        'import_execution_started','import_execution_finished','import_deferred','stage_started','stage_finished'}


def read_members(path, offset, budget, consume=None):
    values = []
    start = offset
    with path.open('rb') as source:
        while offset-start < budget:
            source.seek(offset)
            data = source.read(min(256*1024,budget-(offset-start)))
            if not data:
                break
            block_start = offset
            while data:
                decoder = zlib.decompressobj(31)
                decoded = decoder.decompress(data,2*1024*1024)
                if not decoder.eof:
                    if len(decoded) >= 2*1024*1024:
                        raise ValueError('diagnostic_member_too_large')
                    break
                used = len(data)-len(decoder.unused_data)
                for line in decoded.decode().splitlines():
                    if line:
                        item=json.loads(line)
                        if consume is None:
                            values.append(item)
                        else:
                            consume(item)
                offset += used
                data=decoder.unused_data
            if offset == block_start:
                break  # Incomplete final member; retry its start next time.
    return values,offset


def collect_diagnostics(roots, cursors, *, budget=8*1024*1024):
    cursors = dict(cursors)
    result = {'events':[], 'counts':{}, 'errors':{}, 'pendingFiles':0, 'compressedLogBytes':0}
    counts = collections.Counter()
    def consume(item):
        kind=item['kind']
        counts[kind]+=1
        if kind in KEEP or item.get('outcome') == 'error' or int(item.get('status') or 0) >= 400 or item.get('elapsedMs',0) >= 3000:
            result['events'].append(item)
    for root in roots:
        result['compressedLogBytes'] += sum(p.stat().st_size for p in Path(root).glob('*.jsonl.gz'))
        for path in sorted(Path(root).glob('events-*.jsonl.gz')):
            key = str(path)
            offset = cursors.get(key,0)
            size = path.stat().st_size
            if size < offset:
                result['errors'][path.name] = 'file_shrank'
                offset = 0
            if size == offset:
                continue
            if budget <= 0:
                result['pendingFiles'] += 1
                continue
            try:
                _, new_offset = read_members(path,offset,min(budget,8*1024*1024),consume)
                budget -= new_offset - offset
                cursors[key] = new_offset
                if new_offset < size:
                    result['pendingFiles'] += 1
            except (OSError,ValueError,KeyError,zlib.error) as exc:
                result['errors'][path.name] = type(exc).__name__
    result['counts'] = dict(counts)
    return result,cursors
