"""Append-only compressed workflow diagnostics; never store bodies or credentials."""
from __future__ import annotations

import contextlib
import contextvars
import datetime
import functools
import gzip
import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path

_context = contextvars.ContextVar('bank_diagnostics', default={})
_lock = threading.Lock()
_last_failure = 0.0
_SECRET = re.compile(r'password|passwd|cookie|authorization|token|secret|signature', re.I)
_QUERY = {'collection', 'cursor', 'page', 'pageSize', 'textbookExternalId', 'sealedForImport', 'allowIncomplete'}


def scrub(value):
    if isinstance(value, dict):
        return {str(k): '[REDACTED]' if _SECRET.search(str(k)) else scrub(v) for k,v in value.items()}
    if isinstance(value, (tuple,list)):
        return [scrub(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r'((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+', r'\1[REDACTED]', value, flags=re.I)
        value = re.sub(r'((?:password|passwd|token|secret|signature)\s*[=:]\s*)[^\s,;]+', r'\1[REDACTED]', value, flags=re.I)
        value = re.sub(r'Bearer\s+[^\s"\']+', 'Bearer [REDACTED]', value, flags=re.I)
        value = re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+', '[REDACTED_JWT]', value)
        return re.sub(r'(/manual-display/)[\w-]+', r'\1[REDACTED]', value)
    return value


def bind(**fields):
    return _context.set({**_context.get(), **fields})


def request_id():
    return _context.get().get('requestId')


def reset(token):
    _context.reset(token)


def event(kind, **fields):
    global _last_failure
    root = os.environ.get('BANK_DIAGNOSTICS_DIR')
    if not root:
        log_root = os.environ.get('SERVICE_LOG_ROOT')
        if not log_root:
            return
        root = str(Path(log_root) / 'bank-events')
    try:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        entry = scrub({'at':now,'eventId':uuid.uuid4().hex,'kind':kind,'pid':os.getpid(),**_context.get(),**fields})
        path = Path(root)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        encoded = gzip.compress((json.dumps(entry,ensure_ascii=False,default=str)+'\n').encode(),compresslevel=1)
        with _lock:
            fd = os.open(path / f'events-{now[:10]}-{os.getpid()}.jsonl.gz', os.O_WRONLY|os.O_CREAT|os.O_APPEND, 0o600)
            try:
                remaining = memoryview(encoded)
                while remaining:
                    remaining = remaining[os.write(fd, remaining):]
            finally:
                os.close(fd)
    except Exception as exc:
        if time.monotonic() - _last_failure > 60:
            _last_failure = time.monotonic()
            logging.getLogger(__name__).error('diagnostics_write_failed: %s',type(exc).__name__)


@contextlib.contextmanager
def span(stage, **fields):
    span_id = uuid.uuid4().hex
    started = time.monotonic()
    event('stage_started',stage=stage,spanId=span_id,**fields)
    result = {}
    try:
        yield result
    except BaseException as exc:
        event('stage_finished',stage=stage,spanId=span_id,elapsedMs=round((time.monotonic()-started)*1000),
              outcome='error',errorType=type(exc).__name__,message=getattr(exc,'message',str(exc)),**fields)
        raise
    else:
        event('stage_finished',stage=stage,spanId=span_id,elapsedMs=round((time.monotonic()-started)*1000),
              outcome='success',**fields,**result)


def audited_request(fn):
    @functools.wraps(fn)
    def wrapper(self, method, route, **kwargs):
        request_id = uuid.uuid4().hex
        token = bind(requestId=request_id)
        params = {k:v for k,v in (kwargs.get('query') or {}).items() if k in _QUERY}
        try:
            with span('collector_http',method=method,route=route,params=params,timeoutSeconds=self.timeout) as result:
                value = fn(self,method,route,**kwargs)
                result['responseType'] = 'bytes' if isinstance(value,bytes) else 'json'
                if isinstance(value,bytes):
                    result['bytes'] = len(value)
                return value
        finally:
            reset(token)
    return wrapper


def resource_snapshot():
    import psutil
    processes = []
    for proc in psutil.process_iter(['pid','name','memory_info']):
        try:
            info = proc.info
            if info['memory_info']:
                processes.append({'pid':info['pid'],'name':info['name'],'rssBytes':info['memory_info'].rss})
        except (psutil.NoSuchProcess,psutil.AccessDenied):
            pass
    memory = psutil.virtual_memory()
    swap = psutil.swap_memory()
    return {'hostAvailableBytes':memory.available,'swapUsedBytes':swap.used,
            'processes':sorted(processes,key=lambda p:p['rssBytes'],reverse=True)[:20]}
