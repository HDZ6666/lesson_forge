'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { PAGE_RESULT } = require('../src/sources/zujuan/constants.cjs');
const {
  catalogLastPage,
  catalogSafetyPageLimit,
  growTargetPages,
  validatePageResult,
} = require('../src/policies/pagination.cjs');
const { classifyListPageContent, pageResultFromError } = require('../src/sources/zujuan/response_classifier.cjs');
const { completionQualityFor, resolveFinalRunState, summarizeCompleteness } = require('../src/policies/completeness.cjs');
const { QuestionSyncError } = require('../src/shared/errors.cjs');

describe('pagination policy', () => {
  it('total 增大只扩展目标页数，减小或缺失不收缩', () => {
    assert.equal(growTargetPages(10, 10013, 10), 1002);
    assert.equal(growTargetPages(1002, 10012, 10), 1002);
    assert.equal(growTargetPages(1002, 0, 10), 1002);
    assert.equal(growTargetPages(1002, null, 10), 1002);
    assert.equal(growTargetPages(0, 0, 10), 0);
  });

  it('安全上限可配置，显式 maxPages 不超过安全上限', () => {
    assert.equal(catalogSafetyPageLimit({}), 10000);
    assert.equal(catalogSafetyPageLimit({ safetyPageLimit: 50 }), 50);
    assert.equal(catalogLastPage({ maxPagesProvided: true, maxPages: 80, safetyPageLimit: 50 }), 50);
    assert.equal(catalogLastPage({ maxPagesProvided: false, maxPages: 3 }), 10000);
  });

  it('完全相同的非空页签名判为 pagination_loop，空页返回 null', () => {
    const previous = new Set();
    const first = validatePageResult({
      questions: [{ externalId: '1' }, { externalId: '2' }],
      questionIds: ['1', '2'],
    }, 1, 2, previous);
    previous.add(first);
    assert.equal(typeof first, 'string');
    assert.throws(
      () => validatePageResult({
        questions: [{ externalId: '1' }, { externalId: '2' }],
        questionIds: ['1', '2'],
      }, 2, 2, previous),
      (error) => error instanceof QuestionSyncError && error.code === 'pagination_loop',
    );
    assert.equal(validatePageResult({ questions: [], questionIds: [] }, 3, 3, previous), null);
  });
});

describe('page result classification', () => {
  it('空页、重复页、解析失败分别分类', () => {
    assert.equal(classifyListPageContent('', []), PAGE_RESULT.EMPTY_PAGE);
    assert.equal(pageResultFromError({ code: 'pagination_loop' }), PAGE_RESULT.DUPLICATE_PAGE);
    assert.equal(pageResultFromError({ code: 'list_api_contract' }), PAGE_RESULT.PARSE_FAILED);
  });
});

describe('completeness policy', () => {
  it('扫描完成但有数据问题标记 completed_with_issues 且不可完整应用', () => {
    const verdict = summarizeCompleteness({
      scanReasons: [],
      dataReasons: ['duplicate_page'],
    });
    assert.equal(verdict.scanComplete, true);
    assert.equal(verdict.dataComplete, false);
    assert.equal(verdict.completionQuality, 'completed_with_issues');
    assert.equal(verdict.snapshotComplete, false);
    const finalState = resolveFinalRunState('success', verdict);
    assert.equal(finalState.effectiveStatus, 'success');
    assert.equal(finalState.snapshotComplete, false);
    assert.equal(completionQualityFor(true, true), 'completed');
    assert.equal(completionQualityFor(false, false), null);
  });
});
