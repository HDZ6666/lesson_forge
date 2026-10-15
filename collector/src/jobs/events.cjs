'use strict';

/**
 * Structured job events between a collector child process and the API
 * manager.  The child emits; the manager consumes.  Two transports:
 *
 *   ipc     `process.send(event)` when the child was spawned with an IPC
 *           channel (the API manager always does this).
 *   stdout  one line per event, `@@event {json}`, when `--events-stdout` is
 *           passed or COLLECTOR_EVENT_CHANNEL=stdout.  Used for debugging a
 *           CLI run and as the manager's second channel.
 *
 * Nothing here parses human log lines; free text stays diagnostic only.
 */

const diagnostics = require('../shared/diagnostics.cjs');

const EVENT_PREFIX = '@@event ';
const MAX_EVENT_STRING = 4000;
const MAX_FAILED_PAGES = 200;

const EVENT_TYPES = Object.freeze([
  'run_created',
  'progress',
  'heartbeat',
  'verification_wait',
  'error',
  'sealed',
  'metadata_run_created',
  'metadata_summary',
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

function boundedString(value, max = MAX_EVENT_STRING) {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function boundedInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Validate and bound an event object.  Returns `null` for anything that is
 * not a known event so a noisy or hostile child cannot inject arbitrary state
 * into the manager.
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = String(raw.type || '');
  if (!EVENT_TYPE_SET.has(type)) return null;
  const event = { type, at: boundedString(raw.at, 40) || new Date().toISOString() };
  const runId = boundedInt(raw.runId);
  if (runId != null && runId > 0) event.runId = runId;
  switch (type) {
    case 'run_created':
      event.runType = raw.runType === 'metadata' ? 'metadata' : 'content';
      event.textbookExternalId = boundedString(raw.textbookExternalId, 64);
      event.resumedFromRunId = boundedInt(raw.resumedFromRunId);
      break;
    case 'progress':
      for (const key of [
        'catalogCount',
        'catalogsDone',
        'pagesOk',
        'pagesFailed',
        'questionsSeen',
        'uniqueQuestionCount',
        'sourceTotal',
        'assetsDownloaded',
        'errors',
      ]) {
        const value = boundedInt(raw[key]);
        if (value != null) event[key] = value;
      }
      {
        const percent = boundedNumber(raw.percent);
        if (percent != null) event.percent = Math.max(0, Math.min(100, percent));
      }
      event.catalogExternalId = boundedString(raw.catalogExternalId, 64);
      event.pageNumber = boundedInt(raw.pageNumber);
      event.resultType = boundedString(raw.resultType, 64);
      break;
    case 'heartbeat':
      event.stage = boundedString(raw.stage, 64);
      {
        const rss = boundedInt(raw.rssMb);
        if (rss != null && rss >= 0) event.rssMb = rss;
        const browserRss = boundedInt(raw.browserRssMb);
        if (browserRss != null && browserRss >= 0) event.browserRssMb = browserRss;
      }
      break;
    case 'verification_wait':
      event.reason = boundedString(raw.reason, 200);
      event.url = boundedString(raw.url, 2000);
      event.elapsedMs = boundedInt(raw.elapsedMs);
      break;
    case 'error':
      event.code = boundedString(raw.code, 120) || 'error';
      event.message = boundedString(raw.message) || '采集任务异常';
      event.recoverable = raw.recoverable === true;
      event.blocked = raw.blocked === true;
      event.stage = boundedString(raw.stage, 64);
      if (raw.discoveryRequest && ['seed', 'textbooks'].includes(raw.discoveryRequest.stage)) {
        event.discoveryRequest = {
          stage: raw.discoveryRequest.stage,
          seedUrl: boundedString(raw.discoveryRequest.seedUrl, 2000),
          versionId: boundedString(raw.discoveryRequest.versionId, 64),
          urlTemplate: boundedString(raw.discoveryRequest.urlTemplate, 500),
        };
      }
      if (Array.isArray(raw.failedPages)) {
        event.failedPages = raw.failedPages.slice(0, MAX_FAILED_PAGES).map((item) => ({
          catalogExternalId: boundedString(item?.catalogExternalId, 64),
          pageNumber: boundedInt(item?.pageNumber),
          resultType: boundedString(item?.resultType, 64),
        }));
      }
      break;
    case 'sealed':
      event.status = boundedString(raw.status, 40);
      event.snapshotComplete = raw.snapshotComplete === true;
      event.scanComplete = raw.scanComplete === true;
      event.dataComplete = raw.dataComplete === true;
      event.completionQuality = boundedString(raw.completionQuality, 64);
      event.message = boundedString(raw.message);
      if (raw.counts && typeof raw.counts === 'object') {
        event.counts = {};
        for (const [key, value] of Object.entries(raw.counts)) {
          const number = boundedInt(value);
          if (number != null) event.counts[boundedString(key, 64)] = number;
        }
      }
      break;
    case 'metadata_run_created':
      break;
    case 'metadata_summary':
      event.versionCount = boundedInt(raw.versionCount);
      event.textbookCount = boundedInt(raw.textbookCount);
      event.status = boundedString(raw.status, 40);
      break;
    default:
      return null;
  }
  return event;
}

/**
 * Parse one stdout line.  Returns the event or `null` when the line is a
 * normal log line.
 */
function parseEventLine(line) {
  const text = String(line || '');
  if (!text.startsWith(EVENT_PREFIX)) return null;
  try {
    return normalizeEvent(JSON.parse(text.slice(EVENT_PREFIX.length)));
  } catch {
    return null;
  }
}

function formatEventLine(event) {
  return `${EVENT_PREFIX}${JSON.stringify(event)}`;
}

function resolveChannel(options = {}) {
  if (options.channel) return String(options.channel);
  const configured = String(process.env.COLLECTOR_EVENT_CHANNEL || '')
    .trim()
    .toLowerCase();
  if (configured === 'stdout' || configured === 'ipc' || configured === 'none') return configured;
  return typeof process.send === 'function' ? 'ipc' : 'none';
}

/**
 * Build an emitter for the current process.  `emit(type, payload)` never
 * throws: a closed IPC channel or a broken stdout must not fail a crawl.
 */
function createProcessEventEmitter(options = {}) {
  const channel = resolveChannel(options);
  const stdoutEnabled = options.stdout === true || channel === 'stdout';
  const ipcEnabled = channel === 'ipc' && typeof process.send === 'function';
  const sink = options.sink || null;
  const emitted = [];
  // When the API process dies the channel closes.  A send on a closed channel
  // does not throw: without a callback Node emits 'error' on `process`, which
  // would crash a crawl mid-page.  Track the channel and always pass a
  // callback so the crawl continues (or is stopped by SIGTERM) cleanly.
  let ipcOpen = ipcEnabled && process.connected !== false;
  if (ipcEnabled) {
    process.once('disconnect', () => {
      ipcOpen = false;
    });
  }
  const emit = (type, payload = {}) => {
    const event = normalizeEvent({ ...payload, type, at: new Date().toISOString() });
    if (!event) return null;
    if (['run_created', 'metadata_run_created'].includes(type))
      diagnostics.bind({
        runId: event.runId,
        runType: type === 'metadata_run_created' ? 'metadata' : event.runType,
        textbookExternalId: event.textbookExternalId,
      });
    diagnostics.write('child_event', { event });
    if (sink) {
      try {
        sink(event);
      } catch {}
    }
    if (options.record === true) emitted.push(event);
    if (ipcOpen && process.connected !== false) {
      try {
        process.send(event, undefined, undefined, (error) => {
          if (error) ipcOpen = false;
        });
      } catch {
        ipcOpen = false;
      }
    }
    if (stdoutEnabled) {
      try {
        process.stdout.write(`${formatEventLine(event)}\n`);
      } catch {}
    }
    return event;
  };
  return {
    emit,
    channel,
    stdoutEnabled,
    ipcEnabled,
    emitted,
    get ipcOpen() {
      return ipcOpen;
    },
  };
}

const NO_EVENTS = Object.freeze({
  emit: () => null,
  channel: 'none',
  stdoutEnabled: false,
  ipcEnabled: false,
  emitted: [],
});

module.exports = {
  EVENT_PREFIX,
  EVENT_TYPES,
  NO_EVENTS,
  createProcessEventEmitter,
  formatEventLine,
  normalizeEvent,
  parseEventLine,
};
