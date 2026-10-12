'use strict';

const fs = require('node:fs');

// Linux identity includes start time, not PID alone (which can be reused).
function processInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), ppid: Number(fields[1]), state: fields[0], start: fields[19] };
  } catch {
    return null;
  }
}

function descendants(root) {
  if (process.platform !== 'linux') return [];
  const rows = fs
    .readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(processInfo)
    .filter(Boolean);
  const owned = new Set([Number(root)]);
  let previous;
  do {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
  } while (previous !== owned.size);
  return rows.filter((row) => row.pid !== Number(root) && owned.has(row.pid));
}

function killOwned(rows = []) {
  for (const row of [...rows].reverse()) {
    const current = processInfo(row.pid);
    if (!current || current.start !== row.start || current.state === 'Z') continue;
    try {
      process.kill(row.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') console.warn(`[清理] 子进程 ${row.pid}: ${error.message}`);
    }
  }
}

// Proportional set size (falls back to RSS) of one process, in bytes.  PSS
// splits shared pages between the processes that map them, so summing it over
// a Chrome process tree does not count the shared renderer/GPU pages N times.
function processMemoryBytes(pid) {
  try {
    const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const pss = rollup.match(/^Pss:\s+(\d+)\s+kB$/m);
    if (pss) return Number(pss[1]) * 1024;
  } catch {} // Older kernels or a process that just exited.
  try {
    const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/);
    const pages = Number(statm[1]);
    if (Number.isFinite(pages)) return pages * 4096;
  } catch {}
  return 0;
}

// Memory of every descendant of `root` (the browser started by a collector
// child), excluding `root` itself.  Returns null where /proc is unavailable so
// callers can tell "unknown" from "zero".
function descendantsMemoryMb(root = process.pid, { list = descendants, read = processMemoryBytes } = {}) {
  if (process.platform !== 'linux' && list === descendants) return null;
  let total = 0;
  for (const row of list(root)) total += Number(read(row.pid)) || 0;
  return Math.round(total / (1024 * 1024));
}

module.exports = { descendants, descendantsMemoryMb, killOwned, processInfo, processMemoryBytes };
