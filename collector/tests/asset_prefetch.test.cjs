'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { prefetchAssets } = require('../src/assets/download.cjs');
const { CollectorJobManager } = require('../server.cjs');
const { parseArgs } = require('../zujuan_question_sync.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('素材预取：有界并发、按 URL 去重、跳过已缓存、成功与失败都写入缓存', async () => {
  const cache = new Map([['https://staticzujuan.xkw.com/cached.png', { contentSha256: 'cached' }]]);
  const assets = [
    { sourceUrl: 'https://staticzujuan.xkw.com/a.png' },
    { sourceUrl: 'https://staticzujuan.xkw.com/a.png' },
    { url: 'https://staticzujuan.xkw.com/b.png' },
    { sourceUrl: 'https://staticzujuan.xkw.com/c.png' },
    { sourceUrl: 'https://staticzujuan.xkw.com/d.png' },
    { sourceUrl: 'https://staticzujuan.xkw.com/cached.png' },
    { sourceUrl: '' },
  ];
  let inFlight = 0;
  let peak = 0;
  const downloaded = [];
  const summary = await prefetchAssets(assets, {
    concurrency: 2,
    cache,
    download: async (asset) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(15);
      inFlight -= 1;
      const url = asset.sourceUrl || asset.url;
      downloaded.push(url);
      if (url.endsWith('c.png')) {
        const error = new Error('素材 404');
        error.code = 'asset_http_404';
        throw error;
      }
      return { ...asset, sourceUrl: url, contentSha256: `sha-${path.basename(url)}` };
    },
  });
  assert.equal(summary.requested, 4, '四个唯一 URL，已缓存的不再请求');
  assert.equal(summary.downloaded, 3);
  assert.equal(summary.failed, 1);
  assert.equal(peak, 2, '并发不超过配置');
  assert.equal(summary.peakInFlight, 2);
  assert.deepEqual([...downloaded].sort(), [
    'https://staticzujuan.xkw.com/a.png',
    'https://staticzujuan.xkw.com/b.png',
    'https://staticzujuan.xkw.com/c.png',
    'https://staticzujuan.xkw.com/d.png',
  ]);
  assert.equal(cache.get('https://staticzujuan.xkw.com/a.png').contentSha256, 'sha-a.png');
  const failure = cache.get('https://staticzujuan.xkw.com/c.png');
  assert.equal(failure.downloadFailed, true);
  assert.equal(failure.errorCode, 'asset_http_404');
  assert.equal(cache.get('https://staticzujuan.xkw.com/cached.png').contentSha256, 'cached');
});

test('素材预取：磁盘存储错误是致命错误，原样抛出并停止派发', async () => {
  const cache = new Map();
  let calls = 0;
  await assert.rejects(
    () =>
      prefetchAssets(
        Array.from({ length: 10 }, (_, index) => ({ sourceUrl: `https://staticzujuan.xkw.com/${index}.png` })),
        {
          concurrency: 1,
          cache,
          download: async () => {
            calls += 1;
            const error = new Error('磁盘写入失败');
            error.code = 'asset_storage_error';
            throw error;
          },
        },
      ),
    (error) => error.code === 'asset_storage_error',
  );
  assert.equal(calls, 1, '第一个致命错误后不再继续下载');
  assert.equal(cache.size, 0, '致命错误不写入失败缓存');
});

test('CLI：--asset-concurrency 默认 8、可配置、超过上限拒绝', () => {
  assert.equal(parseArgs(['--textbook-id', '260617']).assetConcurrency, 8);
  assert.equal(parseArgs(['--textbook-id', '260617', '--asset-concurrency', '16']).assetConcurrency, 16);
  assert.throws(
    () => parseArgs(['--textbook-id', '260617', '--asset-concurrency', '64']),
    /asset-concurrency 不能超过 32/,
  );
});

test('服务端：部署环境变量决定采集节奏参数并透传给子进程，请求体不能覆盖', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-tuning-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  let seenArgs = null;
  const manager = new CollectorJobManager({
    dbPath,
    listConcurrency: '12',
    assetConcurrency: '16',
    delayMinMs: '1000',
    delayMaxMs: '2000',
    spawnImpl(_node, args) {
      seenArgs = args;
      const { EventEmitter } = require('node:events');
      const { PassThrough } = require('node:stream');
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 2147483647;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 1, null);
      });
      return child;
    },
  });
  try {
    const started = manager.start({
      runType: 'content',
      acknowledgeSourcePolicy: true,
      maxPages: 1,
      textbookExternalIds: ['tb1'],
      textbookScopes: [
        {
          sourceProvider: 'zujuan',
          externalVersionId: 'v1',
          externalTextbookId: 'tb1',
          versionName: '测试版',
          textbookName: '教材 tb1',
          // A request must not be able to raise pressure on the source.
          concurrency: 16,
          assetConcurrency: 32,
          delayMin: 0,
        },
      ],
    });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !['failed', 'blocked'].includes(manager.get(started.id)?.status)) {
      await sleep(10);
    }
    assert.ok(seenArgs, '子进程应被启动');
    const flag = (name) => seenArgs[seenArgs.indexOf(name) + 1];
    assert.equal(flag('--concurrency'), '12');
    assert.equal(flag('--asset-concurrency'), '16');
    assert.equal(flag('--delay-min'), '1000');
    assert.equal(flag('--delay-max'), '2000');
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.throws(
    () => new CollectorJobManager({ dbPath: path.join(os.tmpdir(), 'x.sqlite3'), listConcurrency: '99', store: null }),
    /COLLECTOR_LIST_CONCURRENCY/,
  );
  assert.throws(
    () =>
      new CollectorJobManager({
        dbPath: path.join(os.tmpdir(), 'x.sqlite3'),
        delayMinMs: '5000',
        delayMaxMs: '1000',
        store: null,
      }),
    /COLLECTOR_DELAY_MAX_MS 不能小于/,
  );
});

test('服务端：未配置节奏变量时不向子进程传任何节奏参数（保持 CLI 默认）', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-tuning-default-'));
  let seenArgs = null;
  const manager = new CollectorJobManager({
    dbPath: path.join(directory, 'collector.sqlite3'),
    // Explicitly model an unconfigured deployment, regardless of the test
    // runner's real operator settings.
    listConcurrency: '',
    assetConcurrency: '',
    delayMinMs: '',
    delayMaxMs: '',
    spawnImpl(_node, args) {
      seenArgs = args;
      const { EventEmitter } = require('node:events');
      const { PassThrough } = require('node:stream');
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 2147483647;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 1, null);
      });
      return child;
    },
  });
  try {
    const started = manager.start({
      runType: 'content',
      acknowledgeSourcePolicy: true,
      maxPages: 1,
      textbookExternalIds: ['tb1'],
      textbookScopes: [
        {
          sourceProvider: 'zujuan',
          externalVersionId: 'v1',
          externalTextbookId: 'tb1',
          versionName: '测试版',
          textbookName: '教材 tb1',
        },
      ],
    });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !['failed', 'blocked'].includes(manager.get(started.id)?.status)) await sleep(10);
    for (const flag of ['--concurrency', '--asset-concurrency', '--delay-min', '--delay-max']) {
      assert.equal(seenArgs.includes(flag), false, `${flag} 不应出现`);
    }
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
