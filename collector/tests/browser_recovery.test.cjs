'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runDiscovery } = require('../src/jobs/metadata_run.cjs');
const { SourceControl } = require('../src/policies/source_control.cjs');
const { waitForVerification } = require('../src/sources/zujuan/session.cjs');
const { readFailurePage, captureFailurePage } = require('../src/storage/failure_pages.cjs');
const { createCollectorServer, CollectorJobManager } = require('../server.cjs');

test('教材启动保留同一档案的旧浏览器恢复顺序，最终失败才公共暂停，并保存最后现场', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-browser-recovery-'));
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'Default', 'Cookies'), 'fixture');
  const dbPath = path.join(dir, 'db.sqlite3');
  const modes = [];
  let closes = 0;
  const playwright = { chromium: { launchPersistentContext: async (profile, launch) => {
    assert.equal(profile, profileDir);
    assert.equal(new SourceControl(dbPath).status().paused, false);
    modes.push(launch.headless);
    const page = {
      isClosed: () => false, url: () => 'about:blank',
      goto: async () => ({ status: () => 200, headers: () => ({}) }),
      waitForLoadState: async () => {},
      evaluate: async () => ({ title: '阻断页面', text: '已阻断', url: 'https://zujuan.xkw.com/czsx/zj261314/o2/', hasContent: false }),
      screenshot: async () => Buffer.from(`fixture-${launch.headless}`),
    };
    return {
      pages: () => [page], setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
      request: { get: async () => ({ status: () => 200, headers: () => ({}), text: async () => 'User-agent: *\nDisallow:', dispose: async () => {} }) },
      close: async () => { closes += 1; },
    };
  } } };
  try {
    await assert.rejects(runDiscovery({
      acknowledgeSourcePolicy: true, dbPath, dataDir: dir, profileDir,
      seedUrl: 'https://zujuan.xkw.com/czsx/zj261314/o2/', baseUrl: 'https://zujuan.xkw.com',
      bankPath: 'czsx', headless: true, timeout: 1000, delayMin: 0, delayMax: 0,
    }, { playwright }), (error) => error.code === 'challenge');
    assert.deepEqual(modes, [true, false]);
    assert.equal(closes, 2);
    assert.equal(new SourceControl(dbPath).status().manualRequired, true);
    const saved = readFailurePage(dir, 1);
    assert.equal(saved.title, '阻断页面');
    assert.equal(Buffer.from(saved.screenshot.split(',')[1], 'base64').toString(), 'fixture-false');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('人工验证等待保留当前页，恢复内容后返回，不提前进入永久公共暂停', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-human-wait-'));
  const control = new SourceControl(path.join(dir, 'db.sqlite3'));
  let polls = 0;
  let waits = 0;
  try {
    const state = await waitForVerification({
      bringToFront: async () => {}, url: () => 'https://zujuan.xkw.com/czsx/',
      evaluate: async () => ++polls === 1
        ? { challenge: true, title: '验证', text: '请人工验证' }
        : { challenge: false, hasContent: true, title: '题库', text: '正常题目' },
    }, { sourceControl: control, requireProbe: true, verificationInitialWait: 0,
      verificationTimeout: 1000, sleepFn: async () => { waits += 1; } });
    assert.equal(state.hasContent, true);
    assert.equal(polls, 2);
    assert.ok(waits > 0);
    assert.equal(control.status().paused, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('现场截图失败仍保存文字，缺失旧现场正常返回，不接受路径作为运行ID', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-failure-page-'));
  try {
    await captureFailurePage({
      evaluate: async () => ({ title: '问题页', text: '来源拒绝访问', url: 'https://zujuan.xkw.com/' }),
      screenshot: async () => { throw new Error('fixture screenshot failure'); },
    }, { dataDir: dir }, 1, new Error('original error'));
    assert.equal(readFailurePage(dir, 1).text, '来源拒绝访问');
    assert.equal(readFailurePage(dir, 1).screenshot, null);
    assert.equal(readFailurePage(dir, 2).available, false);
    assert.throws(() => readFailurePage(dir, '../1'), /无效/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('现场接口沿用采集器认证，仅读取对应metadata运行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-failure-api-'));
  const manager = new CollectorJobManager({ dbPath: path.join(dir, 'db.sqlite3'), dataDir: dir });
  const server = createCollectorServer({ manager, token: 'fixture-token' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/metadata/runs/1/failure-page`;
  try {
    assert.equal((await fetch(endpoint)).status, 401);
    const response = await fetch(endpoint, { headers: { Authorization: 'Bearer fixture-token' } });
    assert.deepEqual(await response.json(), { available: false, runId: 1 });
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
