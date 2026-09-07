'use strict';

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

function createCollectorServer(options = {}) {
  const token = String(options.token ?? process.env.COLLECTOR_API_TOKEN ?? '');
  const manager = options.manager || new CollectorJobManager(options);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://collector.local');
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true, service: 'lesson-bank-collector' });
        return;
      }
      if (token) {
        const authorization = String(request.headers.authorization || '');
        if (!authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), token)) {
          sendJson(response, 401, { error: { code: 'unauthorized', message: '采集器 API 认证失败' } });
          return;
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'lesson-bank-collector',
          activeJobId: manager.activeJobId,
        });
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
      const runCatalogMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/catalogs\/?$/i);
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
        const job = manager.cancel(cancelMatch[1]);
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
  return server;
}

module.exports = {
  createCollectorServer,
};
