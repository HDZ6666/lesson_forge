'use strict';

const diagnostics = require('../shared/diagnostics.cjs');

/**
 * Question asset (image / formula) download with allow-listed hosts, size
 * cap, SHA-256 content addressing and the formula PNG -> SVG fallback.
 */

const fs = require('node:fs');
const path = require('node:path');

const { QuestionSyncError } = require('../shared/errors.cjs');
const { sha256, sleep, writeFileAtomic } = require('../shared/utils.cjs');
const { ALLOWED_ASSET_HOSTS, assertAllowedUrl: assertAllowedUrlShared } = require('../shared/url_policy.cjs');
const {
  DEFAULT_ASSET_CONCURRENCY,
  MAX_ASSET_BYTES,
  MAX_ASSET_CONCURRENCY,
  MAX_RETRIES,
} = require('../sources/zujuan/constants.cjs');
const { normalizeHeaders, responseHeaders, responseStatus } = require('../sources/zujuan/request.cjs');
const { normalizeAssetType } = require('../sources/zujuan/question_parser.cjs');
const { assetKey: canonicalAssetKey } = require('../qbpkg/normalize.cjs');
const { retryDelay } = require('../policies/retry.cjs');
const { openAssetResponse } = require('./request.cjs');

const assertAllowedUrl = (value, hosts) =>
  assertAllowedUrlShared(value, hosts, (message, code, cause) => new QuestionSyncError(message, code, cause));

async function disposeResponse(response) {
  if (!response || typeof response.dispose !== 'function') return;
  try {
    await response.dispose();
  } catch {
    // Disposal is best effort; a closed context has already freed the body.
  }
}

function extensionForAsset(url, mimeType) {
  const mime = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const byMime = {
    'image/svg+xml': '.svg',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  if (byMime[mime]) return byMime[mime];
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
  } catch {
    return '.bin';
  }
}

const KNOWN_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.jxl']);

function isSupportedAssetResponse(url, mimeType) {
  const mime = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mime.startsWith('image/')) return true;
  let extension = '';
  try {
    extension = path.extname(new URL(url).pathname).toLowerCase();
  } catch {}
  // A few CDN edges omit Content-Type or return octet-stream.  Only accept
  // those responses when the URL itself identifies a known image format;
  // this still rejects challenge HTML, JSON, and empty/unknown responses.
  return (!mime || mime === 'application/octet-stream') && KNOWN_ASSET_EXTENSIONS.has(extension);
}

function isFormulaPngAsset(asset, sourceUrl) {
  const type = String(asset?.assetType || asset?.type || '').toLowerCase();
  return type === 'formula_image' && /\.png(?:$|[?#])/i.test(String(sourceUrl || ''));
}

function formulaSvgFallbackUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    if (!/\.png$/i.test(parsed.pathname)) return null;
    parsed.pathname = parsed.pathname.replace(/\.png$/i, '.svg');
    return parsed.href;
  } catch {
    return null;
  }
}

