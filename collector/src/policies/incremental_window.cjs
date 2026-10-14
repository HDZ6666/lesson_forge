'use strict';

/**
 * Incremental scanning inside the provider's current page window.
 *
 * A catalog baseline records, for one textbook + catalog + fixed query, the
 * question-ID groups of the head pages, the contiguous reliably saved range,
 * known failure gaps and whether the actual end was reached.  It lives apart
 * from run snapshots so a sealed and imported snapshot can be reclaimed
 * without losing the ability to locate the next increment.
 *
 * Page numbers are only position hints.  Joining an old range requires
 * several question IDs on several consecutive pages agreeing on one shift;
 * a single matching ID, globally known IDs or total-count deltas never join.
 * Everything here is pure so the rules can be tested without a browser.
 */

const DEFAULT_HEAD_PAGES = 3;
const DEFAULT_CONFIRM_PAGES = 3;
const DEFAULT_MIN_MATCHES = 3;
const DEFAULT_BACKTRACK_PAGES = 5;
const DEFAULT_DUPLICATE_STOP_PAGES = 3;
const MAX_GAPS = 200;
const BASELINE_VERSION = 1;

function tuning(opts = {}) {
  const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
  return {
    headPages: positive(opts.incrementalHeadPages, DEFAULT_HEAD_PAGES),
    confirmPages: positive(opts.incrementalConfirmPages, DEFAULT_CONFIRM_PAGES),
    minMatches: positive(opts.incrementalMinMatches, DEFAULT_MIN_MATCHES),
    backtrackPages: positive(opts.incrementalBacktrackPages, DEFAULT_BACKTRACK_PAGES),
    duplicateStopPages: positive(opts.duplicateStopPages, DEFAULT_DUPLICATE_STOP_PAGES),
  };
}

function normaliseIds(ids) {
  return (ids || []).map((value) => String(value)).filter(Boolean);
}

/** True when a baseline can be used to locate an increment. */
function usableBaseline(baseline) {
  return Boolean(
    baseline &&
    baseline.version === BASELINE_VERSION &&
    Array.isArray(baseline.headPages) &&
    baseline.headPages.length > 0 &&
    Number(baseline.reliableEnd) >= 1,
  );
}

/**
 * Track head pages of the current scan until they consistently line up with
 * the baseline's head pages under one page shift.
 */
function createJoinTracker(baseline, opts = {}) {
  const { confirmPages, minMatches } = tuning(opts);
  const heads = usableBaseline(baseline)
    ? baseline.headPages.map((page) => ({ page: Number(page.page), ids: new Set(normaliseIds(page.ids)) }))
    : [];
  const required = Math.min(confirmPages, heads.length);
  let candidateShift = null;
  let confirmed = 0;
  let lastPage = null;
  let joined = null;

  function matchShift(pageNumber, ids) {
    let best = null;
    for (const head of heads) {
      const need = Math.min(minMatches, head.ids.size);
      if (need <= 0) continue;
      const matches = ids.filter((id) => head.ids.has(id)).length;
      if (matches >= need && (!best || matches > best.matches)) {
        best = { shift: pageNumber - head.page, matches };
      }
    }
    return best;
  }

  return {
    get joined() {
      return joined;
    },
    get enabled() {
      return heads.length > 0;
    },
    /** Observe one successfully parsed page; returns the join once confirmed. */
    observe(pageNumber, rawIds) {
      if (joined || heads.length === 0) return joined;
      const page = Number(pageNumber);
      const ids = normaliseIds(rawIds);
      const match = matchShift(page, ids);
      const consecutive = lastPage != null && page === lastPage + 1;
      if (match && match.shift >= 0 && candidateShift === match.shift && consecutive) {
        confirmed += 1;
      } else if (match && match.shift >= 0) {
        candidateShift = match.shift;
        confirmed = 1;
      } else {
        candidateShift = null;
        confirmed = 0;
      }
      lastPage = page;
      if (candidateShift != null && confirmed >= required) {
        joined = { shift: candidateShift, confirmedAtPage: page, confirmedPages: confirmed };
      }
      return joined;
    },
  };
}

