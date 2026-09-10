'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const entry = path.resolve(__dirname, '../container-entrypoint.cjs');

function launch(options) {
  const code = `require(${JSON.stringify(entry)}).supervise(${JSON.stringify(options)}).then(code => { process.exitCode = code; });`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const done = new Promise(resolve => child.once('close', code => resolve({ code, output })));
  return { child, done, output: () => output };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('进程就绪超时');
}
const display = [process.execPath, '-e', 'require("fs").writeSync(3,"42\\n"); setInterval(()=>{},1000);'];

test('启动器：Xvfb 未就绪时不启动 API，启动失败清理子进程', async () => {
  const runner = launch({ displayCommand: [process.execPath, '-e', 'process.exit(3)'],
    apiCommand: [process.execPath, '-e', 'console.log("API_MUST_NOT_START")'], readyMs: 1000 });
  const result = await runner.done;
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.output, /API_MUST_NOT_START/);
});

test('启动器：SIGTERM 等待 API 清理，再退出 Xvfb；重复信号幂等', async () => {
  const runner = launch({ displayCommand: display, apiGraceMs: 1000,
    apiCommand: [process.execPath, '-e', `
      if(process.env.DISPLAY!==':42') process.exit(5);
      process.on('SIGTERM',()=>setTimeout(()=>{console.log('API_CLEANED');process.exit(0)},50));
      console.log('API_READY');setInterval(()=>{},1000);`] });
  await until(() => runner.output().includes('API_READY'));
  runner.child.kill('SIGTERM');
  runner.child.kill('SIGINT');
  const result = await runner.done;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /API_CLEANED/);
});

test('启动器：API 不响应 SIGTERM 时按期限强制终止', async () => {
  const runner = launch({ displayCommand: display, apiGraceMs: 50,
    apiCommand: [process.execPath, '-e', 'process.on("SIGTERM",()=>{});console.log("API_READY");setInterval(()=>{},1000);'] });
  await until(() => runner.output().includes('API_READY'));
  runner.child.kill('SIGTERM');
  await runner.done;
});

test('启动器：运行中显示服务死亡会停止 API 并报告失败', async () => {
  const runner = launch({ displayCommand: [process.execPath, '-e',
    'require("fs").writeSync(3,"42\\n");setTimeout(()=>process.exit(2),300);'],
    apiCommand: [process.execPath, '-e', 'console.log("API_READY");setInterval(()=>{},1000);'] });
  const result = await runner.done;
  assert.equal(result.code, 1);
  assert.match(result.output, /Xvfb 异常退出/);
});

function zombies() {
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      return /^State:\s+Z/m.test(status) ? [pid] : [];
    } catch { return []; }
  });
}

test('Linux --init：真实 Xvfb/Chromium 连续正常结束和停止后无累积僵尸',
  { skip: process.env.RUN_CONTAINER_LIFECYCLE !== '1', timeout: 90000 }, async () => {
    assert.equal(process.platform, 'linux');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-real-exit-'));
    const baseline = zombies().length;
    try {
      for (let round = 0; round < 4; round++) {
        const api = `
          const {chromium}=require('/work/node_modules/playwright-core');
          (async()=>{
            const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:false});
            const page=await browser.newPage();await page.setContent('<p>lifecycle test</p>');
            let closing;const close=()=>closing||(closing=browser.close());
            process.on('SIGTERM',()=>close().then(()=>process.exitCode=0));
            console.log('BROWSER_READY');
            if (${round % 2 === 0}) await close();
          })().catch(e=>{console.error(e);process.exitCode=1});`;
        const runner = launch({ apiCommand: [process.execPath, '-e', api] });
        try {
          await until(() => runner.output().includes('BROWSER_READY'));
          if (round % 2) runner.child.kill('SIGTERM');
          const result = await runner.done;
          assert.equal(result.code, 0, result.output);
          await until(() => zombies().length <= baseline);
          assert.equal(zombies().length, baseline);
        } finally { runner.child.kill('SIGTERM'); }
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
