'use strict';

/**
 * HTTP plumbing for the collector API: bounded JSON responses, verified
 * asset streaming, bounded request bodies and constant-time token compare.
 */

const fs = require('node:fs');
const { timingSafeEqual } = require('node:crypto');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(response, statusCode, payload) {
  let encoded;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    encoded = JSON.stringify({ error: { code: 'serialization_error', message: '响应无法序列化' } });
    statusCode = 500;
  }
  let body = Buffer.from(encoded || '{}');
  if (body.length > MAX_RESPONSE_BYTES) {
    statusCode = 413;
    body = Buffer.from(
      JSON.stringify({
        error: { code: 'response_too_large', message: '响应超过安全大小上限，请缩小分页范围' },
      }),
    );
  }
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendAssetResponse(response, asset) {
  const contentLength = Number(asset?.contentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    sendJson(response, 500, {
      error: { code: 'asset_unavailable', message: '素材响应长度无效' },
    });
    return;
  }
  const fileDescriptor = Number.isInteger(asset?.fileDescriptor) ? asset.fileDescriptor : null;
  let stream;
  if (contentLength === 0 && fileDescriptor != null) {
    try {
      response.writeHead(200, {
        'content-type': String(asset.contentType || 'application/octet-stream'),
        'content-length': 0,
        etag: String(asset.etag || ''),
        'cache-control': String(asset.cacheControl || 'public, max-age=31536000, immutable'),
      });
      response.end();
    } finally {
      try {
        fs.closeSync(fileDescriptor);
      } catch {}
    }
    return;
  }
  try {
    // `fileDescriptor` is a non-enumerable internal value produced only after
    // the collector has validated the run scope, root containment, and
    // digest.  Use a bounded descriptor stream when available so a path
    // replacement after validation cannot redirect the response.  The path
    // fallback preserves compatibility for direct callers using older asset
    // result objects.
    stream =
      fileDescriptor != null
        ? fs.createReadStream(null, {
            fd: fileDescriptor,
            autoClose: true,
            start: 0,
            end: contentLength - 1,
          })
        : fs.createReadStream(asset.filePath);
  } catch {
    if (fileDescriptor != null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {}
    }
    sendJson(response, 404, {
      error: { code: 'asset_not_found', message: '素材文件不存在或不可用' },
    });
    return;
  }
  stream.once('error', () => {
    // A filesystem race can still happen after the read-only validation.  Do
    // not emit a second JSON response after bytes have started flowing and
    // never let the stream error become an uncaught process exception.
    if (!response.destroyed && !response.headersSent && !response.writableEnded) {
      sendJson(response, 404, {
        error: { code: 'asset_not_found', message: '素材文件不存在或不可用' },
      });
    } else if (!response.destroyed) {
      response.destroy();
    }
  });
  response.once('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  const startStreaming = () => {
    if (response.destroyed || response.writableEnded) {
      stream.destroy();
      return;
    }
    try {
      response.writeHead(200, {
        'content-type': String(asset.contentType || 'application/octet-stream'),
        'content-length': contentLength,
        etag: String(asset.etag || ''),
        'cache-control': String(asset.cacheControl || 'public, max-age=31536000, immutable'),
      });
      stream.pipe(response);
    } catch {
      stream.destroy();
      if (!response.destroyed && !response.headersSent && !response.writableEnded) {
        sendJson(response, 500, {
          error: { code: 'asset_unavailable', message: '素材响应失败' },
        });
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  };
  // A stream created from an already-open fd does not emit `open`; a path
  // stream does.  Start the former immediately while retaining the latter's
  // open-time error boundary.
  if (fileDescriptor != null) startStreaming();
  else stream.once('open', startStreaming);
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体必须是有效 JSON');
  }
}

module.exports = {
  MAX_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  readJson,
  safeEqual,
  sendAssetResponse,
  sendJson,
};
