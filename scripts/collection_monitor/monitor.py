#!/usr/bin/env python3
"""Independent, read-only production observation; writes only its own state directory."""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path
from zoneinfo import ZoneInfo

from diagnostic_reader import DEFAULT_ROOTS, collect_diagnostics

HERE = Path(__file__).resolve().parent
UTC = dt.timezone.utc
LOCAL = ZoneInfo('Asia/Shanghai')
CONTAINERS = ['lesson-forge-' + s for s in ('collector', 'service', 'mysql', 'redis', 'nginx')]
ACTIVE = {'starting', 'running', 'cancelling', 'pending', 'preparing', 'importing'}
SCHEMA = '''
CREATE TABLE IF NOT EXISTS samples(at TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,event_key TEXT UNIQUE,at TEXT NOT NULL,
 observed_at TEXT NOT NULL,kind TEXT NOT NULL,entity TEXT NOT NULL,message TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_time ON events(at);
CREATE TABLE IF NOT EXISTS states(entity TEXT PRIMARY KEY,signature TEXT NOT NULL,since TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hourly(hour TEXT PRIMARY KEY,samples INTEGER NOT NULL,min_memory_mib INTEGER,
 max_memory_mib INTEGER,min_disk_mib INTEGER,max_swap_mib INTEGER);
'''


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), default=str)


def utcnow():
    return dt.datetime.now(UTC).isoformat(timespec='seconds')


def timestamp(value, *, local=False):
    if not value:
        return None
    parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return parsed.replace(tzinfo=LOCAL if local else UTC).isoformat() if parsed.tzinfo is None else parsed.isoformat()


def local_time(value):
    return dt.datetime.fromisoformat(timestamp(value)).astimezone(LOCAL).strftime('%m-%d %H:%M:%S') if value else '—'


def seconds(start, end):
    return max(0, round((dt.datetime.fromisoformat(timestamp(end)) - dt.datetime.fromisoformat(timestamp(start))).total_seconds()))


