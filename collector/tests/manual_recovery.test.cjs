'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ManualRecovery } = require('../src/api/manual_recovery.cjs');
function fixture() {
  const control = { revision: 3, manualRequired: true };
  let resumed = 0;
  const manager = {
    sourceControl: {
      status: () => control,
      resume: (r) => {
        assert.equal(r, 3);
        resumed++;
        return { paused: false };
      },
    },
  };
  const recovery = new ManualRecovery(manager);
  return { recovery, manager, control, resumed: () => resumed };
}
test('人工会话属于一个操作人，未检查和过期检查均不允许恢复', () => {
  const { recovery: r } = fixture();
  r.current = { id: 'one', owner: '1', revision: 3 };
  assert.throws(() => r.require({ sessionId: 'one', owner: '2' }), /其他管理员/);
  assert.throws(() => r.validate({ sessionId: 'one', owner: '1' }), /先检查/);
  r.current.verifiedAt = Date.now() - 121000;
  assert.throws(() => r.validate({ sessionId: 'one', owner: '1' }), /先检查/);
  r.current.verifiedAt = Date.now();
  assert.equal(r.validate({ sessionId: 'one', owner: '1' }).id, 'one');
});
test('来源状态变化使检查结果失效，关闭浏览器不能解除暂停', async () => {
  const { recovery: r, control, resumed } = fixture();
  let closed = false;
  r.current = {
    id: 'one',
    owner: '1',
    revision: 3,
    verifiedAt: Date.now(),
    context: {
      close: async () => {
        closed = true;
      },
    },
  };
  control.revision = 4;
  assert.throws(() => r.validate({ sessionId: 'one', owner: '1' }), /状态已变化/);
  await r.close({ sessionId: 'one', owner: '1' });
  assert.equal(closed, true);
  assert.equal(r.active, false);
  assert.equal(resumed(), 0);
});
test('检查通过后先关闭浏览器再恢复来源，避免复用档案冲突', async () => {
  const { recovery: r, manager } = fixture();
  const events = [];
  r.current = {
    id: 'one',
    owner: '1',
    revision: 3,
    verifiedAt: Date.now(),
    context: { close: async () => events.push('close') },
  };
  manager.sourceControl.resume = () => {
    events.push('resume');
    return { paused: false };
  };
  await r.finish({ sessionId: 'one', owner: '1' });
  assert.deepEqual(events, ['close', 'resume']);
});
test('非来源页面不能假装完成验证，检查不会清除暂停', async () => {
  const { recovery: r, resumed } = fixture();
  r.current = {
    id: 'one',
    owner: '1',
    revision: 3,
    input: {},
    target: {},
    expires: Date.now() + 1000,
    page: { url: () => 'https://example.com' },
  };
  const result = await r.check({ sessionId: 'one', owner: '1' });
  assert.equal(result.verified, false);
  assert.match(result.message, /返回组卷网/);
  assert.equal(resumed(), 0);
});
test('远程画面桥接拒绝未授权连接，授权后传输 RFB 字节', async () => {
  const http = require('node:http'),
    net = require('node:net'),
    { once } = require('node:events'),
    { WebSocket } = require('ws');
  const { recovery: r } = fixture();
  const tcp = net.createServer((socket) => {
    socket.write('RFB 003.008\n');
    socket.on('data', (data) => socket.write(data));
  });
  await new Promise((resolve) => tcp.listen(5901, '127.0.0.1', resolve));
  const server = http.createServer();
  r.current = { id: 'one', owner: '1', vnc: {}, input: {}, target: {} };
  r.attach(server, 'secret');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/v1/manual-recovery/display?sessionId=one`;
  const denied = new WebSocket(url);
  await once(denied, 'error');
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer secret' } });
  const message = await once(ws, 'message');
  assert.equal(message[0].toString(), 'RFB 003.008\n');
  r.current.closing = true;
  ws.close();
  await once(ws, 'close');
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => tcp.close(resolve));
});
function discoveryFixture(stage = 'textbooks') {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-recovery-'));
  const dbPath = path.join(root, 'collector.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE collector_jobs(id TEXT PRIMARY KEY,run_type TEXT,payload_json TEXT)');
  db.prepare('INSERT INTO collector_jobs VALUES(?,?,?)').run(
    'metadata-one',
    'metadata',
    JSON.stringify({
      lastErrorEvent: {
        discoveryRequest: {
          stage,
          seedUrl: 'https://zujuan.xkw.com/czsx/zj261314/o2/',
          versionId: '195846',
          urlTemplate: '/czsx/zj{0}/',
        },
      },
    }),
  );
  db.close();
  return { dbPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('发现复核请求绑定持久化失败版本，入口正常不能代表接口恢复', async () => {
  const f = discoveryFixture();
  try {
    const { recovery: r, manager, resumed } = fixture();
    const observed = [];
    manager.sourceControl.observe = (status) => observed.push(status);
    const { recoveryTarget } = require('../src/api/manual_recovery.cjs');
    const target = recoveryTarget(f.dbPath, {
      kind: 'discovery',
      collectorJobId: 'metadata-one',
      seedUrl: 'https://example.com/ignored-client-url',
    });
    assert.equal(target.kind, 'discovery');
    assert.match(target.request.url, /chaptertextbooks\?textbookVersionId=195846/);
    assert.match(target.url, /zujuan\.xkw\.com/);
    assert.throws(() => recoveryTarget(f.dbPath, { kind: 'discovery', collectorJobId: 'missing' }));
    let apiStatus = 403;
    const requests = [];
    const healthySeed = '<div id="chapter_textbook_version"><a versionid="195846">人教版</a></div>';
    const books = '<div class="menu-item__navs"><a chapter-id="195860" href="/czsx/zj195860/">七年级上册</a></div>';
    r.current = {
      id: 'one',
      owner: '1',
      revision: 3,
      input: { kind: 'discovery' },
      target,
      expires: Date.now() + 60000,
      page: {
        url: () => target.url,
        evaluate: async (fn, arg) => {
          requests.push(arg);
          // Run the actual browser-side fetch function against a local stub.
          const original = global.fetch;
          global.fetch = async (url, init) => ({
            status: url === target.url ? 200 : apiStatus,
            headers: new Map(),
            text: async () => (url === target.url ? healthySeed : apiStatus === 200 ? books : '安全验证'),
            init,
          });
          try {
            return await fn(arg);
          } finally {
            global.fetch = original;
          }
        },
      },
    };
    let result = await r.check({ sessionId: 'one', owner: '1' });
    assert.equal(result.verified, false);
    apiStatus = 200;
    r.current.checkedAt = 0;
    result = await r.check({ sessionId: 'one', owner: '1' });
    assert.equal(result.verified, true);
    assert.match(result.message, /原失败教材列表接口/);
    assert.ok(requests.every((request) => request.url === target.request.url));
    assert.deepEqual(observed, [403, 200]);
    assert.equal(resumed(), 0);
  } finally {
    f.cleanup();
  }
});

test('入口失败复核版本列表，空响应和旧任务缺少上下文不能放行', async () => {
  const f = discoveryFixture('seed');
  try {
    const { recovery: r, manager } = fixture();
    manager.sourceControl.observe = () => {};
    const { recoveryTarget } = require('../src/api/manual_recovery.cjs');
    const target = recoveryTarget(f.dbPath, { kind: 'discovery', collectorJobId: 'metadata-one' });
    let html = '<div id="chapter_textbook_version"><a versionid="195846">人教版</a></div>';
    r.current = {
      id: 'one',
      owner: '1',
      revision: 3,
      input: { kind: 'discovery' },
      target,
      expires: Date.now() + 60000,
      page: { url: () => target.url, evaluate: async () => ({ status: 200, headers: {}, text: html }) },
    };
    assert.equal((await r.check({ sessionId: 'one', owner: '1' })).verified, true);
    r.current.checkedAt = 0;
    html = '<div id="chapter_textbook_version"></div>';
    assert.equal((await r.check({ sessionId: 'one', owner: '1' })).verified, false);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(f.dbPath);
    db.prepare('UPDATE collector_jobs SET payload_json=?').run('{}');
    db.close();
    assert.throws(() => recoveryTarget(f.dbPath, { kind: 'discovery', collectorJobId: 'metadata-one' }), /原失败请求/);
  } finally {
    f.cleanup();
  }
});

test('discovery failure context survives child events and persisted job reload', () => {
  const f = discoveryFixture();
  try {
    const { createProcessEventEmitter } = require('../src/jobs/events.cjs');
    const { EventMethods } = require('../src/api/job_manager/events.cjs');
    const { serializeJob } = require('../src/api/job_store.cjs');
    const { DatabaseSync } = require('node:sqlite');
    const { recoveryTarget } = require('../src/api/manual_recovery.cjs');
    const db = new DatabaseSync(f.dbPath);
    const job = { id: 'metadata-one', runType: 'metadata', status: 'running' };
    const manager = {
      scopeFor: () => null,
      persist: (row) =>
        db.prepare('UPDATE collector_jobs SET payload_json=? WHERE id=?').run(serializeJob(row), row.id),
    };
    const events = createProcessEventEmitter({
      channel: 'none',
      sink: (event) => EventMethods.prototype.handleEvent.call(manager, job, event),
    });
    events.emit('error', {
      code: 'challenge',
      blocked: true,
      message: '来源防护',
      stage: 'run',
      runId: 9,
      discoveryRequest: {
        stage: 'textbooks',
        seedUrl: 'https://zujuan.xkw.com/czsx/zj261314/o2/',
        versionId: '55474',
        urlTemplate: '/czsx/zj{0}/',
        cookie: 'must-not-persist',
      },
    });
    assert.equal(job.lastErrorEvent.discoveryRequest.cookie, undefined);
    db.close();
    const target = recoveryTarget(f.dbPath, { kind: 'discovery', collectorJobId: 'metadata-one' });
    assert.equal(new URL(target.request.url).searchParams.get('textbookVersionId'), '55474');
  } finally {
    f.cleanup();
  }
});
