'use strict';

/**
 * Gzip raw provider responses under <dataDir>/raw/<date>/... as evidence.
 */

const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const diagnostics = require('../shared/diagnostics.cjs');

const { jsonStringify, nowIso, safeFilePart, sha256, writeFileAtomic } = require('../shared/utils.cjs');
const { questionListApiUrl } = require('../sources/zujuan/urls.cjs');

function saveRawPage(options, runId, catalog, pageNumber, responseText) {
  if (!options.saveRaw) return null;
  const capturedAt = nowIso();
  const relative = path.join(
    'raw',
    capturedAt.slice(0, 10),
    `run-${runId}`,
    `question-list-${safeFilePart(catalog.externalId)}-${pageNumber}.json.gz`,
  );
  const filePath = path.join(options.dataDir, relative);
  const content = typeof responseText === 'string' ? responseText : jsonStringify(responseText);
  writeFileAtomic(filePath, zlib.gzipSync(Buffer.from(content, 'utf8'), { level: 6 }));
  return {
    filePath,
    sourceUrl: questionListApiUrl(options),
    contentHash: sha256(content),
  };
}

function saveRawHtml(dataDir, runId, type, key, html) {
  const capturedAt = nowIso();
  const relative = path.join(
    'raw',
    capturedAt.slice(0, 10),
    `metadata-run-${runId}`,
    `${safeFilePart(type, 120)}-${safeFilePart(key, 120)}.html.gz`,
  );
  const target = path.join(dataDir, relative);
  const compressed = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 6 });
  writeFileAtomic(target, compressed);
  return target;
}

// Error evidence is independent of optional full successful-page snapshots.
// Keep a bounded, inert text excerpt; never save cookies or executable scripts.
function saveListFailure(options, catalog, pageNumber, response, classification) {
  const source = String(response.text || '');
  const title = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const excerpt = source
    .slice(0, 65536)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
  const evidence = diagnostics.scrub({
    capturedAt: nowIso(),
    catalogId: String(catalog?.externalId || ''),
    pageNumber,
    status: Number(response.status || 0),
    code: classification.code,
    contentType: response.headers?.['content-type'] || null,
    title: title.replace(/<[^>]+>/g, '').slice(0, 200),
    responseBytes: Buffer.byteLength(source),
    contentHash: sha256(source),
    excerpt,
  });
  let filePath = null;
  if (options.dataDir && options.runId) {
    filePath = path.join(
      options.dataDir,
      'raw',
      evidence.capturedAt.slice(0, 10),
      `run-${options.runId}`,
      `list-failure-${safeFilePart(catalog?.externalId)}-${pageNumber}.json.gz`,
    );
    writeFileAtomic(filePath, zlib.gzipSync(JSON.stringify(evidence)));
    fs.chmodSync(filePath, 0o600);
  }
  return { ...evidence, filePath };
}

module.exports = {
  saveRawHtml,
  saveRawPage,
  saveListFailure,
};
