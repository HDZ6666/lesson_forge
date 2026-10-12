'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
let context = {};
let lastFailure = 0;
const SECRET = /password|passwd|cookie|authorization|token|secret|signature/i;
const PARAMS = new Set([
  'bankId',
  'categoryId',
  'catelogTokpointId',
  'curPage',
  'textbookVersionId',
  'textbookId',
  'page',
  'pageSize',
  'cursor',
  'collection',
  'textbookExternalId',
  'sealedForImport',
]);
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? '[REDACTED]' : scrub(v)]));
  if (typeof value !== 'string') return value;
  return value
    .replace(/((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]')
    .replace(/(\/manual-display\/)[\w-]+/g, '$1[REDACTED]')
    .replace(/((?:password|passwd|cookie|authorization|token|secret|signature)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
function safeUrl(raw) {
  try {
    const u = new URL(raw, 'http://collector.local');
    return {
      host: u.hostname,
      path: u.pathname.replace(/(\/manual-display\/)[^/]+/g, '$1[REDACTED]'),
      query: Object.fromEntries([...u.searchParams].filter(([k]) => PARAMS.has(k))),
    };
  } catch {
    return { path: 'invalid_url' };
  }
}
function bind(fields) {
  context = { ...context, ...fields };
}
function write(kind, fields = {}, jobId = null) {
  const root =
    process.env.COLLECTOR_DIAGNOSTICS_DIR ||
    (process.env.COLLECTOR_DATA_DIR ? path.join(process.env.COLLECTOR_DATA_DIR, 'diagnostics') : null);
  if (!root) return;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const at = new Date().toISOString();
    const entry = scrub({
      at,
      eventId: randomUUID(),
      kind,
      pid: process.pid,
      jobId: process.env.COLLECTOR_DIAGNOSTIC_JOB_ID || null,
      ...context,
      ...fields,
    });
    const name = jobId && /^[\w-]+$/.test(jobId) ? `job-${jobId}` : `events-${at.slice(0, 10)}-${process.pid}`;
    // Independent gzip members permit immediate durable appends, including on
    // abrupt process exit. No timer buffer, response bodies or session cookies.
    fs.appendFileSync(path.join(root, name + '.jsonl.gz'), zlib.gzipSync(JSON.stringify(entry) + '\n', { level: 1 }), {
      mode: 0o600,
    });
  } catch (error) {
    if (Date.now() - lastFailure > 60000) {
      lastFailure = Date.now();
      console.error(`[diagnostics_write_failed] ${error.code || error.name}`);
    }
  }
}
function resources() {
  const snapshot = { processMemory: process.memoryUsage() };
  try {
    snapshot.meminfo = fs
      .readFileSync('/proc/meminfo', 'utf8')
      .split('\n')
      .filter((l) => /^(MemAvailable|MemTotal|SwapTotal|SwapFree):/.test(l));
  } catch {}
  try {
    snapshot.memoryPressure = fs.readFileSync('/proc/pressure/memory', 'utf8');
  } catch {}
  try {
    snapshot.processes = fs
      .readdirSync('/proc')
      .filter((n) => /^\d+$/.test(n))
      .flatMap((pid) => {
        try {
          const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
          return [
            {
              pid: Number(pid),
              name: s.match(/^Name:\s*(.+)$/m)?.[1],
              rssKiB: Number(s.match(/^VmRSS:\s*(\d+)/m)?.[1] || 0),
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.rssKiB - a.rssKiB)
      .slice(0, 20);
  } catch {}
  return snapshot;
}
function instrumentBrowser(browserContext) {
  if (!browserContext?.on || browserContext._lessonDiagnostics) return;
  browserContext._lessonDiagnostics = true;
  const requests = new WeakMap();
  browserContext.on('request', (request) => {
    try {
      const entry = {
        requestId: randomUUID(),
        started: performance.now(),
        method: request.method(),
        url: safeUrl(request.url()),
        resourceType: request.resourceType(),
        params: {},
      };
      for (const [k, v] of new URLSearchParams(request.postData() || '')) if (PARAMS.has(k)) entry.params[k] = v;
      requests.set(request, entry);
      write('source_request_started', entry);
    } catch (error) {
      write('diagnostic_hook_failed', { hook: 'request', error: error.name });
    }
  });
  browserContext.on('response', (response) => {
    const entry = requests.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    const h = response.headers();
    entry.responseHeaders = {};
    for (const key of ['retry-after', 'content-type', 'content-length'])
      if (h[key]) entry.responseHeaders[key] = h[key];
  });
  for (const event of ['requestfinished', 'requestfailed'])
    browserContext.on(event, (request) => {
      const entry = requests.get(request);
      if (!entry) return;
      write('source_request_finished', {
        ...entry,
        elapsedMs: Math.round(performance.now() - entry.started),
        outcome: event,
        error: request.failure()?.errorText || null,
      });
      requests.delete(request);
    });
}
module.exports = { write, bind, scrub, safeUrl, resources, instrumentBrowser };
