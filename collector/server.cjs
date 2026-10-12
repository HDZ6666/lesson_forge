#!/usr/bin/env node
'use strict';

/**
 * Collector HTTP API entry point.  Implementation lives in src/api/:
 *   http.cjs         bounded JSON / asset responses, request body, token compare
 *   progress.cjs     publicJob projection and live progress aggregate
 *   job_store.cjs    collector_jobs SQLite persistence and cross-process mutex
 *   job_manager.cjs  request validation, child processes, events, timeouts
 *   routes.cjs       route table
 *
 * Route table (all under the configured token except GET /health):
 *   GET  /health, GET /v1/health, GET /metrics, GET /v1/config
 *   POST /v1/jobs, GET /v1/jobs/{jobId}, POST /v1/jobs/{jobId}/cancel
 *   POST /v1/metadata/validate, GET /v1/metadata/snapshot
 *   GET  /v1/candidates, GET /v1/catalog-progress
 *   GET  /v1/runs/{runId}/catalogs | questions | questions/{externalId}
 *   GET  /v1/runs/{runId}/snapshot | snapshot-page | assets/{sha256}
 *   GET  /v1/runs/{runId}/snapshot-summary   -> readRunSnapshotSummary
 */

const process = require('node:process');

const { CollectorJobManager, deploymentBoolean, intInRange } = require('./src/api/job_manager.cjs');
const { aggregateLiveProgress, publicJob } = require('./src/api/progress.cjs');
const { createCollectorServer } = require('./src/api/routes.cjs');
const { formatConfig, validateConfig } = require('./src/shared/config.cjs');

async function main() {
  // Check every COLLECTOR_* setting before anything starts, including the
  // ones only the crawl child reads, so a bad value fails the deployment now
  // rather than a crawl hours later.
  const config = validateConfig(process.env);
  if (config.errors.length) throw new Error(`配置无效：\n  ${config.errors.join('\n  ')}`);
  for (const warning of config.warnings) console.warn(`[配置] ${warning}`);
  console.log(`[配置] 生效值：\n${formatConfig(config.values)}`);
  const host = String(process.env.COLLECTOR_API_HOST || '127.0.0.1');
  const port = intInRange(process.env.COLLECTOR_API_PORT || 9110, 'COLLECTOR_API_PORT', 1, 65535);
  const token = String(process.env.COLLECTOR_API_TOKEN || '');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) {
    throw new Error('采集器绑定非本机地址时必须配置 COLLECTOR_API_TOKEN');
  }
  const server = createCollectorServer({
    token,
    dbPath: process.env.COLLECTOR_DB,
    dataDir: process.env.COLLECTOR_DATA_DIR,
    profileDir: process.env.COLLECTOR_PROFILE_DIR,
    nodeBin: process.env.COLLECTOR_NODE_BIN,
    headful: process.env.COLLECTOR_HEADFUL,
    config: config.values,
    readerThreads: config.values.COLLECTOR_READER_THREADS,
    readerTimeoutMs: config.values.COLLECTOR_READER_TIMEOUT_MS,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`collector API 已启动：http://${host}:${port}`);
  let stopping;
  const shutdown = () => {
    if (stopping) return stopping;
    // Stop accepting connections before waiting for the active writer.
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    stopping = (async () => {
      if (server.collectorManager.manualRecovery?.active) {
        const r = server.collectorManager.manualRecovery;
        await r.close({ sessionId: r.current.id, owner: r.current.owner });
      }
      await server.collectorManager.shutdown();
      server.closeAllConnections?.();
      await closed;
    })().catch((error) => {
      console.error(`[停止失败] ${error.message}`);
      process.exitCode = 1;
    });
    return stopping;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  CollectorJobManager,
  aggregateLiveProgress,
  createCollectorServer,
  deploymentBoolean,
  publicJob,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[错误] ${error.message}`);
    process.exitCode = 1;
  });
}
