'use strict';

/**
 * Retry, backoff and request pacing policies.  Pure except for the wall clock
 * and the injected sleep/random functions.
 */

const { randomBetween, sleep } = require('../shared/utils.cjs');
const { DEFAULT_DELAY_MAX, DEFAULT_DELAY_MIN } = require('../sources/zujuan/constants.cjs');
const { normalizeHeaders } = require('../sources/zujuan/request.cjs');

function retryAfterMs(headers) {
  const value = normalizeHeaders(headers)['retry-after'];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function retryDelay(kind, retryIndex, headers = {}, random = Math.random) {
  const normal = [2000, 5000, 12000];
  const throttled = [60000, 120000, 300000];
  const retryAfter = kind === '429' ? retryAfterMs(headers) : null;
  if (retryAfter != null) return retryAfter;
  const base = (kind === '429' ? throttled : normal)[Math.min(retryIndex, 2)];
  const jitter = Math.floor(Math.max(0, Number(random()) || 0) * 1000);
  return base + jitter;
}

function createRequestGate(minDelay = DEFAULT_DELAY_MIN, maxDelay = DEFAULT_DELAY_MAX) {
  let nextAt = 0;
  return async (waitFn = sleep) => {
    const waitMs = Math.max(0, nextAt - Date.now());
    if (waitMs > 0) await waitFn(waitMs);
    nextAt = Date.now() + randomBetween(minDelay, maxDelay);
  };
}

class PoliteGate {
  constructor(minDelay, maxDelay) {
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.nextAt = 0;
  }

  async wait(label) {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAt - now);
    if (waitMs > 0) {
      console.log(`[限速] ${label}，等待 ${(waitMs / 1000).toFixed(1)} 秒`);
      await sleep(waitMs);
    }
    this.nextAt = Date.now() + randomBetween(this.minDelay, this.maxDelay);
  }
}

module.exports = {
  PoliteGate,
  createRequestGate,
  retryAfterMs,
  retryDelay,
};
