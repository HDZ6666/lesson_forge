'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StopCrawlError } = require('../shared/errors.cjs');
const { nonnegativeLimit } = require('./source_budget.cjs');
const MIB = 1024 * 1024;

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function statValue(text, key) {
  const match = new RegExp(`^${key}\\s+(\\d+)$`, 'm').exec(String(text || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * Memory the collector may still use, in bytes.
 *
 * Host: /proc/meminfo MemAvailable, which already counts reclaimable cache.
 *
 * Container: the cgroup limit minus the working set. memory.current (v1:
 * usage_in_bytes) also counts page cache, and a crawl that writes raw pages,
 * assets and SQLite fills that cache up to the limit, so `limit - current`
 * drifts toward zero while the kernel could free most of it on demand. That
 * would trigger browser recycles and then a memory stop for no reason. As
 * `docker stats` and the kubelet do, inactive_file (v1:
 * total_inactive_file) is subtracted first.
 */
function availableMemory({ read = readText, platform = process.platform, freemem = os.freemem } = {}) {
  let available = freemem();
  // Linux free pages exclude reclaimable cache. Match the kernel's available
  // estimate so normal filesystem caching does not create a false pause.
  if (platform === 'linux') {
    try {
      const value = read('/proc/meminfo').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
      if (value && Number.isSafeInteger(Number(value[1]) * 1024)) available = Number(value[1]) * 1024;
    } catch {} // Keep os.freemem() as the conservative fallback.
  }
  // Container memory may be far smaller than the host's os.freemem().
  for (const [limitPath, usedPath, statPath, inactiveKey] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.stat', 'inactive_file'],
    [
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes',
      '/sys/fs/cgroup/memory/memory.stat',
      'total_inactive_file',
    ],
  ]) {
    try {
      const limit = Number(read(limitPath).trim());
      const used = Number(read(usedPath).trim());
      if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(used) || used < 0) continue;
      let inactive = 0;
      try {
        inactive = statValue(read(statPath), inactiveKey);
      } catch {} // Without memory.stat, fall back to the raw usage.
      const workingSet = Math.max(0, used - Math.min(inactive, used));
      available = Math.min(available, Math.max(0, limit - workingSet));
      break;
    } catch {} // macOS or an unrestricted/non-cgroup host.
  }
  return available;
}

function availableDisk(target) {
  let parent = path.resolve(target);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error('无法检查采集存储空间');
    parent = next;
  }
  const stat = fs.statfsSync(parent);
  return Number(stat.bavail) * Number(stat.bsize);
}

class ResourcePressureError extends StopCrawlError {
  constructor(state) {
    super(state.reason, 'resource_pressure');
    this.name = 'ResourcePressureError';
    this.statusCode = 423;
    this.blocked = true;
    this.resources = state;
  }
}

class ResourceGuard {
  constructor({
    paths = {},
    minDiskMiB,
    minMemoryMiB,
    softMemoryMiB,
    memoryGraceMs,
    clock = Date.now,
    diskReader = availableDisk,
    memoryReader = availableMemory,
  } = {}) {
    this.paths = paths;
    this.limits = {
      minDiskMiB: nonnegativeLimit(
        minDiskMiB ?? process.env.COLLECTOR_MIN_DISK_FREE_MIB,
        'COLLECTOR_MIN_DISK_FREE_MIB',
      ),
      minMemoryMiB: nonnegativeLimit(
        minMemoryMiB ?? process.env.COLLECTOR_MIN_MEMORY_FREE_MIB,
        'COLLECTOR_MIN_MEMORY_FREE_MIB',
      ),
      // Soft watermark: below it the crawler recycles its browser at the next
      // safe point instead of stopping.  0 disables the soft tier.
      softMemoryMiB: nonnegativeLimit(
        softMemoryMiB ?? process.env.COLLECTOR_SOFT_MEMORY_FREE_MIB,
        'COLLECTOR_SOFT_MEMORY_FREE_MIB',
      ),
      // Hard watermark grace: memory must stay below minMemoryMiB for this
      // long before work is refused.  0 keeps the historical instant stop.
      memoryGraceMs: nonnegativeLimit(
        memoryGraceMs ?? process.env.COLLECTOR_MEMORY_GRACE_MS,
        'COLLECTOR_MEMORY_GRACE_MS',
      ),
    };
    this.clock = clock;
    this.diskReader = diskReader;
    this.memoryReader = memoryReader;
    this.cached = null;
    this.memoryLowSince = null;
  }

  status({ fresh = false } = {}) {
    const now = this.clock();
    if (!fresh && this.cached && now >= this.cached.at && now - this.cached.at < 1000) return this.cached.state;
    const reasons = [];
    let memoryMiB = null;
    const disks = [];
    try {
      const free = this.memoryReader();
      if (!Number.isFinite(free) || free < 0) throw new Error('unknown');
      memoryMiB = Math.floor(free / MIB);
      if (memoryMiB < this.limits.minMemoryMiB) {
        if (this.memoryLowSince == null) this.memoryLowSince = now;
        // A single low sample (Chrome GC, an import burst) must not end a
        // multi-hour run; only a sustained shortage does.
        if (now - this.memoryLowSince >= this.limits.memoryGraceMs) reasons.push('采集主机可用内存低于保留水位');
      } else {
        this.memoryLowSince = null;
      }
    } catch {
      if (this.limits.minMemoryMiB > 0) reasons.push('无法确认采集主机可用内存');
    }
    for (const [kind, target] of Object.entries(this.paths)) {
      let freeMiB = null;
      try {
        const free = this.diskReader(target);
        if (!Number.isFinite(free) || free < 0) throw new Error('unknown');
        freeMiB = Math.floor(free / MIB);
        if (freeMiB < this.limits.minDiskMiB) reasons.push(`采集存储 ${kind} 可用空间低于保留水位`);
      } catch {
        if (this.limits.minDiskMiB > 0) reasons.push(`无法确认采集存储 ${kind} 可用空间`);
      }
      // Never expose a host filesystem path in the API projection.
      disks.push({ kind, freeMiB });
    }
    const memoryLow = memoryMiB != null && memoryMiB < this.limits.minMemoryMiB;
    const memorySoft =
      memoryMiB != null && (memoryLow || (this.limits.softMemoryMiB > 0 && memoryMiB < this.limits.softMemoryMiB));
    const state = {
      paused: reasons.length > 0,
      reason: reasons.join('；') || null,
      // `pressure` lets the crawler react before `paused`: soft means
      // recycle the browser at the next safe point; low means the hard
      // watermark is crossed but its grace period has not yet elapsed.
      pressure: reasons.length > 0 ? 'paused' : memoryLow ? 'low' : memorySoft ? 'soft' : 'ok',
      memoryLowSince: this.memoryLowSince == null ? null : new Date(this.memoryLowSince).toISOString(),
      manualRequired: false,
      notBefore: reasons.length ? new Date(now + 30000).toISOString() : null,
      limits: this.limits,
      memoryMiB,
      disks,
      diskAndMemoryLimitsConfigured: this.limits.minDiskMiB > 0 && this.limits.minMemoryMiB > 0,
    };
    this.cached = { at: now, state };
    return state;
  }

  assertAllowed() {
    const state = this.status();
    if (state.paused) throw new ResourcePressureError(state);
  }
}

module.exports = { ResourceGuard, ResourcePressureError, availableDisk, availableMemory };
