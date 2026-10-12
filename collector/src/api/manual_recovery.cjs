'use strict';
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');
const { buildQuestionListRequest } = require('../sources/zujuan/request.cjs');
const { evaluateFetch } = require('../sources/zujuan/list_window.cjs');
const { classifyQuestionResponse } = require('../sources/zujuan/response_classifier.cjs');
const { parseQuestionListPayload } = require('../sources/zujuan/question_parser.cjs');
const { clearStaleProfileLock } = require('../sources/zujuan/session.cjs');
const { safeEqual } = require('./http.cjs');

function fail(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}
function recoveryTarget(dbPath, input) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const run = db.prepare('SELECT * FROM sync_runs WHERE id=?').get(input.collectorRunId);
    const node = db
      .prepare(
        'SELECT * FROM sync_run_catalog_items WHERE run_id=? AND textbook_external_id=? AND catalog_external_id=?',
      )
      .get(input.collectorRunId, input.textbookId, input.catalogId);
    if (!run?.snapshot_locked_at || !node) fail('没有匹配的已封存目录，无法检查原失败请求');
    if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1) fail('失败页码无效');
    const catalog = {
      externalId: node.catalog_external_id,
      categoryId: node.category_id || node.catalog_external_id,
      catelogTokpointId: node.catelog_tokpoint_id || '0',
    };
    return {
      url: `https://zujuan.xkw.com/czsx/zj${input.textbookId}/o2/`,
      request: buildQuestionListRequest({}, catalog, input.pageNumber),
      catalogName: node.name,
    };
  } finally {
    db.close();
  }
}
async function waitForVnc(child) {
  for (let i = 0; i < 40; i++) {
    if (child.exitCode != null) fail('远程画面启动失败，请查看采集器日志');
    const ready = await new Promise((resolve) => {
      const s = net.connect(5901, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('远程画面未就绪');
}
class ManualRecovery {
  constructor(manager) {
    this.manager = manager;
    this.current = null;
    manager.manualRecovery = this;
  }
  get active() {
    return Boolean(this.current);
  }
  require(input) {
    const s = this.current;
    if (!s || s.id !== input.sessionId || s.owner !== String(input.owner)) fail('人工处理会话已过期或由其他管理员持有');
    return s;
  }
  public(s) {
    return {
      sessionId: s.id,
      taskId: s.input.taskId,
      expiresAt: new Date(s.expires).toISOString(),
      url: s.target.url,
      catalogName: s.target.catalogName,
      pageNumber: s.input.pageNumber,
      verified: Boolean(s.verifiedAt),
      message: s.message || '请在下方浏览器完成人工验证，然后检查是否恢复',
    };
  }
  async open(input) {
    if (this.current) {
      if (this.current.owner === String(input.owner)) return this.public(this.current);
      fail('另一位管理员正在处理来源验证');
    }
    if (this.manager.activeJobId) fail('采集尚未结束，请等待成果封存后打开');
    const control = this.manager.sourceControl.status();
    if (!control.manualRequired) fail('当前来源没有待处理的人工验证');
    const target = recoveryTarget(this.manager.dbPath, input);
    const s = {
      id: randomUUID(),
      owner: String(input.owner),
      input,
      target,
      revision: control.revision,
      expires: Date.now() + 30 * 60 * 1000,
    };
    this.current = s;
    s.timer = setTimeout(() => void this.close({ sessionId: s.id, owner: s.owner }), 30 * 60 * 1000);
    s.timer.unref();
    try {
      clearStaleProfileLock(this.manager.profileDir);
      const { chromium } = require('playwright-core');
      s.context = await chromium.launchPersistentContext(this.manager.profileDir, {
        channel: 'chrome',
        headless: false,
        locale: 'zh-CN',
        viewport: { width: 1440, height: 900 },
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-crash-restore-bubble'],
      });
      s.page = s.context.pages()[0] || (await s.context.newPage());
      for (const page of s.context.pages()) if (page !== s.page) await page.close();
      s.vnc = spawn(
        'x11vnc',
        [
          '-display',
          process.env.DISPLAY,
          '-rfbport',
          '5901',
          '-localhost',
          '-forever',
          '-shared',
          '-nopw',
          '-noxdamage',
          '-quiet',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      s.vnc.on('error', (error) => {
        s.message = error.message;
      });
      s.vnc.stderr.on('data', () => {});
      await waitForVnc(s.vnc);
      await s.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
        s.message = '页面加载较慢，可在浏览器中刷新后继续处理';
      });
      await s.page.bringToFront();
      return this.public(s);
    } catch (error) {
      await this.close({ sessionId: s.id, owner: s.owner });
      throw error;
    }
  }
  async check(input) {
    const s = this.require(input);
    if (s.checking || Date.now() - (s.checkedAt || 0) < 10000) fail('请间隔 10 秒后再检查');
    const control = this.manager.sourceControl.status();
    if (control.notBefore && Date.parse(control.notBefore) > Date.now()) fail(`来源要求等待至 ${control.notBefore}`);
    if (control.revision !== s.revision) fail('来源状态已经变化，请关闭并重新打开处理');
    s.checking = true;
    s.checkedAt = Date.now();
    s.verifiedAt = null;
    try {
      if (new URL(s.page.url()).origin !== 'https://zujuan.xkw.com') fail('请先在浏览器返回组卷网题目页面');
      const result = await evaluateFetch(s.page, s.target.request.url, s.target.request);
      this.manager.sourceControl.observe(result.status, result.headers, { verification: false });
      const classification = classifyQuestionResponse(result);
      if (result.status !== 200 || classification.kind !== 'ok')
        fail(
          `仍未恢复：题目接口 HTTP ${result.status}，${classification.kind === 'verification' ? '仍返回验证/防护页面' : '请核对浏览器提示'}`,
        );
      const parsed = parseQuestionListPayload(result.text);
      if (!parsed.questionIds.length) fail('接口返回空题目列表，暂不能确认原失败页恢复');
      s.verifiedAt = Date.now();
      s.message = `检查成功：原失败页正常返回 ${parsed.questionIds.length} 道题，可以补采并恢复计划`;
    } catch (error) {
      s.message = String(error.message).slice(0, 500);
    } finally {
      s.checking = false;
    }
    return this.public(s);
  }
  validate(input) {
    const s = this.require(input);
    if (!s.verifiedAt || Date.now() - s.verifiedAt > 120000) fail('请先检查是否恢复，检查通过后两分钟内继续');
    if (this.manager.sourceControl.status().revision !== s.revision) fail('来源状态已变化，请重新处理');
    return s;
  }
  async finish(input) {
    const s = this.validate(input);
    const revision = s.revision;
    await this.close(input);
    return this.manager.sourceControl.resume(revision);
  }
  async close(input) {
    const s = this.require(input);
    if (s.closing) return;
    s.closing = true;
    clearTimeout(s.timer);
    clearTimeout(s.idle);
    s.socket?.close();
    try {
      await s.context?.close();
    } finally {
      if (s.vnc && s.vnc.exitCode == null) {
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            s.vnc.kill('SIGKILL');
            resolve();
          }, 2000);
          s.vnc.once('close', () => {
            clearTimeout(t);
            resolve();
          });
          s.vnc.kill('SIGTERM');
        });
      }
      this.current = null;
    }
    return { closed: true };
  }
  attach(server, token) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://collector');
      const s = this.current;
      if (
        url.pathname !== '/v1/manual-recovery/display' ||
        !safeEqual(req.headers.authorization, `Bearer ${token}`) ||
        !s ||
        s.id !== url.searchParams.get('sessionId') ||
        s.socket ||
        !s.vnc
      ) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        clearTimeout(s.idle);
        s.socket = ws;
        const tcp = net.connect(5901, '127.0.0.1');
        ws.on('message', (data) => tcp.write(data));
        tcp.on('data', (data) => {
          if (ws.readyState === 1) ws.send(data);
        });
        tcp.on('error', () => ws.close());
        tcp.on('close', () => ws.close());
        ws.on('error', () => tcp.destroy());
        ws.on('close', () => {
          tcp.destroy();
          s.socket = null;
          if (!s.closing) {
            s.idle = setTimeout(() => {
              if (this.current === s) void this.close({ sessionId: s.id, owner: s.owner });
            }, 90000);
            s.idle.unref();
          }
        });
      });
    });
  }
}
module.exports = { ManualRecovery, recoveryTarget };
