'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { clearStaleProfileLock } = require('../src/sources/zujuan/session.cjs');

function profileWithLock(target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-profile-'));
  fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
  fs.symlinkSync('/tmp/org.chromium.Chromium.abc/SingletonSocket', path.join(dir, 'SingletonSocket'));
  fs.symlinkSync('13796148224101845235', path.join(dir, 'SingletonCookie'));
  return dir;
}

test('来自其他主机（旧容器）的 SingletonLock 被识别为过期并连同 Socket/Cookie 一起清除', () => {
  const dir = profileWithLock('8531dc565cb9-470');
  try {
    const result = clearStaleProfileLock(dir, { hostname: '0993b688f1f8', isAlive: () => true });
    assert.equal(result.cleared, true);
    assert.equal(result.reason, 'other_host');
    assert.equal(result.lockHost, '8531dc565cb9');
    assert.equal(result.lockPid, 470);
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应被删除`);
      assert.throws(() => fs.lstatSync(path.join(dir, name)));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同主机但 pid 已死的锁被清除；同主机且 pid 存活的锁保留', () => {
  const host = os.hostname();
  const dead = profileWithLock(`${host}-999999`);
  try {
    const result = clearStaleProfileLock(dead, { isAlive: () => false });
    assert.equal(result.cleared, true);
    assert.equal(result.reason, 'dead_pid');
    assert.throws(() => fs.lstatSync(path.join(dead, 'SingletonLock')));
  } finally {
    fs.rmSync(dead, { recursive: true, force: true });
  }
  const live = profileWithLock(`${host}-${process.pid}`);
  try {
    const result = clearStaleProfileLock(live, { isAlive: () => true });
    assert.equal(result.cleared, false);
    assert.equal(result.reason, 'live');
    assert.ok(fs.lstatSync(path.join(live, 'SingletonLock')).isSymbolicLink(), '存活锁不能被删除');
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
  }
});

test('没有锁文件或没有 profile 目录时不报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-profile-empty-'));
  try {
    assert.deepEqual(clearStaleProfileLock(dir), { cleared: false, reason: 'no_lock' });
    assert.deepEqual(clearStaleProfileLock(''), { cleared: false, reason: 'no_profile' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
