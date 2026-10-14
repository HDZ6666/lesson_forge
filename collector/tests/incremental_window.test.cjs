'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createJoinTracker,
  nextBaseline,
  planAfterJoin,
  usableBaseline,
} = require('../src/policies/incremental_window.cjs');

// Ten questions per page; old page p held ids p*100+0..9.
const ids = (page, base = 0) => Array.from({ length: 10 }, (_, index) => String(base + page * 100 + index));
const head = (pages, base = 0) =>
  Array.from({ length: pages }, (_, index) => ({ page: index + 1, ids: ids(index + 1, base) }));
const baseline = (reliableEnd, extra = {}) => ({
  version: 1,
  headPages: head(3),
  reliableEnd,
  gaps: [],
  reachedEnd: false,
  ...extra,
});

function scanUntilJoin(tracker, shift, start = 1) {
  // Current page p shows old page p-shift when p > shift; new content before.
  for (let page = start; page < start + 2000; page += 1) {
    const current = page > shift ? ids(page - shift) : ids(page, 900000);
    const join = tracker.observe(page, current);
    if (join) return { join, page };
  }
  return null;
}

test('A15: saved 1000 pages, 200 new pages: join at 203 and the window is covered', () => {
  const old = baseline(1000);
  const { join, page } = scanUntilJoin(createJoinTracker(old), 200);
  assert.equal(page, 203);
  assert.equal(join.shift, 200);
  const plan = planAfterJoin(old, join, { windowEnd: 1000, nextPage: 204 });
  assert.equal(plan.covered, true);
  assert.deepEqual(plan.gapPages, []);
});

test('A16: saved 300 pages, 200 new pages: skip shifted old range and resume near 500', () => {
  const old = baseline(300);
  const { join } = scanUntilJoin(createJoinTracker(old), 200);
  const plan = planAfterJoin(old, join, { windowEnd: 1000, nextPage: 204 });
  assert.equal(plan.covered, false);
  assert.equal(plan.resumeFrom, 496);
  assert.deepEqual(plan.skippedRange, [204, 495]);
});

test('A17: saved 990 pages, 20 new pages: covered, old frontier outside the window is not chased', () => {
  const old = baseline(990);
  const { join, page } = scanUntilJoin(createJoinTracker(old), 20);
  assert.equal(page, 23);
  const plan = planAfterJoin(old, join, { windowEnd: 1000, nextPage: 24 });
  assert.equal(plan.covered, true);
  assert.equal(plan.oldEnd, 1010);
});

test('A18: more than 1000 new pages never joins inside the window', () => {
  const tracker = createJoinTracker(baseline(1000));
  for (let page = 1; page <= 1000; page += 1) assert.equal(tracker.observe(page, ids(page, 900000)), null);
});

test('a single matching question id or one matching page does not join', () => {
  const tracker = createJoinTracker(baseline(300));
  assert.equal(tracker.observe(1, ['100', 'x1', 'x2', 'x3']), null);
  assert.equal(tracker.observe(2, ids(1)), null);
  assert.equal(tracker.observe(3, ids(9, 900000)), null, 'non-consecutive confirmation resets');
  assert.equal(tracker.observe(4, ids(1)), null);
  assert.equal(tracker.observe(5, ids(2)), null);
  assert.ok(tracker.observe(6, ids(3)));
});

test('A19: a failed page stays a gap; contiguous range is not the highest success', () => {
  const success = new Map();
  for (let page = 1; page <= 308; page += 1) if (page !== 301) success.set(page, ids(page));
  const { confirmed } = nextBaseline({ successPages: success, windowEnd: 1000, reachedWindowEnd: true });
  assert.equal(confirmed.reliableEnd, 300);
  assert.deepEqual(confirmed.gaps, [301]);
});

test('A20: an interrupted head keeps the confirmed baseline and records a candidate', () => {
  const old = baseline(300);
  const success = new Map([
    [1, ids(1, 900000)],
    [2, ids(2, 900000)],
  ]);
  const { confirmed, candidate } = nextBaseline({ previous: old, successPages: success, windowEnd: 1000 });
  assert.equal(confirmed, old);
  assert.equal(candidate.headPages.length, 2);
});

test('joined baseline merges the shifted old range and shifted gaps', () => {
  const old = baseline(300, { gaps: [150] });
  const success = new Map();
  for (let page = 1; page <= 203; page += 1) success.set(page, page > 200 ? ids(page - 200) : ids(page, 900000));
  for (let page = 496; page <= 1000; page += 1) success.set(page, ids(page, 500000));
  const { confirmed } = nextBaseline({
    previous: old,
    join: { shift: 200 },
    successPages: success,
    windowEnd: 1000,
    reachedWindowEnd: true,
  });
  assert.equal(confirmed.reliableEnd, 349);
  assert.deepEqual(confirmed.gaps, [350]);
  assert.deepEqual(
    confirmed.headPages.map((page) => page.ids[0]),
    ids(1, 900000).slice(0, 1).concat(ids(2, 900000)[0], ids(3, 900000)[0]),
  );
  const plan = planAfterJoin(old, { shift: 200, confirmedAtPage: 203 }, { windowEnd: 1000, nextPage: 204 });
  assert.deepEqual(plan.gapPages, [350]);
});

test('unusable baselines disable joining', () => {
  assert.equal(usableBaseline(null), false);
  assert.equal(usableBaseline({ version: 1, headPages: [], reliableEnd: 3 }), false);
  assert.equal(createJoinTracker(null).enabled, false);
});
