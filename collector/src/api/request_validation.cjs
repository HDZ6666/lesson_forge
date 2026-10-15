'use strict';

/**
 * Request validation for POST /v1/jobs: only fixed job types, bounded page
 * caps, safe source IDs and a frozen per-textbook scope.  No script names,
 * paths, SQL or commands are ever accepted from a request.
 */

const { MAX_SELECTED_TEXTBOOKS, safeExternalId } = require('../storage/readers/index.cjs');
const { validateQuestionListResumeSourceRun } = require('../storage/resume.cjs');

const PROVIDER = 'zujuan';
const MAX_SCOPE_NAME_LENGTH = 200;

function deploymentBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error('COLLECTOR_HEADFUL 必须是 true/false');
}

function requestBoolean(value, name, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是 true 或 false`);
  return value;
}

function scopeErrorText(summary, fallback = null) {
  if (!summary) return fallback;
  const first = Array.isArray(summary.errors) && summary.errors.length > 0 ? summary.errors[0].message : null;
  return String(summary.message || first || fallback || '').slice(0, 1000) || null;
}

function intInRange(value, name, min, max) {
  if (typeof value === 'boolean' || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return parsed;
}

function normalizeScopeExternalId(value, name) {
  if (value == null || typeof value === 'boolean' || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new Error(`${name} 格式不安全`);
  }
  const normalized = String(value).trim();
  if (!safeExternalId(normalized)) throw new Error(`${name} 格式不安全`);
  return normalized;
}

function normalizeScopeName(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SCOPE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} 长度或格式不安全`);
  }
  return normalized;
}

function serverContentScope(scope, maxPages, limitTo1000Pages = false) {
  const textbookId = String(scope.externalTextbookId || '').trim();
  const chapterId = String(scope.bootstrapChapterExternalId || textbookId).trim();
  return {
    chapterIds: chapterId ? [chapterId] : [],
    textbookId,
    catalogLevels: [1, 2, 3],
    catalogIds: [],
    allCatalogs: true,
    withinChapterIds: [],
    filters: {
      scene: null,
      questionType: null,
      difficulty: null,
      category: null,
      year: null,
      fresh: false,
      sort: { id: 2, name: '最新' },
    },
    startPage: 1,
    maxPages: Number(maxPages),
    limitTo1000Pages: limitTo1000Pages === true,
    details: false,
    detailFallback: true,
    refreshDetails: false,
    includeVisibleSolutions: false,
    downloadAssets: true,
    requireDetails: false,
    requireAssets: true,
    limit: 0,
    truncated: false,
  };
}

function validateIndependentResumeScopes(dbPath, scopes, maxPages, limitTo1000Pages = false) {
  for (const scope of scopes || []) {
    if (scope.resumeFromCollectorRunId == null) continue;
    const expected = serverContentScope(scope, maxPages, limitTo1000Pages);
    try {
      validateQuestionListResumeSourceRun(dbPath, scope.resumeFromCollectorRunId, expected);
    } catch (error) {
      const wrapped = new Error(`教材 ${scope.externalTextbookId} 的续采来源无效：${String(error.message || error)}`);
      wrapped.code = error.code || 'resume_source_invalid';
      wrapped.statusCode = Number(error.statusCode || 400);
      throw wrapped;
    }
  }
}

function normalizeIndependentTextbookScopes(payload) {
  if (!Array.isArray(payload.textbookScopes)) {
    throw new Error('textbookScopes 必须是数组');
  }
  if (!payload.textbookScopes.length || payload.textbookScopes.length > MAX_SELECTED_TEXTBOOKS) {
    throw new Error(`教材范围数量必须在 1 到 ${MAX_SELECTED_TEXTBOOKS} 之间`);
  }
  if (payload.workflowVersion !== 1 && payload.textbookScopes.length !== 1) {
    throw new Error('新同步任务必须且只能选择一本教材');
  }
  if (payload.sourceNamespace != null && payload.sourceNamespace !== 'zujuan:junior:math') {
    throw new Error('该来源学段学科的采集适配尚未验证');
  }
  if (!Array.isArray(payload.textbookExternalIds)) {
    throw new Error('使用 textbookScopes 时必须提供 textbookExternalIds 数组');
  }
  if (payload.textbookExternalIds.length !== payload.textbookScopes.length) {
    throw new Error('textbookExternalIds 与 textbookScopes 数量不一致');
  }

  const selectedIds = payload.textbookExternalIds.map((value) => normalizeScopeExternalId(value, '教材来源 ID'));
  const seenTextbooks = new Set();
  const scopes = payload.textbookScopes.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`textbookScopes[${index}] 必须是对象`);
    }
    const sourceProvider = raw.sourceProvider;
    if (sourceProvider !== PROVIDER) {
      throw new Error(`textbookScopes[${index}] 来源提供方不受支持`);
    }
    const externalVersionId = normalizeScopeExternalId(
      raw.externalVersionId,
      `textbookScopes[${index}].externalVersionId`,
    );
    const externalTextbookId = normalizeScopeExternalId(
      raw.externalTextbookId,
      `textbookScopes[${index}].externalTextbookId`,
    );
    const versionName = normalizeScopeName(raw.versionName, `textbookScopes[${index}].versionName`);
    const textbookName = normalizeScopeName(raw.textbookName, `textbookScopes[${index}].textbookName`);
    if (seenTextbooks.has(externalTextbookId)) {
      throw new Error('textbookScopes 不能包含重复教材来源 ID');
    }
    seenTextbooks.add(externalTextbookId);
    if (selectedIds[index] !== externalTextbookId) {
      throw new Error('textbookExternalIds 与 textbookScopes 的顺序或映射不一致');
    }
    const scope = {
      sourceProvider: PROVIDER,
      externalVersionId,
      externalTextbookId,
      versionName,
      textbookName,
    };
    if (raw.bootstrapChapterExternalId != null && raw.bootstrapChapterExternalId !== '') {
      scope.bootstrapChapterExternalId = normalizeScopeExternalId(
        raw.bootstrapChapterExternalId,
        `textbookScopes[${index}].bootstrapChapterExternalId`,
      );
    }
    if (raw.resumeFromCollectorRunId != null && raw.resumeFromCollectorRunId !== '') {
      scope.resumeFromCollectorRunId = intInRange(
        raw.resumeFromCollectorRunId,
        `textbookScopes[${index}].resumeFromCollectorRunId`,
        1,
        Number.MAX_SAFE_INTEGER,
      );
    }
    return scope;
  });
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('教材选择列表不能包含重复 ID');
  }
  return { textbookExternalIds: selectedIds, scopes };
}

module.exports = {
  MAX_SCOPE_NAME_LENGTH,
  PROVIDER,
  deploymentBoolean,
  intInRange,
  requestBoolean,
  normalizeIndependentTextbookScopes,
  normalizeScopeExternalId,
  normalizeScopeName,
  scopeErrorText,
  serverContentScope,
  validateIndependentResumeScopes,
};
