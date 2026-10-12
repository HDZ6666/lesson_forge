'use strict';

const diagnostics = require('../shared/diagnostics.cjs');

/**
 * HTTP routes of the collector API.  Only fixed job types and bounded
 * read-only snapshot queries are exposed; see collector/README.md.
 */

const http = require('node:http');

const {
  readCandidates,
  readCatalogProgress,
  readMetadataSnapshot,
  readRunAsset,
  readRunCatalogs,
  readRunQuestion,
  readRunQuestions,
  readRunSnapshot,
  readRunSnapshotPage,
  readRunSnapshotSummary,
  validateMetadataSelection,
} = require('../storage/readers/index.cjs');
const { readJson, safeEqual, sendAssetResponse, sendJson } = require('./http.cjs');
const { CollectorJobManager, intInRange } = require('./job_manager.cjs');
const { publicJob } = require('./progress.cjs');
const { collectorReadiness } = require('../policies/collector_readiness.cjs');
const { reclaimRun } = require('../storage/result_cleanup.cjs');
const { readFailurePage } = require('../storage/failure_pages.cjs');

function queryBoolean(url, key) {
  const value = url.searchParams.get(key);
  if (value != null && !['true', 'false'].includes(value.toLowerCase())) {
    throw new Error(`${key} 必须是 true 或 false`);
  }
  return value?.toLowerCase() === 'true';
}

