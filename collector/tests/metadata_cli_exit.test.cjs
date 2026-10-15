'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');

async function runChild(args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, COLLECTOR_EVENT_CHANNEL: 'ipc' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stdout = '';
  let stderr = '';
  child.on('message', (value) => messages.push(value));
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 5000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(timedOut, false, `metadata CLI did not exit: ${stderr}`);
    return { code, messages, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

test('metadata CLI exits after cleanup and delivers final sealed IPC event', async () => {
  const result = await runChild([
    '-e',
    `
    const discovery = require.resolve('./src/jobs/metadata_run.cjs');
    const { createProcessEventEmitter } = require('./src/jobs/events.cjs');
    require.cache[discovery] = { id: discovery, filename: discovery, loaded: true, exports: {
      runDiscovery: async () => {
        const events = createProcessEventEmitter();
        events.emit('metadata_run_created', { runId: 42 });
        await new Promise(resolve => setTimeout(resolve, 30));
        console.log('CLEANUP_FINISHED');
        events.emit('metadata_summary', { runId: 42, status: 'success', versionCount: 26, textbookCount: 155 });
        events.emit('sealed', { runId: 42, status: 'success', snapshotComplete: true });
      }
    }};
    process.argv = [process.execPath, './zujuan_metadata_sync.cjs', '--acknowledge-source-policy'];
    require('node:module').runMain();
  `,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /CLEANUP_FINISHED/);
  assert.deepEqual(
    result.messages.map((x) => x.type),
    ['metadata_run_created', 'metadata_summary', 'sealed'],
  );
  assert.equal(result.messages.at(-1).snapshotComplete, true);
});

test('metadata CLI error keeps exit code 1 and delivers error without hanging', async () => {
  const result = await runChild(['zujuan_metadata_sync.cjs', '--no-such-flag']);
  assert.equal(result.code, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].type, 'error');
  assert.match(result.messages[0].message, /未知参数/);
});
