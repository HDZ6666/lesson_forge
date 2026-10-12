'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SETTINGS, describeConfig, validateConfig } = require('../src/shared/config.cjs');
const { renderMetrics } = require('../src/api/metrics.cjs');
const { createCollectorServer } = require('../server.cjs');

test('config registry defaults agree with the consuming modules', () => {
  const { values, errors } = validateConfig({});
  assert.deepEqual(errors, []);
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const questionRun = source('src/jobs/question/browser_session.cjs');
  assert.match(questionRun, new RegExp(`DEFAULT_BROWSER_RECYCLE_PAGES = ${values.COLLECTOR_BROWSER_RECYCLE_PAGES};`));
  assert.match(questionRun, new RegExp(`DEFAULT_BROWSER_RECYCLE_MB = ${values.COLLECTOR_BROWSER_RECYCLE_MB};`));
  assert.match(
    questionRun,
    new RegExp(`MIN_PAGES_BETWEEN_PRESSURE_RECYCLES = ${values.COLLECTOR_BROWSER_PRESSURE_MIN_PAGES};`),
  );
  const { PERSIST_INTERVAL_MS } = require('../src/api/job_manager/constants.cjs');
  assert.equal(values.COLLECTOR_PERSIST_INTERVAL_MS, PERSIST_INTERVAL_MS);
});

test('every COLLECTOR_ variable the code reads is registered', () => {
  const registered = new Set(SETTINGS.map((setting) => setting.name));
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.cjs')) files.push(full);
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  files.push(path.join(__dirname, '..', 'server.cjs'));
  const used = new Set();
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bCOLLECTOR_[A-Z0-9_]+\b/g)) used.add(match[0]);
  }
  const NOT_SETTINGS = new Set(['COLLECTOR_ROOT']);
  const missing = [...used].filter((name) => !registered.has(name) && !NOT_SETTINGS.has(name)).sort();
  assert.deepEqual(missing, []);
});

test('invalid values are errors, unknown names and inverted watermarks are warnings', () => {
  const result = validateConfig({
    COLLECTOR_READER_THREADS: 'two',
    COLLECTOR_BROWSER_RECYCLE_PAGES: '-1',
    COLLECTOR_HEADFUL: 'maybe',
    COLLECTOR_DELAY_MIN_MS: '5000',
    COLLECTOR_DELAY_MAX_MS: '1000',
    COLLECTOR_MIN_MEMORY_FREE_MIB: '512',
    COLLECTOR_SOFT_MEMORY_FREE_MIB: '256',
    COLLECTOR_BROWSER_RECYCLE_PAGE: '400',
  });
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.some((error) => error.includes('COLLECTOR_READER_THREADS')));
  assert.ok(result.errors.some((error) => error.includes('COLLECTOR_DELAY_MAX_MS')));
  assert.deepEqual(result.unknown, ['COLLECTOR_BROWSER_RECYCLE_PAGE']);
  assert.equal(result.warnings.length, 2);
});

test('described config hides the token and, for HTTP, host paths', () => {
  const { values } = validateConfig({ COLLECTOR_API_TOKEN: 'secret-token', COLLECTOR_DB: '/data/zujuan.sqlite3' });
  const logged = JSON.stringify(describeConfig(values));
  assert.equal(logged.includes('secret-token'), false);
  assert.ok(logged.includes('/data/zujuan.sqlite3'));
  const served = JSON.stringify(describeConfig(values, { redactPaths: true }));
  assert.equal(served.includes('/data/zujuan.sqlite3'), false);
  assert.equal(served.includes('secret-token'), false);
});

test('metrics render the active job, pressure and counters in Prometheus format', () => {
  const job = {
    id: 'j1',
    runType: 'content',
    status: 'running',
    createdAt: '2026-10-12T00:00:00Z',
    progressPercent: 42.5,
    childRssMb: 300,
    childRssPeakMb: 350,
    childBrowserRssMb: 900,
    childBrowserRssPeakMb: 1100,
    browserRecycleCount: 2,
    scopeItems: [
      { pagesOk: 10, questionsSeen: 100, errorCount: 1 },
      { pagesOk: 5, questionsSeen: 50, errorCount: 0 },
    ],
  };
  const manager = {
    activeJobId: 'j1',
    jobs: new Map([['j1', job]]),
    metrics: {
      startedAt: Date.now() - 5000,
      browserRecycles: 3,
      jobsFinished: { completed: 2, interrupted: 1 },
      jobErrors: { resource_pressure: 1 },
    },
    persistStats: { writes: 7, failures: 0 },
    resourceGuard: { status: () => ({ memoryMiB: 700, pressure: 'soft', disks: [{ kind: 'data', freeMiB: 9000 }] }) },
    sourceControl: { status: () => ({ paused: false, manualRequired: false }) },
    sourceBudget: {
      status: () => {
        throw new Error('locked');
      },
    },
  };
  const text = renderMetrics({ manager });
  assert.match(text, /^collector_up 1$/m);
  assert.match(text, /^collector_job_active 1$/m);
  assert.match(text, /^collector_job_progress_percent\{run_type="content"\} 42.5$/m);
  assert.match(text, /^collector_job_pages_ok\{run_type="content"\} 15$/m);
  assert.match(text, /^collector_browser_rss_mb\{run_type="content"\} 900$/m);
  assert.match(text, /^collector_browser_recycles_total 3$/m);
  assert.match(text, /^collector_jobs_finished_total\{status="interrupted"\} 1$/m);
  assert.match(text, /^collector_memory_pressure\{level="soft"\} 1$/m);
  assert.match(text, /^collector_memory_pressure\{level="ok"\} 0$/m);
  assert.equal(text.includes('collector_budget'), false, 'a failing source table is skipped, not fatal');
  assert.equal((text.match(/# TYPE collector_memory_pressure /g) || []).length, 1);
});

test('GET /metrics and /v1/config require the token and serve text and JSON', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-metrics-'));
  const server = createCollectorServer({
    dbPath: path.join(directory, 'collector.sqlite3'),
    dataDir: path.join(directory, 'data'),
    profileDir: path.join(directory, 'profile'),
    token: 'test-token',
    readerThreads: 1,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    const headers = { authorization: 'Bearer test-token' };
    const metrics = await fetch(`${base}/metrics`, { headers });
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get('content-type'), /^text\/plain/);
    const body = await metrics.text();
    assert.match(body, /^collector_reader_threads 1$/m);
    assert.match(body, /^collector_job_active 0$/m);
    const config = await (await fetch(`${base}/v1/config`, { headers })).json();
    assert.equal(config.settings.browser.COLLECTOR_BROWSER_RECYCLE_PAGES, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.collectorManager.shutdown?.();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
