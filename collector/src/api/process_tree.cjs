'use strict';

const fs = require('node:fs');

// Linux identity includes start time, not PID alone (which can be reused).
function processInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), ppid: Number(fields[1]), state: fields[0], start: fields[19] };
  } catch { return null; }
}

function descendants(root) {
  if (process.platform !== 'linux') return [];
  const rows = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(processInfo).filter(Boolean);
  const owned = new Set([Number(root)]);
  let previous;
  do {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
  } while (previous !== owned.size);
  return rows.filter(row => row.pid !== Number(root) && owned.has(row.pid));
}

function killOwned(rows = []) {
  for (const row of [...rows].reverse()) {
    const current = processInfo(row.pid);
    if (!current || current.start !== row.start || current.state === 'Z') continue;
    try { process.kill(row.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') console.warn(`[清理] 子进程 ${row.pid}: ${error.message}`);
    }
  }
}

module.exports = { descendants, killOwned, processInfo };
