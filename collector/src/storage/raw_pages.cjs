'use strict';

/**
 * Gzip raw provider responses under <dataDir>/raw/<date>/... as evidence.
 */

const path = require('node:path');
const zlib = require('node:zlib');

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

module.exports = {
  saveRawHtml,
  saveRawPage,
};
