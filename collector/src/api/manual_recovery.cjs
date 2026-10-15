'use strict';
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');
const { buildQuestionListRequest } = require('../sources/zujuan/request.cjs');
const { evaluateFetch } = require('../sources/zujuan/list_window.cjs');
const { classifyHtmlProtection, classifyQuestionResponse } = require('../sources/zujuan/response_classifier.cjs');
const { DEFAULT_SEED_URL } = require('../sources/zujuan/constants.cjs');
const { ALLOWED_PAGE_HOSTS, assertAllowedUrl } = require('../shared/url_policy.cjs');
const { parseQuestionListPayload } = require('../sources/zujuan/question_parser.cjs');
const { launchCollectorContext } = require('../sources/zujuan/session.cjs');
const { safeEqual } = require('./http.cjs');

function fail(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}
// Textbook discovery fails on the seed page or the textbook-list request,
// not on a question page, so it is re-checked against its own request.
function discoveryTarget(input) {
  const url = input.seedUrl || DEFAULT_SEED_URL;
  assertAllowedUrl(url, ALLOWED_PAGE_HOSTS);
  return { kind: 'discovery', url, request: { url, method: 'GET' }, catalogName: '教材清单发现' };
}
function recoveryTarget(dbPath, input) {
  if (input.kind === 'discovery') return discoveryTarget(input);
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
// Bytes queued toward the browser before VNC reads are paused. A full-screen
// frame is a few MB. Without a cap a slow admin connection made the API
// buffer the framebuffer stream without bound.
const BRIDGE_HIGH_WATER = 4 * 1024 * 1024;
const BRIDGE_LOW_WATER = 1024 * 1024;

/**
 * Pipes a WebSocket and a TCP socket in both directions with flow control.
 * Each side pauses reading while the other side has too much queued and
 * resumes once that queue has drained.
 */
function bridgeWithBackpressure(ws, tcp, { high = BRIDGE_HIGH_WATER, low = BRIDGE_LOW_WATER } = {}) {
  const stats = { pausedTcp: 0, pausedWs: 0 };
  const resumeTcp = () => {
    if (tcp.isPaused() && ws.bufferedAmount <= low) tcp.resume();
  };
  tcp.on('data', (data) => {
    if (ws.readyState !== 1) return;
    ws.send(data, resumeTcp);
    if (ws.bufferedAmount > high && !tcp.isPaused()) {
      stats.pausedTcp += 1;
      tcp.pause();
    }
  });
  ws.on('message', (data) => {
    if (!tcp.write(data) && !ws.isPaused) {
      stats.pausedWs += 1;
      ws.pause();
    }
  });
  tcp.on('drain', () => {
    if (ws.isPaused) ws.resume();
  });
  tcp.on('error', () => ws.close());
  tcp.on('close', () => ws.close());
  ws.on('error', () => tcp.destroy());
  ws.on('close', () => tcp.destroy());
  return stats;
}
class ManualRecovery {
  constructor(manager, { launch = launchCollectorContext } = {}) {
    this.manager = manager;
    this.launch = launch;
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
      // Same launch path as the crawl: stale-lock cleanup, clean-exit marker,
      // shared flags, stale-tab dismissal. Only the window stays visible.
      s.context = await this.launch(require('playwright-core'), {
        profileDir: this.manager.profileDir,
        headless: false,
        minimize: false,
        viewport: { width: 1440, height: 900 },
        timeout: 30000,
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
      if (s.target.kind === 'discovery') {
        await this.checkDiscovery(s);
        return this.public(s);
      }
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
  async checkDiscovery(s) {
    const result = await s.page.evaluate(async (target) => {
      try {
        const response = await fetch(target, { credentials: 'include', headers: { Accept: 'text/html' } });
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return { status: response.status, headers, text: await response.text() };
      } catch (error) {
        return { status: 0, headers: {}, text: '', networkError: String(error?.message || error) };
      }
    }, s.target.request.url);
    this.manager.sourceControl.observe(result.status, result.headers, { verification: false });
    const protection = classifyHtmlProtection(result.text);
    if (result.status !== 200 || protection.terminalBlock || protection.transientChallenge || !protection.hasContent)
      fail(
        `仍未恢复：教材清单页面 HTTP ${result.status}，${protection.hasContent ? '请核对浏览器提示' : '仍返回验证/防护页面或缺少教材内容'}`,
      );
    s.verifiedAt = Date.now();
    s.message = '检查成功：教材清单页面正常返回，可以恢复教材发现';
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
        bridgeWithBackpressure(ws, tcp);
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
module.exports = { ManualRecovery, bridgeWithBackpressure, recoveryTarget };