/**
 * What to do once the head joined the old range at `shift`.
 *
 * - The old contiguous range now ends at reliableEnd + shift.  When that is
 *   at or beyond the window end (or the old scan reached the real end), the
 *   current window is covered and only old gaps still inside it remain.
 * - Otherwise continue a little before the shifted boundary up to the
 *   window end.  Old gaps already outside the window are dropped silently.
 */
function planAfterJoin(baseline, join, { windowEnd, nextPage, ...opts }) {
  const { backtrackPages } = tuning(opts);
  const shift = Number(join.shift) || 0;
  const oldEnd = Number(baseline.reliableEnd) + shift;
  const end = Number(windowEnd);
  const gapPages = [...new Set((baseline.gaps || []).map((page) => Number(page) + shift))]
    .filter((page) => page >= 1 && page <= end && page >= Number(nextPage || 1))
    .sort((a, b) => a - b);
  const covered = oldEnd >= end || baseline.reachedEnd === true;
  const resumeFrom = covered ? null : Math.max(Number(nextPage || 1), oldEnd - backtrackPages + 1);
  return {
    shift,
    oldEnd,
    covered,
    resumeFrom,
    gapPages: covered ? gapPages : gapPages.filter((page) => page < resumeFrom),
    skippedRange: covered
      ? [Number(join.confirmedAtPage) + 1, Math.min(oldEnd, end)]
      : [Number(join.confirmedAtPage) + 1, resumeFrom - 1],
  };
}

/**
 * Baseline to keep after a catalog finished.
 *
 * Only a head that actually joined the old range, or a scan that actually
 * reached the window end or the real end, replaces the confirmed baseline.
 * An interrupted head keeps the old baseline and returns a candidate, so the
 * next run never mistakes a new first page for the full join.
 */
function nextBaseline({
  previous = null,
  join = null,
  successPages = new Map(),
  windowEnd,
  reachedEnd = false,
  reachedWindowEnd = false,
  opts = {},
}) {
  const { headPages } = tuning(opts);
  const end = Number(windowEnd);
  const success = new Map(
    [...successPages.entries()].map(([page, ids]) => [Number(page), normaliseIds(ids)]).filter(([page]) => page <= end),
  );
  const head = [];
  for (let page = 1; page <= headPages && success.has(page); page += 1) head.push({ page, ids: success.get(page) });
  const covered = new Set(success.keys());
  const priorGaps = new Set();
  if (join && usableBaseline(previous)) {
    const shift = Number(join.shift) || 0;
    for (const gap of previous.gaps || []) priorGaps.add(Number(gap) + shift);
    const oldEnd = Math.min(end, Number(previous.reliableEnd) + shift);
    for (let page = 1 + shift; page <= oldEnd; page += 1) {
      if (!priorGaps.has(page)) covered.add(page);
    }
  }
  const settled = Boolean(join) || reachedEnd || reachedWindowEnd;
  if (!settled || head.length === 0) {
    return {
      confirmed: previous,
      candidate: head.length ? { headPages: head, scannedPages: [...success.keys()].sort((a, b) => a - b) } : null,
    };
  }
  let reliableEnd = 0;
  while (covered.has(reliableEnd + 1)) reliableEnd += 1;
  const furthest = covered.size ? Math.max(...covered) : 0;
  const gaps = [];
  for (let page = reliableEnd + 1; page <= furthest && gaps.length < MAX_GAPS; page += 1) {
    if (!covered.has(page)) gaps.push(page);
  }
  return {
    confirmed: {
      version: BASELINE_VERSION,
      headPages: head,
      reliableEnd,
      gaps,
      reachedEnd: reachedEnd || Boolean(join && previous?.reachedEnd),
      windowEnd: end,
    },
    candidate: null,
  };
}

module.exports = {
  BASELINE_VERSION,
  DEFAULT_BACKTRACK_PAGES,
  DEFAULT_CONFIRM_PAGES,
  DEFAULT_DUPLICATE_STOP_PAGES,
  DEFAULT_MIN_MATCHES,
  createJoinTracker,
  nextBaseline,
  planAfterJoin,
  tuning,
  usableBaseline,
};
