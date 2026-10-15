'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const diagnostics = require('../src/shared/diagnostics.cjs');
test('persistent gzip members retain more than the UI tail and redact credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-'));
  const previous = process.env.COLLECTOR_DIAGNOSTICS_DIR;
  process.env.COLLECTOR_DIAGNOSTICS_DIR = root;
  try {
    for (let i = 0; i < 200; i++)
      diagnostics.write(
        'task_output',
        { line: `line ${i}`, authorization: 'Bearer unsafe', url: 'https://a.test/?token=unsafe' },
        'test-job',
      );
    const rows = zlib
      .gunzipSync(fs.readFileSync(path.join(root, 'job-test-job.jsonl.gz')))
      .toString()
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(rows.length, 200);
    assert.equal(rows[0].line, 'line 0');
    assert.equal(rows.at(-1).line, 'line 199');
    assert.ok(!JSON.stringify(rows).includes('unsafe'));
    assert.equal(fs.statSync(path.join(root, 'job-test-job.jsonl.gz')).mode & 0o777, 0o600);
  } finally {
    if (previous == null) delete process.env.COLLECTOR_DIAGNOSTICS_DIR;
    else process.env.COLLECTOR_DIAGNOSTICS_DIR = previous;
    fs.rmSync(root, { recursive: true });
  }
});
test('only diagnosis parameters, not cookies or signed URL params, are retained', () => {
  const url = diagnostics.safeUrl('https://a.test/api?curPage=25&categoryId=5289&token=secret&signature=secret');
  assert.deepEqual(url.query, { curPage: '25', categoryId: '5289' });
  assert.equal(diagnostics.safeUrl('http://host/manual-display/secret').path, '/manual-display/[REDACTED]');
});
test('resource trigger retains decision values and instant process snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-resource-'));
  const previous = process.env.COLLECTOR_DIAGNOSTICS_DIR;
  process.env.COLLECTOR_DIAGNOSTICS_DIR = root;
  try {
    const { ResourceGuard } = require('../src/policies/resource_guard.cjs');
    const guard = new ResourceGuard({ minMemoryMiB: 512, minDiskMiB: 0, memoryReader: () => 128 * 1024 * 1024 });
    assert.throws(
      () => guard.assertAllowed(),
      (e) => e.code === 'resource_pressure',
    );
    const row = zlib
      .gunzipSync(fs.readFileSync(path.join(root, fs.readdirSync(root)[0])))
      .toString()
      .trim()
      .split('\n')
      .map(JSON.parse)[0];
    assert.equal(row.state.memoryMiB, 128);
    assert.equal(row.state.limits.minMemoryMiB, 512);
    assert.ok(row.measuredAt);
    assert.ok(row.triggerSnapshot.processMemory.rss > 0);
  } finally {
    if (previous == null) delete process.env.COLLECTOR_DIAGNOSTICS_DIR;
    else process.env.COLLECTOR_DIAGNOSTICS_DIR = previous;
    fs.rmSync(root, { recursive: true });
  }
});

test('失败响应保存受控文本现场，独立于成功页快照开关', () => {
  const { saveListFailure } = require('../src/storage/raw_pages.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'list-failure-'));
  try {
    const evidence = saveListFailure(
      { dataDir: root, runId: 7, saveRaw: false },
      { externalId: '195955' },
      179,
      {
        status: 200,
        headers: { 'content-type': 'text/html' },
        text: '<html><title>Error page</title><script>secretcode</script><input value="private"><p>token=unsafe cookie=private 发生错误</p></html>',
      },
      { code: 'unexpected_html' },
    );
    const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(evidence.filePath)));
    assert.equal(saved.title, 'Error page');
    assert.equal(saved.status, 200);
    assert.equal(saved.code, 'unexpected_html');
    assert.equal(saved.pageNumber, 179);
    assert.equal(saved.contentType, 'text/html');
    assert.ok(!JSON.stringify(saved).includes('unsafe'));
    assert.ok(!JSON.stringify(saved).includes('private'));
    assert.ok(!JSON.stringify(saved).includes('secretcode'));
    assert.equal(fs.statSync(evidence.filePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
