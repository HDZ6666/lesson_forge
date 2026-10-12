#!/usr/bin/env node
'use strict';

// Both children are spawned by this process, so Node/libuv reaps them.
// Docker --init additionally adopts/reaps orphaned Chromium descendants.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { descendants, killOwned } = require('./src/api/process_tree.cjs');

async function supervise(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const children = new Set();
  const closing = new Map();
  const timers = new Set();
  let stopping = false;
  let exitCode = 0;
  let api;
  let xvfb;
  let shutdownPromise;
  const launch = (command, args, config) => {
    const child = spawnImpl(command, args, config);
    children.add(child);
    closing.set(
      child,
      new Promise((resolve) => {
        child.once('error', (error) => {
          console.error(`[启动失败] ${error.message}`);
          exitCode = 1;
        });
        child.once('close', (code) => {
          children.delete(child);
          resolve(code);
        });
      }),
    );
    return child;
  };
  const stopChild = async (child, grace) => {
    if (!child || !children.has(child)) return;
    const owned = descendants(child.pid);
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (children.has(child)) child.kill('SIGKILL');
    }, grace);
    timers.add(timer);
    await closing.get(child);
    killOwned(owned);
    clearTimeout(timer);
    timers.delete(timer);
  };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      // Keep display available until the API has closed its browser contexts.
      await stopChild(api, options.apiGraceMs ?? 75000);
      await stopChild(xvfb, options.displayGraceMs ?? 5000);
    })();
    return shutdownPromise;
  };
  const signal = () => {
    void shutdown();
  };
  process.on('SIGTERM', signal);
  process.on('SIGINT', signal);
  try {
    // Let Xorg select an unused display and report it only when listening.
    // No blind deletion of .X99-lock; stale/fixed display 99 is not reused.
    const displayCommand = options.displayCommand || [
      'Xvfb',
      '-displayfd',
      '3',
      '-screen',
      '0',
      '1440x1000x24',
      '-nolisten',
      'tcp',
    ];
    xvfb = launch(displayCommand[0], displayCommand.slice(1), { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
    const display = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Xvfb 就绪超时')), options.readyMs ?? 10000);
      timers.add(timer);
      const done = (fn) => (value) => {
        clearTimeout(timer);
        timers.delete(timer);
        fn(value);
      };
      xvfb.once('error', done(reject));
      xvfb.once(
        'close',
        done(() => reject(new Error('Xvfb 未就绪即退出'))),
      );
      xvfb.stdio[3].on('data', (chunk) => {
        buffer += chunk.toString();
        if (/^\d+\n/.test(buffer)) done(resolve)(`:${buffer.trim()}`);
        else if (buffer.length > 32) done(reject)(new Error('Xvfb 返回无效显示号'));
      });
    });
    if (stopping || !children.has(xvfb)) return exitCode;
    const apiCommand = options.apiCommand || [process.execPath, path.join(__dirname, 'server.cjs')];
    api = launch(apiCommand[0], apiCommand.slice(1), {
      env: { ...process.env, DISPLAY: display },
      stdio: 'inherit',
    });
    console.log(`[环境] Xvfb ${display} 已就绪`);
    await Promise.race([
      closing.get(api).then((code) => {
        if (!stopping) exitCode = code === 0 ? 0 : 1;
      }),
      closing.get(xvfb).then(() => {
        if (!stopping) {
          console.error('[环境] Xvfb 异常退出');
          exitCode = 1;
        }
      }),
    ]);
  } catch (error) {
    if (!stopping) {
      console.error(`[启动失败] ${error.message}`);
      exitCode = 1;
    }
  } finally {
    await shutdown();
    for (const timer of timers) clearTimeout(timer);
    process.off('SIGTERM', signal);
    process.off('SIGINT', signal);
  }
  return exitCode;
}

if (require.main === module) {
  supervise()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
module.exports = { supervise };