def command(args, *, source=None, timeout=15):
    result = subprocess.run(args, input=source, text=True, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        # Do not copy database configuration or authorization headers from subprocess errors.
        raise RuntimeError(f'{args[0]} exited {result.returncode}')
    return result.stdout


def host_sample():
    values = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        values[key] = int(value.split()[0]) // 1024
    disk = shutil.disk_usage('/var/lib/docker')
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    pressure = Path('/proc/pressure/memory')
    return {'memoryMiB': values['MemAvailable'], 'totalMemoryMiB': values['MemTotal'],
            'swapUsedMiB': values['SwapTotal'] - values['SwapFree'], 'diskFreeMiB': disk.free // 1048576,
            'load': os.getloadavg(), 'swapInPages': int(vm['pswpin']), 'swapOutPages': int(vm['pswpout']),
            'majorFaults': int(vm['pgmajfault']), 'memoryPressure': pressure.read_text().strip() if pressure.exists() else None}


def slow_requests(text):
    rows = []
    pattern = re.compile(r'^(\S+) .*?"(GET|POST|PUT|DELETE|PATCH|OPTIONS) ([^ ?]+)(?:[^ ]*) [^ ]+" (\d+) .*?rt=([\d.]+)')
    for line in text.splitlines():
        match = pattern.search(line)
        if not match:
            continue
        at, method, path, status, elapsed = match.groups()
        if status == "101" or (int(status) < 400 and float(elapsed) < 3):
            continue
        path = re.sub(r"(/manual-display/)[^/]+", r"\1[redacted]", path)
        rows.append({"at":at,"method":method,"path":path,"status":int(status),"elapsedSeconds":float(elapsed)})
    return rows


def collect(since=None):
    data = {'at': utcnow(), 'host': host_sample(), 'probeErrors': {}, 'probeMs': {}}
    data['host']['topProcesses'] = command(['ps','-eo','pid,ppid,comm,rss','--sort=-rss'],timeout=3).splitlines()[:16]
    probes = {
        'mysql': (['docker', 'exec', '-i', 'lesson-forge-service', 'python', '-'], 'mysql_probe.py'),
        'collector': (['docker', 'exec', '-i', 'lesson-forge-collector', 'node', '--no-warnings', '-'], 'collector_probe.cjs'),
    }
    for name, (args, file) in probes.items():
        start = time.monotonic()
        try:
            data[name] = json.loads(command(args, source=(HERE / file).read_text(), timeout=20))
        except (RuntimeError, subprocess.TimeoutExpired, ValueError) as exc:
            data['probeErrors'][name] = type(exc).__name__
        data['probeMs'][name] = round((time.monotonic() - start) * 1000)
    try:
        data['containers'] = [json.loads(line) for line in command(
            ['docker', 'stats', '--no-stream', '--format', '{{json .}}', *CONTAINERS], timeout=10).splitlines()]
        data['containerStates'] = [json.loads(line) for line in command(
            ['docker', 'inspect', '--format', '{{json .State}}', *CONTAINERS]).splitlines()]
    except (RuntimeError, subprocess.TimeoutExpired, ValueError) as exc:
        data['probeErrors']['containers'] = type(exc).__name__
    try:
        since = since or (dt.datetime.now(UTC) - dt.timedelta(minutes=2)).isoformat()
        text = command(['docker','logs','--timestamps','--since',since,'--tail','5000','lesson-forge-nginx'],timeout=8)
        data['slowRequests'] = slow_requests(text)
        if len(text.splitlines()) >= 5000:
            data['probeErrors']['nginxLogTruncated'] = '5000 lines; consult raw container logs'
    except (RuntimeError,subprocess.TimeoutExpired) as exc:
        data['probeErrors']['nginx'] = type(exc).__name__
    try:
        text = command(['journalctl','-k','--since',since,'--no-pager','-o','json'],timeout=5)
        data['kernelErrors'] = []
        for line in text.splitlines():
            item = json.loads(line)
            message = item.get('MESSAGE','')
            if re.search(r'Out of memory|oom-kill|Killed process|I/O error|No space left', message, re.I):
                happened = dt.datetime.fromtimestamp(int(item['__REALTIME_TIMESTAMP'])/1000000,UTC).isoformat()
                data['kernelErrors'].append({'at':happened,'message':message[:1000]})
    except (RuntimeError,subprocess.TimeoutExpired,ValueError) as exc:
        data['probeErrors']['kernel'] = type(exc).__name__
    return data


def emit(db, key, at, observed, kind, entity, message, payload):
    db.execute('INSERT OR IGNORE INTO events(event_key,at,observed_at,kind,entity,message,payload) VALUES(?,?,?,?,?,?,?)',
               (key, timestamp(at) or observed, observed, kind, entity, message or '', dumps(payload)))


def transition(db, entity, state, at, *, message='', context=None):
    """A continuous pause is one episode, not one incident per polling interval."""
    signature = dumps(state)
    row = db.execute('SELECT signature,since,payload FROM states WHERE entity=?', (entity,)).fetchone()
    if row and row[0] == signature:
        return
    payload = {'state': state, 'context': context, 'baseline': row is None}
    if row:
        payload.update(previous=json.loads(row[0]), previousSince=row[1], observedDurationSeconds=seconds(row[1], at))
    digest = hashlib.sha256((entity + at + signature).encode()).hexdigest()
    emit(db, digest, at, at, 'baseline' if row is None else 'transition', entity, message, payload)
    db.execute('INSERT OR REPLACE INTO states VALUES(?,?,?,?)', (entity, signature, at, dumps(payload)))


def incident_kind(message, code=''):
    text = f'{code} {message}'
    if any(s in text for s in ('waiting_verification', '防护', '验证页面', 'HTTP 405', 'HTTP 403')):
        return 'protection'
    if any(s in text for s in ('resource_pressure', 'memory_limit', '内存', '空间低于')):
        return 'resource'
    if 'SIGTERM' in text or '同步已停止' in text or 'stop_requested' in text:
        return 'stopped'
    return 'error'


def active_collection(collector):
    result = []
    for job in collector.get('jobs', []):
        if job['status'] not in ACTIVE:
            continue
        item = {k:job.get(k) for k in ('id','status','collector_run_id','progressPercent','childRssMb','childRssPeakMb','waitingReason','listConcurrency')}
        item['scopes'] = [{k:s.get(k) for k in ('externalTextbookId','textbookName','pagesOk','questionsSeen','assetsDownloaded','errorCount')}
                          for s in job.get('scopeItems', [])]
        catalogs = [c for c in collector.get('catalogs', []) if c['run_id'] == job.get('collector_run_id')]
        item['lastCatalog'] = max(catalogs,key=lambda c:c.get('observed_at') or '',default=None)
        result.append(item)
    return result


def ingest(db, data):
    at = data['at']
    host = data['host']
    mysql, collector = data.get('mysql', {}), data.get('collector', {})
    context = {'host': host, 'activeTasks': [r['run_id'] for r in mysql.get('jobs', []) if r['status'] in ACTIVE]}
    sample = {'host': host, 'probeMs': data['probeMs'], 'probeErrors': data['probeErrors'],
              'containers': data.get('containers'), 'storage': collector.get('storage'),
              'activeTasks': context['activeTasks'],
              'jobs': active_collection(collector),
              'health': collector.get('health'),
              'diagnostics': {k:v for k,v in data.get('diagnostics',{}).items() if k != 'events'},
              'plans': [{k: p.get(k) for k in ('plan_id','cycle_no','cycle_state','control_state')} for p in mysql.get('plans', [])]}
    db.execute('INSERT OR REPLACE INTO samples VALUES(?,?)', (at, dumps(sample)))
    db.execute('''INSERT INTO hourly VALUES(?,1,?,?,?,?) ON CONFLICT(hour) DO UPDATE SET
      samples=samples+1,min_memory_mib=min(min_memory_mib,excluded.min_memory_mib),
      max_memory_mib=max(max_memory_mib,excluded.max_memory_mib),
      min_disk_mib=min(min_disk_mib,excluded.min_disk_mib),max_swap_mib=max(max_swap_mib,excluded.max_swap_mib)''',
               (at[:13], host['memoryMiB'], host['memoryMiB'], host['diskFreeMiB'], host['swapUsedMiB']))
    transition(db, 'monitor:probes', data['probeErrors'], at, message='监测探针状态', context=context)
    thresholds = {**mysql.get('settings', {}), **collector.get('settings', {})}
    for key, value in thresholds.items():
        if key.endswith('MEMORY_MIB') or key.endswith('MEMORY_FREE_MIB') or key.endswith('DISK_FREE_MIB'):
            if value is None:
                continue
            measured = host['diskFreeMiB'] if 'DISK' in key else host['memoryMiB']
            limit = int(value)
            transition(db, 'watermark:' + key, {'below': limit > 0 and measured < limit, 'limitMiB': limit}, at,
                       message=f'{key}：当前 {measured} MiB，阈值 {limit} MiB（宿主机采样）', context=context)
    if 'collector' in data:
        transition(db, 'source:control', collector.get('control'), at, message='来源验证／冷却状态', context=context)
        health = collector.get('health', {})
        transition(db, 'collector:api', {k: health.get(k) for k in ('status','error')}, at,
                   message='采集器健康接口状态', context=context)
        budget = health.get('sourceBudget', {})
        transition(db, 'source:budget', {k: budget.get(k) for k in ('paused','reason','limits')}, at, message='来源预算状态', context=context)
        for job in collector.get('jobs', []):
            transition(db, 'collector:job:' + job['id'], {k: job.get(k) for k in ('status','waitingReason','waitingSince','errorCode')}, at,
                       message=job.get('errorMessage') or job.get('waitingReason') or '采集执行状态', context={**context,'job':job})
        errors = {r['run_id']: r for r in collector.get('errors', []) if r['stage'] == 'run'}
        scopes = {r['collector_run_id']: r for r in mysql.get('scopes', [])}
        tasks = {r['run_id']:r for r in mysql.get('jobs', [])}
        jobs = {r.get('collector_run_id'): r for r in collector.get('jobs', [])}
        for run in collector.get('runs', []):
            if not run.get('finished_at') or run['status'] == 'success':
                continue
            error, job = errors.get(run['id'], {}), jobs.get(run['id'], {})
            message = job.get('errorMessage') or run.get('message') or error.get('message') or run['status']
            code = job.get('errorCode') or error.get('error_code', '')
            kind = incident_kind(message, code)
            matching_error = incident_kind(error.get('message',''), error.get('error_code','')) == kind
            happened = (job.get('waitingSince') if kind == 'protection' else None) or (error.get('created_at') if matching_error else None) or run['finished_at']
            payload = {'run':run, 'job':job, 'scope':scopes.get(run['id']), 'historical':timestamp(happened) < at,
                       'elapsedSeconds': seconds(run['started_at'], happened), 'code':code,
                       'timeBasis': 'waiting_since' if kind == 'protection' and job.get('waitingSince') else ('matching_error' if matching_error else 'terminal_record'),
                       'task':tasks.get((scopes.get(run['id']) or {}).get('run_id'))}
            # One terminal incident per collector run, even if errors, job and run header all describe it.
            key = f'run:{run["id"]}:terminal'
            emit(db, key, happened, at, kind, f'run:{run["id"]}', message, payload)
            db.execute('UPDATE events SET at=?,kind=?,message=?,payload=? WHERE event_key=?',
                       (timestamp(happened),kind,message,dumps(payload),key))
        for run in collector.get('metadata', []):
            if run.get('finished_at') and run['status'] != 'success':
                emit(db, f'metadata:{run["id"]}', run['finished_at'], at, 'metadata', f'metadata:{run["id"]}', run.get('message') or run['status'], run)
    for item in data.get('diagnostics',{}).get('events',[]):
        emit(db,'diagnostic:'+item['eventId'],item['at'],at,'diagnostic',str(item.get('jobId') or item.get('taskId') or item.get('runId') or 'runtime'),item['kind'],item)
    for name, state in zip(CONTAINERS, data.get('containerStates', [])):
        transition(db, name, {k:state.get(k) for k in ('Status','OOMKilled','ExitCode','StartedAt','FinishedAt')},
                   at, message='容器生命周期', context=context)
    for error in data.get('kernelErrors', []):
        emit(db, 'kernel:' + hashlib.sha256(dumps(error).encode()).hexdigest(), error['at'], at, 'kernel',
             'host', error['message'], error)
    for request in data.get('slowRequests', []):
        emit(db, 'http:' + hashlib.sha256(dumps(request).encode()).hexdigest(), request['at'], at, 'http',
             'nginx', f"{request['method']} {request['path']} {request['status']} {request['elapsedSeconds']} 秒", request)
    for name, id_key in [('jobs','run_id'), ('imports','import_id'), ('intakes','intake_id'), ('plans','plan_id'), ('issues','issue_id')]:
        for row in mysql.get(name, []):
            keys = ('status','phase','stage','error_message','dispatch_error','attempt_count','cycle_no','cycle_state','control_state')
            transition(db, f'{name}:{row[id_key]}', {k: row[k] for k in keys if k in row}, at,
                       message=row.get('error_message') or row.get('dispatch_error') or row.get('reason') or name,
                       context={**context, 'record':row})


def cycle_summaries(mysql):
    result = []
    imports = {r['task_id']: r for r in mysql.get('imports', [])}
    for cycle in mysql.get('cycles', []):
        targets = json.loads(cycle.get('targets') or '[]') if isinstance(cycle.get('targets'), str) else cycle.get('targets', [])
        latest = {}
        for job in sorted(mysql.get('jobs', []), key=lambda r:r['run_id']):
            options = job.get('options', {})
            automatic = options.get('autoPlanId') == cycle['plan_id'] and options.get('autoCycleNo') == cycle['cycle_no']
            started = timestamp(job.get('started_at') or job.get('create_time'), local=True)
            manual = options.get('manualPlanId') == cycle['plan_id'] and started and cycle.get('started_at')
            if manual:
                instant = dt.datetime.fromisoformat(started)
                manual = instant >= dt.datetime.fromisoformat(timestamp(cycle['started_at'])) and (
                    not cycle.get('finished_at') or instant <= dt.datetime.fromisoformat(timestamp(cycle['finished_at'])))
            if not (automatic or manual):
                continue
            for book in options.get('textbookIds', []):
                latest[book] = job
        counts = collections.Counter()
        for book in targets:
            job = latest.get(book)
            if not job:
                counts['no_task'] += 1
            elif job['status'] == 'queued':
                counts['queued'] += 1
            elif job['status'] in ACTIVE:
                counts['collecting'] += 1
            else:
                imp = imports.get(job['run_id'])
                if imp and imp['status'] == 'completed':
                    counts['fully_imported'] += 1
                elif imp and imp['status'] == 'partial':
                    counts['partial_imported'] += 1
                elif imp and imp['status'] in ACTIVE:
                    counts['importing'] += 1
                else:
                    counts['needs_attention'] += 1
        result.append({**cycle, 'targets':len(targets), 'counts':dict(counts),
                       'allFullyImported': bool(targets) and counts['fully_imported'] == len(targets)})
    return result


def session_summaries(mysql):
    """Per plan and sync session: rounds, end reason and real new counts."""
    sessions = collections.OrderedDict()
    for cycle in sorted(mysql.get('cycles', []), key=lambda r: (r['plan_id'], r.get('cycle_no') or 0)):
        if cycle.get('session_no') is None:
            continue
        summary = cycle.get('summary_json') or {}
        if isinstance(summary, str):
            summary = json.loads(summary or '{}')
        key = (cycle['plan_id'], cycle['session_no'])
        item = sessions.setdefault(key, {'planId': cycle['plan_id'], 'sessionNo': cycle['session_no'],
                                         'legacy': bool(cycle.get('legacy')), 'rounds': 0, 'newQuestionCount': 0,
                                         'newRelationCount': 0, 'endReason': None, 'startedAt': cycle.get('started_at'),
                                         'finishedAt': None})
        item['rounds'] += 1
        item['newQuestionCount'] += int(summary.get('newQuestionCount') or 0)
        item['newRelationCount'] += int(summary.get('newRelationCount') or 0)
        if cycle.get('end_reason'):
            item['endReason'] = cycle['end_reason']
            item['finishedAt'] = cycle.get('finished_at')
    return list(sessions.values())


def summary(db, data):
    events = []
    for row in db.execute('SELECT at,observed_at,kind,entity,message,payload FROM events WHERE kind IN (\'protection\',\'resource\',\'metadata\',\'error\',\'stopped\') ORDER BY at'):
        payload = json.loads(row[5])
        events.append({'at':row[0], 'observedAt':row[1], 'kind':row[2], 'entity':row[3], 'message':row[4],
                       'elapsedSeconds':payload.get('elapsedSeconds'), 'taskId':(payload.get('scope') or {}).get('run_id'),
                       'textbookId':(payload.get('run', {}).get('scope') or {}).get('textbookId'),
                       'peakChildRssMiB':payload.get('job', {}).get('childRssPeakMb'),
                       'timeBasis':payload.get('timeBasis'),
                       'planId':((payload.get('task') or {}).get('options') or {}).get('autoPlanId'),
                       'cycleNo':((payload.get('task') or {}).get('options') or {}).get('autoCycleNo')})
    protection = [r for r in events if r['kind'] == 'protection']
    for previous, current in zip(protection, protection[1:]):
        current['wallIntervalSeconds'] = seconds(previous['at'], current['at'])
    mysql = data.get('mysql', {})
    slow = list(db.execute("SELECT message,payload FROM events WHERE kind='http' ORDER BY at DESC LIMIT 30"))
    kernel = [dict(zip(('at','message'),r)) for r in db.execute("SELECT at,message FROM events WHERE kind='kernel' ORDER BY at DESC LIMIT 30")]
    detailed = [dict(zip(('at','entity','message','payload'),(r[0],r[1],r[2],json.loads(r[3])))) for r in db.execute("SELECT at,entity,message,payload FROM events WHERE kind='diagnostic' ORDER BY id DESC LIMIT 80")]
    return {'diagnosticEvents':detailed, 'kernelErrors':kernel, 'slowRequests':[json.loads(r[1]) for r in slow], 'at':data['at'], 'monitoringStartedAt':db.execute('SELECT min(observed_at) FROM events').fetchone()[0],
            'activeCollection': active_collection(data.get('collector', {})),
            'host':data['host'], 'storage':data.get('collector', {}).get('storage'), 'probeErrors':data['probeErrors'],
            'cycles':cycle_summaries(mysql), 'sessions':session_summaries(mysql), 'incidents':events,
            'resourceWait':next((json.loads(r['resource_wait_json']) if isinstance(r.get('resource_wait_json'), str)
                                 else r.get('resource_wait_json') for r in mysql.get('control', []) if r.get('resource_wait_json')), None),
            'openIssues':[r for r in mysql.get('issues', []) if r['status'] == 'open'],
            'activeTasks':[{k:r.get(k) for k in ('run_id','logical_task_id','status','started_at','options')}
                           for r in mysql.get('jobs', []) if r['status'] in ACTIVE],
            'importProblems':[r for r in mysql.get('imports', []) + mysql.get('intakes', []) if r['status'] in ('failed','blocked')],
            'coverageNote':'历史事件来自持久化执行记录；资源每分钟采样，无法还原部署前数值或捕获两次采样间的全部瞬时峰值。恢复时间按首次观察到恢复计算。间隔包含暂停时间，不能解释成固定风控周期。',
            'recentTransitions':[dict(zip(('at','entity','message','payload'), (r[0],r[1],r[2],json.loads(r[3])))) for r in db.execute(
                "SELECT at,entity,message,payload FROM events WHERE kind='transition' ORDER BY id DESC LIMIT 40")],
            'hourly':[dict(zip(('hour','samples','minMemoryMiB','maxMemoryMiB','minDiskMiB','maxSwapMiB'), r))
                      for r in db.execute('SELECT * FROM hourly ORDER BY hour DESC LIMIT 168')]}


def markdown(report):
    lines = ['# 学科采集运行监测', '', f'更新：{local_time(report["at"])}（北京时间）；监测开始：{local_time(report["monitoringStartedAt"])}。', '',
             report['coverageNote'], '', f'监测探针错误：{dumps(report["probeErrors"])}。错误期间的数据缺口不会算作运行正常。', '']
    for cycle in report['cycles']:
        lines += [f'## {cycle["cycle_name"]}', '', f'教材总数：{cycle["targets"]}；轮次状态：{cycle["status"]}；全部完整入库：{"是" if cycle["allFullyImported"] else "否"}。', '',
                  ' | '.join(f'{k}: {v}' for k,v in cycle['counts'].items()), '']
    if report.get('sessions'):
        lines += ['## 同步批次', '', '| 计划 | 第几次同步 | 轮数 | 新增题 | 新增关联 | 结束原因 |', '| --- | --- | --- | --- | --- | --- |']
        lines += [f"| {s['planId']} | {s['sessionNo']}{'（旧记录）' if s['legacy'] else ''} | {s['rounds']} | {s['newQuestionCount']} | {s['newRelationCount']} | {s['endReason'] or '进行中'} |"
                  for s in report['sessions']]
        lines += ['']
    wait = report.get('resourceWait') or {}
    if wait.get('active'):
        lines += [f"资源等待：{wait.get('reason')}，开始 {wait.get('since')}，下次检查 {wait.get('nextCheckAt')}（合并为一条公共等待）。", '']
    host = report['host']
    lines += ['## 当前资源', '', f'可用内存 {host["memoryMiB"]} MiB / {host["totalMemoryMiB"]} MiB；Swap 已用 {host["swapUsedMiB"]} MiB；磁盘剩余 {host["diskFreeMiB"]} MiB。', '',
              'Swap 占用是存量，需结合 swapInPages / swapOutPages 差值、内存压力和可用内存判断当前是否换页。', '',
              f'正在执行：{", ".join(str(r["run_id"]) for r in report["activeTasks"]) or "无"}。', '', '## 已确认的采集事件', '',
              '| 时间 | 类型 | 任务 / 采集运行 | 教材来源 ID | 当次运行后（分钟） | 原因 |', '| --- | --- | --- | --- | --- | --- |']
    for row in report['incidents']:
        elapsed = round(row['elapsedSeconds']/60, 1) if row['elapsedSeconds'] is not None else '—'
        msg = row['message'].replace('|','／').replace('\n',' ')
        lines.append(f'| {local_time(row["at"])} | {row["kind"]} | {row["taskId"] or "—"} / {row["entity"]} | {row["textbookId"] or "—"} | {elapsed} | {msg} |')
    lines += ['', '## 当前核验／入库问题', '']
    lines += [f'- 任务 {r["task_id"]} / {r["status"]}：{r.get("error_message") or "—"}' for r in report['importProblems']]
    lines += ['', '## 程序直接记录的事件', '']
    lines += [f"- {local_time(r['at'])} {r['entity']}：{r['message']} {dumps(r['payload'])}" for r in report['diagnosticEvents']]
    lines += ['', '## 内核资源故障', '']
    lines += [f"- {local_time(r['at'])} {r['message']}" for r in report['kernelErrors']]
    lines += ['', '## 最近慢请求／服务错误（不含 WebSocket 长连接）', '']
    lines += [f"- {local_time(r['at'])} {r['method']} {r['path']}：HTTP {r['status']}，{r['elapsedSeconds']} 秒" for r in report['slowRequests']]
    lines += ['', '## 最近状态变化（观察时间）', '']
    lines += [f'- {local_time(r["at"])} {r["entity"]}：{r["message"]}' for r in report['recentTransitions']]
    lines += ['', '完整事件、运行上下文、每分钟资源采样及每小时最低内存保存在 monitor.sqlite3；report.json 是供分析和提醒读取的汇总。', '']
    return '\n'.join(lines)


def write_atomic(path, content):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(content)
    os.chmod(temp, 0o600)
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/lesson-forge-monitor'))
    parser.add_argument('--diagnostic-root',action='append',default=None)
    parser.add_argument('--input', type=Path, help='Offline replay of a collected probe, without accessing production')
    parser.add_argument('--sample-days', type=int, default=30)
    args = parser.parse_args()
    os.umask(0o077)
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (args.state_dir / 'monitor.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        previous = args.state_dir / 'latest.json'
        since = None
        if previous.exists():
            since = (dt.datetime.fromisoformat(json.loads(previous.read_text())['at']) - dt.timedelta(seconds=2)).isoformat()
        data = json.loads(args.input.read_text()) if args.input else collect(since)
        cursor_path = args.state_dir / 'diagnostic-cursors.json'
        next_cursors = None
        if not args.input:
            cursors=json.loads(cursor_path.read_text()) if cursor_path.exists() else {}
            data['diagnostics'],next_cursors=collect_diagnostics(args.diagnostic_root or DEFAULT_ROOTS,cursors)
            if data['diagnostics']['errors']:
                data['probeErrors']['diagnostics']=data['diagnostics']['errors']
        with sqlite3.connect(args.state_dir / 'monitor.sqlite3') as db:
            db.executescript(SCHEMA)
            ingest(db, data)
            # Only raw samples expire; incidents, episode transitions and hourly extrema remain.
            cutoff = (dt.datetime.now(UTC) - dt.timedelta(days=max(1,args.sample_days))).isoformat()
            db.execute('DELETE FROM samples WHERE at < ?', (cutoff,))
            report = summary(db, data)
        if next_cursors is not None:
            write_atomic(cursor_path,dumps(next_cursors))
        write_atomic(args.state_dir / 'latest.json', dumps(data))
        write_atomic(args.state_dir / 'report.json', dumps(report))
        write_atomic(args.state_dir / 'report.md', markdown(report))
        print(dumps({'at':data['at'], 'activeTasks':[r['run_id'] for r in report['activeTasks']],
                     'cycles':[{k:c[k] for k in ('plan_id','cycle_no','status','counts','allFullyImported')} for c in report['cycles']],
                     'probeErrors':data['probeErrors']}))


if __name__ == '__main__':
    main()
