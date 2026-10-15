'use strict';

const diagnostics = require('../shared/diagnostics.cjs');

const { QuestionSyncError } = require('../shared/errors.cjs');
const { ALLOWED_ASSET_HOSTS, assertAllowedUrl } = require('../shared/url_policy.cjs');
const { responseStatus, responseHeaders } = require('../sources/zujuan/request.cjs');
const { MAX_ASSET_BYTES } = require('../sources/zujuan/constants.cjs');

const agents = new WeakMap();

function allowed(url) {
  return assertAllowedUrl(
    url,
    ALLOWED_ASSET_HOSTS,
    (message, code, cause) => new QuestionSyncError(message, code, cause),
  );
}

function beforeRequest(options) {
  options.sourceControl?.assertAllowed();
  options.resourceGuard?.assertAllowed();
  options.sourceBudget?.request();
}

/** Browser cookies are reused, but bodies are read as bounded streams rather
 * than being retained by Playwright until the whole response has arrived. */
async function openAssetResponse(context, url, options) {
  url = allowed(url);
  // Request-only adapters are retained for existing offline fixtures.
  if (typeof context.cookies !== 'function') {
    beforeRequest(options);
    const response = await context.request.get(url, { timeout: options.timeout, failOnStatusCode: false });
    return {
      status: () => responseStatus(response),
      headers: () => responseHeaders(response),
      dispose: () => response.dispose?.(),
      body: async () => {
        const body = Buffer.from(await response.body());
        options.sourceBudget?.downloadReceived(body.length);
        if (body.length > MAX_ASSET_BYTES) throw new QuestionSyncError('素材超过 10MB', 'asset_too_large');
        return body;
      },
    };
  }
  if (!agents.has(context)) {
    const page = context.pages?.()[0];
    agents.set(context, page ? await page.evaluate(() => navigator.userAgent) : 'Mozilla/5.0');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 30000);
  let response;
  try {
    for (let redirects = 0; ; redirects += 1) {
      beforeRequest(options);
      const cookies = await context.cookies(url);
      const started = performance.now();
      response = await (options.assetFetch || fetch)(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': agents.get(context),
          'accept-encoding': 'identity',
          referer: 'https://zujuan.xkw.com/',
          cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
        },
      });
      diagnostics.write('asset_http_response', {
        url: diagnostics.safeUrl(url),
        redirects,
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        elapsedMs: Math.round(performance.now() - started),
      });
      options.sourceControl?.observe(response.status, Object.fromEntries(response.headers), { verification: false });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects >= 5) throw new QuestionSyncError('素材重定向次数过多或缺少目标', 'asset_redirect');
      url = allowed(new URL(location, url).href);
    }
    return {
      status: () => response.status,
      headers: () => Object.fromEntries(response.headers),
      dispose: async () => {
        clearTimeout(timer);
        controller.abort();
      },
      body: async () => {
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of response.body || []) {
            // Count received bodies, including the final rejected chunk.
            options.sourceBudget?.downloadReceived(chunk.length);
            options.sourceControl?.assertAllowed();
            options.resourceGuard?.assertAllowed();
            size += chunk.length;
            if (size > MAX_ASSET_BYTES) throw new QuestionSyncError('素材超过 10MB', 'asset_too_large');
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks, size);
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      },
    };
  } catch (error) {
    clearTimeout(timer);
    controller.abort();
    throw error;
  }
}

module.exports = { openAssetResponse };