function isEmptySvgPlaceholder(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8').trim() : String(body || '').trim();
  if (!/^<svg\b/i.test(text) || !/<\/svg\s*>$/i.test(text)) return false;
  const opening = text.match(/^<svg\b[^>]*>/i)?.[0] || '';
  const width = opening.match(/\bwidth\s*=\s*['"]?0(?:px)?['"]?/i);
  const height = opening.match(/\bheight\s*=\s*['"]?0(?:px)?['"]?/i);
  const viewBox = opening.match(/\bviewBox\s*=\s*['"]\s*0\s+0\s+0\s+0\s*['"]/i);
  if (!(width && height) && !viewBox) return false;
  // Be conservative: a zero-sized root with a drawing element may be an
  // intentional sprite/clip and must remain a real asset.
  const bodyText = text
    .replace(/^<svg\b[^>]*>/i, '')
    .replace(/<\/svg\s*>$/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return !/<(?:path|text|image|use|circle|ellipse|rect|line|polyline|polygon|g)\b/i.test(bodyText);
}

async function downloadAsset(context, options, asset) {
  const sourceUrl = assertAllowedUrl(asset.sourceUrl || asset.url, ALLOWED_ASSET_HOSTS);
  if (!context?.request?.get) {
    throw new QuestionSyncError('素材下载缺少浏览器请求上下文。', 'asset_request_unavailable');
  }
  const wait = options.sleepFn || sleep;
  const downloadOne = async (requestUrl) => {
    let lastHeaders = {};
    for (let retryIndex = 0; retryIndex <= MAX_RETRIES; retryIndex += 1) {
      const started = performance.now();
      const requestId = require('node:crypto').randomUUID();
      const detail = { requestId, attempt: retryIndex + 1, url: diagnostics.safeUrl(requestUrl) };
      diagnostics.write('asset_attempt_started', detail);
      let response = null;
      try {
        response = await openAssetResponse(context, requestUrl, options);
        const status = responseStatus(response);
        const headers = responseHeaders(response);
        detail.status = status;
        options.sourceControl?.observe(status, headers, { verification: false });
        lastHeaders = headers;
        if (status < 200 || status >= 300) {
          throw new QuestionSyncError(`素材请求返回 HTTP ${status || '未知状态'}`, `asset_http_${status || 0}`, {
            status,
            headers,
          });
        }
        const lengthHeader = Number(normalizeHeaders(headers)['content-length'] || 0);
        if (lengthHeader > MAX_ASSET_BYTES) {
          throw new QuestionSyncError(`素材超过 10MB：${requestUrl}`, 'asset_too_large');
        }
        const mimeType = normalizeHeaders(headers)['content-type'] || null;
        if (!isSupportedAssetResponse(requestUrl, mimeType)) {
          throw new QuestionSyncError(
            `素材响应类型不受支持：${mimeType || '缺少 Content-Type'}（${requestUrl}）`,
            'asset_unsupported_response',
            { status, mimeType },
          );
        }
        if (typeof response.body !== 'function') {
          throw new QuestionSyncError('素材响应缺少 body。', 'asset_empty_body');
        }
        const received = await response.body();
        // Playwright keeps every APIResponse body in memory until dispose()
        // or context close.  A whole-textbook crawl downloads hundreds of
        // thousands of assets, so an undisposed response is a multi-GB leak.
        await disposeResponse(response);
        response = null;
        const body = Buffer.isBuffer(received) ? received : Buffer.from(received || []);
        if (body.length === 0) throw new QuestionSyncError('素材响应 body 为空。', 'asset_empty_body');
        if (body.length > MAX_ASSET_BYTES) {
          throw new QuestionSyncError(`素材超过 10MB：${requestUrl}`, 'asset_too_large');
        }
        diagnostics.write('asset_attempt_finished', {
          ...detail,
          elapsedMs: Math.round(performance.now() - started),
          bytes: body.length,
          outcome: 'success',
        });
        return { body, mimeType, requestUrl };
      } catch (error) {
        diagnostics.write('asset_attempt_finished', {
          ...detail,
          elapsedMs: Math.round(performance.now() - started),
          outcome: 'error',
          code: error.code,
          message: error.message,
        });
        await disposeResponse(response);
        response = null;
        if (error.blocked) throw error;
        const retryable = ![
          'host_not_allowed',
          'asset_redirect',
          'asset_too_large',
          'asset_storage_error',
          'asset_http_404',
        ].includes(String(error?.code || ''));
        if (!retryable || retryIndex >= MAX_RETRIES) throw error;
        const delay = retryDelay('normal', retryIndex, lastHeaders, options.randomFn || Math.random);
        diagnostics.write('request_retry_scheduled', { ...detail, delayMs: delay, reason: error.code });
        console.warn(
          `[素材重试] ${requestUrl} 第 ${retryIndex + 1}/${MAX_RETRIES} 次，等待 ${(delay / 1000).toFixed(1)} 秒：${error.message}`,
        );
        await wait(delay);
      }
    }
    throw new QuestionSyncError(`素材下载失败：${requestUrl}`, 'asset_download_failed');
  };

  let downloaded;
  let downloadUrl = sourceUrl;
  try {
    downloaded = await downloadOne(sourceUrl);
  } catch (error) {
    const fallbackUrl = formulaSvgFallbackUrl(sourceUrl);
    if (!fallbackUrl || !isFormulaPngAsset(asset, sourceUrl) || String(error?.code) !== 'asset_http_404') {
      throw error;
    }
    try {
      downloaded = await downloadOne(fallbackUrl);
      if (isEmptySvgPlaceholder(downloaded.body)) {
        return {
          ...asset,
          sourceUrl,
          url: sourceUrl,
          assetKey: canonicalAssetKey(asset.assetType || asset.type, sourceUrl),
          skipped: true,
          ignored: true,
          fallbackSourceUrl: fallbackUrl,
        };
      }
      downloadUrl = fallbackUrl;
    } catch (fallbackError) {
      if (String(fallbackError?.code) === 'asset_http_404') {
        // A provider occasionally leaves a zero-sized SVG marker where a
        // formula was removed.  Ignore only that exact, non-graphical marker.
        try {
          const probe = await openAssetResponse(context, fallbackUrl, options);
          let probeBody;
          try {
            options.sourceControl?.observe(responseStatus(probe), responseHeaders(probe), { verification: false });
            probeBody = typeof probe?.body === 'function' ? await probe.body() : null;
          } finally {
            await disposeResponse(probe);
          }
          if (isEmptySvgPlaceholder(probeBody)) {
            return {
              ...asset,
              sourceUrl,
              url: sourceUrl,
              assetKey: canonicalAssetKey(asset.assetType || asset.type, sourceUrl),
              skipped: true,
              ignored: true,
              fallbackSourceUrl: fallbackUrl,
            };
          }
        } catch (error) {
          if (error.blocked) throw error;
        }
      }
      throw fallbackError;
    }
  }

  const { body, mimeType } = downloaded;
  const digest = sha256(body);
  const extension = extensionForAsset(downloadUrl, mimeType);
  const relativePath = path.join('assets', digest.slice(0, 2), `${digest}${extension}`);
  const target = path.join(options.dataDir, relativePath);
  try {
    if (!fs.existsSync(target)) writeFileAtomic(target, body);
  } catch (error) {
    throw new QuestionSyncError(`素材落盘失败：${error.message}`, 'asset_storage_error', error);
  }
  return {
    ...asset,
    // Keep the original URL as the identity used by HTML/assetKey.  The
    // fallback URL is diagnostic only; the stored bytes may be SVG.
    sourceUrl,
    url: sourceUrl,
    assetKey: canonicalAssetKey(asset.assetType || asset.type, sourceUrl),
    type: normalizeAssetType(sourceUrl, asset.originalType || asset.type),
    assetType: normalizeAssetType(sourceUrl, asset.originalType || asset.type),
    fallbackSourceUrl: downloadUrl === sourceUrl ? null : downloadUrl,
    storagePath: relativePath.split(path.sep).join('/'),
    localPath: relativePath.split(path.sep).join('/'),
    contentSha256: digest,
    sha256: digest,
    mimeType,
    byteSize: body.length,
  };
}

/**
 * Download the assets of one paging window with a bounded pool, deduplicated
 * by source URL, and record every outcome in `cache` so the per-page persist
 * step becomes a pure cache lookup.  Failures are cached as
 * `{ downloadFailed: true, errorCode, errorMessage }` exactly like the serial
 * path used to; a storage error (disk) is fatal and propagates unchanged.
 */
async function prefetchAssets(
  assets,
  { concurrency = DEFAULT_ASSET_CONCURRENCY, cache, download, onSuccess = null, onFailure = null } = {},
) {
  if (!(cache instanceof Map)) throw new TypeError('prefetchAssets 需要 Map 类型的 cache');
  if (typeof download !== 'function') throw new TypeError('prefetchAssets 需要 download 函数');
  const pending = new Map();
  for (const asset of assets || []) {
    const sourceUrl = String(asset?.sourceUrl || asset?.url || '');
    if (!sourceUrl || cache.has(sourceUrl) || pending.has(sourceUrl)) continue;
    pending.set(sourceUrl, asset);
  }
  const queue = [...pending.entries()];
  const limit = Math.max(1, Math.min(MAX_ASSET_CONCURRENCY, Number(concurrency) || DEFAULT_ASSET_CONCURRENCY));
  let downloaded = 0;
  let failed = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let fatal = null;
  const worker = async () => {
    while (queue.length && !fatal) {
      const [sourceUrl, asset] = queue.shift();
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        const result = await download(asset);
        cache.set(sourceUrl, result);
        if (result?.contentSha256) downloaded += 1;
        if (onSuccess) onSuccess(result, asset);
      } catch (error) {
        if (error.blocked || String(error?.code || '') === 'asset_storage_error') {
          fatal = fatal || error;
          break;
        }
        const failure = {
          ...asset,
          sourceUrl,
          url: sourceUrl,
          downloadFailed: true,
          errorCode: error?.code || 'asset_download_failed',
          errorMessage: String(error?.message || error),
        };
        cache.set(sourceUrl, failure);
        failed += 1;
        if (onFailure) onFailure(error, asset);
      } finally {
        inFlight -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  if (fatal) throw fatal;
  return { requested: pending.size, downloaded, failed, peakInFlight };
}

module.exports = {
  KNOWN_ASSET_EXTENSIONS,
  disposeResponse,
  downloadAsset,
  prefetchAssets,
  extensionForAsset,
  formulaSvgFallbackUrl,
  isEmptySvgPlaceholder,
  isFormulaPngAsset,
  isSupportedAssetResponse,
};