function createCollectorServer(options = {}) {
  const token = String(options.token ?? process.env.COLLECTOR_API_TOKEN ?? '');
  const manager = options.manager || new CollectorJobManager(options);
  const {ManualRecovery}=require('./manual_recovery.cjs');
  const recovery=new ManualRecovery(manager);
  const server = http.createServer(async (request, response) => {
    const started=performance.now();
    const supplied=String(request.headers['x-lesson-request-id'] || '');
    const requestId=/^[a-f0-9-]{32,36}$/i.test(supplied)?supplied:require('node:crypto').randomUUID();
    const detail={requestId,method:request.method,url:diagnostics.safeUrl(request.url)};
    diagnostics.write('collector_api_started',detail);
    let finished=false;
    response.once('finish',()=>{finished=true;diagnostics.write('collector_api_finished',{...detail,status:response.statusCode,elapsedMs:Math.round(performance.now()-started)});});
    response.once('close',()=>{if(!finished)diagnostics.write('collector_api_aborted',{...detail,status:response.statusCode,elapsedMs:Math.round(performance.now()-started)});});
    try {
      const url = new URL(request.url || '/', 'http://collector.local');
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, manager.stopping ? 503 : 200, { ok: !manager.stopping, service: 'lesson-bank-collector' });
        return;
      }
      if (token) {
        const authorization = String(request.headers.authorization || '');
        if (!authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), token)) {
          sendJson(response, 401, { error: { code: 'unauthorized', message: '采集器 API 认证失败' } });
          return;
        }
      }
      if (request.method === 'POST' && url.pathname.startsWith('/v1/manual-recovery/')) {
        const action=url.pathname.split('/').pop();
        if(!['open','check','validate','finish','close'].includes(action))throw new Error('未知人工处理操作');
        const result=await recovery[action](await readJson(request));
        sendJson(response,200,action==='validate'?recovery.public(result):result);return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'lesson-bank-collector',
          activeJobId: manager.activeJobId,
          ...collectorReadiness(manager),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/source-control') {
        sendJson(response, 200, manager.sourceControl.status());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/source-budget') {
        sendJson(response, 200, manager.sourceBudget.status());
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/source-budget') {
        sendJson(response, 200, manager.sourceBudget.updateSettings(await readJson(request)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/source-control/resume') {
        // Deployment token is checked above. No provider/session override.
        if(recovery.active || manager.sourceControl.status().manualRequired) { sendJson(response,409,{error:{message:'请通过打开浏览器处理、检查恢复后再继续'}}); return; }
        const body = await readJson(request);
        sendJson(response, 200, manager.sourceControl.resume(body.expectedRevision));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/jobs') {
        sendJson(response, 202, manager.start(await readJson(request)));
        return;
      }
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && jobMatch) {
        const job = manager.get(jobMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: { code: 'job_not_found', message: '采集任务不存在' } });
          return;
        }
        sendJson(response, 200, publicJob(job, { dbPath: manager.dbPath }));
        return;
      }
      const failurePageMatch = url.pathname.match(/^\/v1\/metadata\/runs\/(\d+)\/failure-page$/);
      if (request.method === 'GET' && failurePageMatch) {
        sendJson(response, 200, readFailurePage(manager.dataDir, Number(failurePageMatch[1])));
        return;
      }
      const cleanupMatch = url.pathname.match(/^\/v1\/runs\/(\d+)\/reclaim$/);
      if (request.method === 'POST' && cleanupMatch) {
        const body = await readJson(request);
        if (manager.activeJobId) { sendJson(response, 409, {error:{code:'cleanup_busy',message:'采集进行中，稍后自动回收'}}); return; }
        sendJson(response, 200, reclaimRun(manager.dbPath, manager.dataDir, cleanupMatch[1], body));
        return;
      }
      const runCatalogMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/catalogs\/?$/i);
      const catalogPreviewMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/catalogs-preview\/?$/i);
      if (request.method === 'POST' && catalogPreviewMatch) {
        sendJson(response, 200, readRunCatalogs(manager.dbPath, decodeURIComponent(catalogPreviewMatch[1]), await readJson(request, 8 * 1024 * 1024)));
        return;
      }
      if (request.method === 'GET' && runCatalogMatch) {
        sendJson(response, 200, readRunCatalogs(manager.dbPath, decodeURIComponent(runCatalogMatch[1]), {
          textbookExternalId: url.searchParams.get('textbookExternalId'),
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
        }));
        return;
      }
      const runSnapshotPageMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/snapshot-page\/?$/i);
      if (request.method === 'GET' && runSnapshotPageMatch) {
        sendJson(response, 200, readRunSnapshotPage(
          manager.dbPath,
          decodeURIComponent(runSnapshotPageMatch[1]),
          {
            collection: url.searchParams.get('collection'),
            textbookExternalId: url.searchParams.get('textbookExternalId'),
            cursor: url.searchParams.get('cursor'),
            pageSize: url.searchParams.get('pageSize'),
            sealedForImport: queryBoolean(url, 'sealedForImport'),
          },
        ));
        return;
      }
      const runAssetMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/assets\/([^/]+)\/?$/i);
      if (request.method === 'GET' && runAssetMatch) {
        const asset = readRunAsset(
          manager.dbPath,
          decodeURIComponent(runAssetMatch[1]),
          decodeURIComponent(runAssetMatch[2]),
          {
            textbookExternalId: url.searchParams.get('textbookExternalId'),
            dataDir: manager.dataDir,
            sealedForImport: queryBoolean(url, 'sealedForImport'),
          },
        );
        sendAssetResponse(response, asset);
        return;
      }
      const runSnapshotMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/snapshot\/?$/i);
      if (request.method === 'GET' && runSnapshotMatch) {
        sendJson(response, 200, readRunSnapshot(
          manager.dbPath,
          decodeURIComponent(runSnapshotMatch[1]),
          { textbookExternalId: url.searchParams.get('textbookExternalId') },
        ));
        return;
      }
      const runSnapshotSummaryMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/snapshot-summary\/?$/i);
      if (request.method === 'GET' && runSnapshotSummaryMatch) {
        const rawAllowIncomplete = url.searchParams.get('allowIncomplete');
        if (rawAllowIncomplete != null && !['true', 'false'].includes(rawAllowIncomplete.toLowerCase())) {
          throw new Error('allowIncomplete 必须是 true 或 false');
        }
        const allowIncomplete = rawAllowIncomplete?.toLowerCase() === 'true';
        sendJson(response, 200, readRunSnapshotSummary(
          manager.dbPath,
          decodeURIComponent(runSnapshotSummaryMatch[1]),
          {
            textbookExternalId: url.searchParams.get('textbookExternalId'),
            allowIncomplete,
            sealedForImport: queryBoolean(url, 'sealedForImport'),
          },
        ));
        return;
      }
      const runQuestionDetailMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/questions\/([^/]+)\/?$/i);
      if (request.method === 'GET' && runQuestionDetailMatch) {
        sendJson(response, 200, readRunQuestion(
          manager.dbPath,
          decodeURIComponent(runQuestionDetailMatch[1]),
          decodeURIComponent(runQuestionDetailMatch[2]),
          { textbookExternalId: url.searchParams.get('textbookExternalId') },
        ));
        return;
      }
      const runQuestionsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/questions\/?$/i);
      const previewMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/questions-preview\/?$/i);
      if (request.method === 'POST' && previewMatch) {
        const body = await readJson(request, 8 * 1024 * 1024);
        sendJson(response, 200, readRunQuestions(manager.dbPath, decodeURIComponent(previewMatch[1]), body));
        return;
      }
      if (request.method === 'GET' && runQuestionsMatch) {
        sendJson(response, 200, readRunQuestions(manager.dbPath, decodeURIComponent(runQuestionsMatch[1]), {
          textbookExternalId: url.searchParams.get('textbookExternalId'),
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
          catalogExternalId: url.searchParams.get('catalogExternalId'),
          questionType: url.searchParams.get('questionType'),
          keyword: url.searchParams.get('keyword'),
        }));
        return;
      }
      const cancelMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)\/cancel$/i);
      if (request.method === 'POST' && cancelMatch) {
        const body = await readJson(request);
        if (body.reserveDispatch != null && typeof body.reserveDispatch !== 'boolean') {
          throw new Error('reserveDispatch 必须是布尔值');
        }
        const job = manager.cancel(cancelMatch[1], { reserveDispatch: body.reserveDispatch === true });
        if (!job) {
          sendJson(response, 404, { error: { code: 'job_not_found', message: '采集任务不存在' } });
          return;
        }
        sendJson(response, 200, job);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/metadata/validate') {
        const body = await readJson(request);
        const runId = intInRange(body.metadataRunId, 'metadataRunId', 1, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, validateMetadataSelection(manager.dbPath, runId, body.textbookExternalIds));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/metadata/snapshot') {
        const rawRunId = url.searchParams.get('metadataRunId');
        const runId = rawRunId == null ? null : intInRange(rawRunId, 'metadataRunId', 1, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, readMetadataSnapshot(manager.dbPath, runId));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/candidates') {
        const entityType = url.searchParams.get('entityType') || '';
        const rawRunId = url.searchParams.get('metadataRunId');
        const metadataRunId = rawRunId == null ? null : intInRange(rawRunId, 'metadataRunId', 1, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, readCandidates(manager.dbPath, entityType, {
          provider: url.searchParams.get('provider'),
          textbookExternalId: url.searchParams.get('textbookExternalId'),
          metadataRunId,
        }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/catalog-progress') {
        sendJson(response, 200, readCatalogProgress(manager.dbPath));
        return;
      }
      sendJson(response, 404, { error: { code: 'not_found', message: 'API 路由不存在' } });
    } catch (error) {
      const statusCode = Number(error.statusCode || 400);
      const code = error.code
        || (statusCode === 401 ? 'unauthorized' : null)
        || (statusCode === 404 ? 'not_found' : null)
        || (statusCode === 409 ? 'job_conflict' : null)
        || (statusCode >= 500 ? 'internal_error' : 'bad_request');
      sendJson(response, statusCode, {
        error: { code, message: String(error.message || error).slice(0, 1000) },
      });
    }
  });
  server.collectorManager = manager;
  recovery.attach(server,token);
  return server;
}

module.exports = {
  createCollectorServer,
};
