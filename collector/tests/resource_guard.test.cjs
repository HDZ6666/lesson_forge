'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('容器内存：page cache（inactive_file）不计入占用，避免写盘把可用内存算成 0', () => {
  const { availableMemory } = require('../src/policies/resource_guard.cjs');
  const MiB = 1024 * 1024;
  const files = {
    '/proc/meminfo': 'MemAvailable:   8000000 kB\n',
    '/sys/fs/cgroup/memory.max': `${2560 * MiB}\n`,
    '/sys/fs/cgroup/memory.current': `${2500 * MiB}\n`,
    '/sys/fs/cgroup/memory.stat': `anon ${900 * MiB}\nfile ${1600 * MiB}\ninactive_file ${1400 * MiB}\n`,
  };
  const read = (file) => {
    if (!(file in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[file];
  };
  const opts = { read, platform: 'linux', freemem: () => 64 * 1024 * MiB };
  assert.equal(availableMemory(opts), (2560 - (2500 - 1400)) * MiB);
  delete files['/sys/fs/cgroup/memory.stat'];
  assert.equal(availableMemory(opts), 60 * MiB);
  files['/sys/fs/cgroup/memory.max'] = 'max\n';
  assert.equal(availableMemory(opts), 8000000 * 1024);
  const v1 = {
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${1024 * MiB}`,
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${1000 * MiB}`,
    '/sys/fs/cgroup/memory/memory.stat': `cache 1\ntotal_inactive_file ${600 * MiB}\n`,
  };
  const readV1 = (file) => {
    if (!(file in v1)) throw new Error('ENOENT');
    return v1[file];
  };
  assert.equal(availableMemory({ ...opts, read: readV1 }), 624 * MiB);
});
