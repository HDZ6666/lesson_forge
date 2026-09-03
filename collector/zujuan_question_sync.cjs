#!/usr/bin/env node

'use strict';

/*
 * Independent, list-API-only question collector.
 *
 * This file intentionally does not call zujuan_sync.cjs.  The old collector
 * is a page-click/detail-page collector and has a different default Chrome
 * mode.  This entry point is for validating the complete question-list
 * contract first; it writes only collector SQLite/run snapshots and never
 * talks to the formal database or service code.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const {
  migrateRunSnapshotSchema,
} = require('./lib/run_snapshots.cjs');
const {
  closeCollectorContext,
  launchCollectorContext,
  StopCrawlError,
} = require('./zujuan_metadata_sync.cjs');
const {
  validateResumeSourceRun,
} = require('./zujuan_sync.cjs');
const {
  assetKey: canonicalAssetKey,
  normalizeHtml: normalizePackageHtml,
} = require('./lib/qbpkg/normalize.cjs');

const PROVIDER = 'zujuan';
const DEFAULT_BASE_URL = 'https://zujuan.xkw.com';
const DEFAULT_BANK_ID = 2;
const DEFAULT_BANK_PATH = 'czsx';
const DEFAULT_TEXTBOOK_ID = '260617';
const DEFAULT_API_PATH = '/zujuan-api/question/list';
const DEFAULT_DELAY_MIN = 2500;
const DEFAULT_DELAY_MAX = 4000;
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_VERIFICATION_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_VERIFICATION_POLL = 1000;
const DEFAULT_VERIFICATION_PROBE_INTERVAL = 5000;
const SITE_PAGE_LIMIT = 1000;
const MAX_RETRIES = 3;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
// Keep the exact lock used by zujuan_sync.cjs and server.cjs.  The question
// proof-of-concept must not race the existing collector over either DB or
// persistent Chrome profile.
const LOCK_SUFFIX = '.lock';

const RETRYABLE_HTTP = new Set([408, 500, 502, 503, 504]);
const FORMAL_ASSET_TYPES = Object.freeze([
  'question_image',
  'formula_image',
  'svg',
  'other',
]);
const PROTECTION_MARKERS = Object.freeze([
  'challenge',
  'captcha',
  '验证码',
  '安全验证',
  '滑块验证',
  '请按住滑块',
  '拖动滑块',
  '访问验证',
  '访问过于频繁',
  '异常访问',
  'cf-chl-',
  'access denied',
  'forbidden',
]);
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const ALLOWED_PAGE_HOSTS = new Set(['zujuan.xkw.com']);
const ALLOWED_TREE_HOSTS = new Set(['static.zxxk.com']);
const ALLOWED_ASSET_HOSTS = new Set([
  'staticzujuan.xkw.com',
  'img.xkw.com',
  'zujuan.xkw.com',
]);

class QuestionSyncError extends Error {
  constructor(message, code = 'question_sync_error', details = null) {
    super(message);
    this.name = 'QuestionSyncError';
    this.code = code;
    this.details = details;
  }
}

class VerificationRequiredError extends QuestionSyncError {
  constructor(message, details = null) {
    super(message, 'waiting_verification', details);
    this.name = 'VerificationRequiredError';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function randomBetween(min, max) {
  const low = Math.max(0, Number(min) || 0);
  const high = Math.max(low, Number(max) || low);
  return Math.floor(low + Math.random() * (high - low + 1));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonStringify(value, fallback = '{}') {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? fallback : result;
  } catch {
    return fallback;
  }
}

function sqliteValue(value, fallback = null) {
  return value === undefined ? fallback : value;
}

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function normalizeId(value) {
  return String(value ?? '').trim();
}

function safeFilePart(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeFileAtomic(target, content) {
  ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, target);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(
    /&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp|#x27);/gi,
    (full, token) => {
      const lower = String(token).toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos' || lower === '#x27') return "'";
      if (lower === 'nbsp') return '\u00a0';
      if (lower.startsWith('#x')) {
        const number = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(number) ? String.fromCodePoint(number) : full;
      }
      if (lower.startsWith('#')) {
        const number = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(number) ? String.fromCodePoint(number) : full;
      }
      return full;
    },
  );
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function classListFromAttrs(attrs) {
  return String(attrs?.class || '').split(/\s+/).filter(Boolean);
}

function hasClass(attrs, wanted) {
  return classListFromAttrs(attrs).includes(wanted);
}

function parseAttributes(openTag) {
  const text = String(openTag || '').replace(/^<[^\s>]+\s*|\s*\/?>$/g, '');
  const attrs = {};
  const attrPattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attrPattern.exec(text))) {
    const key = String(match[1]);
    const value = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
    attrs[key] = value;
    attrs[key.toLowerCase()] = value;
  }
  return attrs;
}

function openingTagAt(html, index) {
  const rest = String(html).slice(index);
  const match = rest.match(/^<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/);
  if (!match) return null;
  return {
    tag: String(match[1]).toLowerCase(),
    text: match[0],
    end: index + match[0].length,
    attrs: parseAttributes(match[0]),
  };
}

function findMatchingTag(html, start, tag) {
  const source = String(html);
  const wanted = String(tag).toLowerCase();
  const tokenPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/g;
  tokenPattern.lastIndex = Number(start) || 0;
  let depth = 1;
  let match;
  while ((match = tokenPattern.exec(source))) {
    const token = match[0];
    const tokenTag = String(match[1] || '').toLowerCase();
    if (!tokenTag || token.startsWith('<!--')) continue;
    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(tokenTag);
    if (tokenTag !== wanted) continue;
    if (!closing && !selfClosing) depth += 1;
    if (closing) {
      depth -= 1;
      if (depth === 0) return { start: match.index, end: tokenPattern.lastIndex };
    }
  }
  return null;
}

/**
 * Small dependency-free HTML fragment scanner.  It is deliberately limited
 * to the provider's stable list markup, but balances nested divs so a table
 * or an option containing divs cannot truncate a question block.
 */
function findElements(html, predicate, wantedTag = null) {
  const source = String(html ?? '');
  const result = [];
  const openPattern = /<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/g;
  let match;
  while ((match = openPattern.exec(source))) {
    const token = match[0];
    if (/^<\//.test(token) || /^<!--/.test(token) || /\/\s*>$/.test(token)) continue;
    const tag = String(match[1]).toLowerCase();
    if (wantedTag && tag !== String(wantedTag).toLowerCase()) continue;
    const attrs = parseAttributes(token);
    if (!predicate(attrs, tag, token)) continue;
    const start = match.index;
    if (VOID_TAGS.has(tag)) {
      result.push({
        tag,
        attrs,
        open: token,
        inner: '',
        outer: token,
        start,
        end: openPattern.lastIndex,
      });
      continue;
    }
    const closing = findMatchingTag(source, openPattern.lastIndex, tag);
    if (!closing) continue;
    result.push({
      tag,
      attrs,
      open: token,
      inner: source.slice(openPattern.lastIndex, closing.start),
      outer: source.slice(start, closing.end),
      start,
      end: closing.end,
    });
  }
  return result;
}

function findByClass(html, className, tag = null) {
  return findElements(html, (attrs) => hasClass(attrs, className), tag);
}

function firstByClass(html, className, tag = null) {
  return findByClass(html, className, tag)[0] || null;
}

function findByAttribute(html, attribute, expected = null, tag = null) {
  const wanted = String(attribute).toLowerCase();
  return findElements(html, (attrs) => {
    const value = attrs[wanted] ?? attrs[attribute];
    return value !== undefined && (expected == null || String(value) === String(expected));
  }, tag);
}

function firstByAttribute(html, attribute, expected = null, tag = null) {
  return findByAttribute(html, attribute, expected, tag)[0] || null;
}

function elementText(element) {
  return element ? stripHtml(element.inner) : '';
}

function attr(attrs, name, fallback = null) {
  if (!attrs) return fallback;
  const wanted = String(name).toLowerCase();
  return attrs[wanted] ?? attrs[name] ?? fallback;
}

function absoluteUrl(value, baseUrl) {
  if (!value) return null;
  try { return new URL(value, baseUrl).href; } catch { return null; }
}

function parseCatalogQueryFromHref(value, fallbackCategoryId = null) {
  const source = String(value || '').trim();
  const fallback = normalizeId(fallbackCategoryId);
  if (!source) {
    return {
      categoryId: fallback || null,
      catelogTokpointId: '0',
      parsed: false,
    };
  }
  let pathname = source;
  try { pathname = new URL(source, DEFAULT_BASE_URL).pathname; } catch {}
  const match = pathname.match(/\/zj([^/?#]+)(?:\/ctk([^/?#]+))?/i);
  if (!match) {
    throw new QuestionSyncError(`目录 href 无法解析题目查询参数：${source}`, 'tree_contract');
  }
  return {
    categoryId: normalizeId(match[1]),
    catelogTokpointId: normalizeId(match[2]) || '0',
    parsed: true,
  };
}

function parseDifficulty(value) {
  const text = normalizeWhitespace(value);
  const coefficientMatch = text.match(/[（(]\s*(\d+(?:\.\d+)?)\s*[)）]/);
  const label = normalizeWhitespace(text.replace(/[（(]\s*\d+(?:\.\d+)?\s*[)）]\s*$/, '')) || null;
  return {
    label,
    coefficient: coefficientMatch ? Number(coefficientMatch[1]) : null,
  };
}

function countSubquestions(text) {
  const matches = String(text || '').match(/(?:^|\s|\n)[（(]\s*\d+[)）]/g);
  return matches ? matches.length : 0;
}

function stripListOrdinal(value, questionIndex) {
  const source = String(value ?? '').trim();
  const index = Number(questionIndex);
  if (!Number.isSafeInteger(index) || index < 0) return source;
  return source.replace(new RegExp(`^\\s*${index + 1}\\s*[.．]\\s*`), '');
}

function normalizeAssetType(url, originalType = null) {
  const source = String(url || '').toLowerCase();
  const original = String(originalType || '').toLowerCase();
  if (/\.svg(?:$|[?#])/.test(source) || original === 'svg') return 'svg';
  if (source.includes('/formula/') || original === 'formula' || original === 'formula_image') {
    return 'formula_image';
  }
  if (/\.(?:png|jpe?g|gif|webp|bmp)(?:$|[?#])/.test(source)
    || original === 'image' || original === 'question_image') return 'question_image';
  return 'other';
}

function classifyAsset(url) {
  const normalized = normalizeAssetType(url);
  return normalized;
}

function parseQuestionBlock(block, baseUrl = DEFAULT_BASE_URL) {
  const root = firstByClass(block, 'tk-quest-item', 'div') || {
    attrs: {},
    inner: block,
    outer: block,
  };
  const rootAttrs = root.attrs || {};
  const item = root.outer || block;
  const addButton = firstByClass(item, 'addques', 'a')
    || firstByAttribute(item, 'quesid', null, 'a');
  const addAttrs = addButton?.attrs || {};
  const info = findByClass(item, 'info-cnt').map(elementText).map(normalizeWhitespace);
  const difficulty = parseDifficulty(info[1] || attr(addAttrs, 'qdname', ''));
  const content = firstByClass(item, 'exam-item__cnt', 'div');
  const questionIndex = attr(rootAttrs, 'questionindex');
  const contentHtml = content ? stripListOrdinal(content.inner, questionIndex) : '';
  const plainText = contentHtml ? stripHtml(contentHtml) : '';
  const source = firstByClass(item, 'ques-src', 'a');
  const detail = findByClass(item, 'detail', 'a').find((entry) => (
    /(?:^|\/)2q\d+\.html/i.test(String(attr(entry.attrs, 'href', '')))
    || String(attr(entry.attrs, 'data-btntype', '')).toLowerCase() === 'quesdetail'
  )) || firstByClass(item, 'detail', 'a');
  const sourceTitle = normalizeWhitespace(
    String(attr(source?.attrs, 'title', '') || '').replace(/^原始出处\s*[：:]\s*/, ''),
  ) || null;
  const sourceShort = normalizeWhitespace(elementText(source)) || null;
  const detailUrl = absoluteUrl(attr(detail?.attrs, 'href'), baseUrl);
  const sourceUrl = absoluteUrl(attr(source?.attrs, 'href'), baseUrl);
  const images = findElements(contentHtml, (attrs, tag) => tag === 'img', 'img');
  const assets = images.map((image) => {
    const imageUrl = absoluteUrl(attr(image.attrs, 'src') || attr(image.attrs, 'data-src'), baseUrl);
    const originalType = String(imageUrl || '').toLowerCase().includes('/formula/')
      ? 'formula'
      : (/\.svg(?:$|[?#])/i.test(String(imageUrl || '')) ? 'svg' : 'image');
    return {
      sourceUrl: imageUrl,
      url: imageUrl,
      type: normalizeAssetType(imageUrl, originalType),
      assetType: normalizeAssetType(imageUrl, originalType),
      originalType,
      originalUrl: attr(image.attrs, 'src') || attr(image.attrs, 'data-src') || null,
    };
  }).filter((asset) => asset.url);

  const knowledge = [];
  for (const link of findByClass(item, 'knowledge-item', 'a')) {
    const href = String(attr(link.attrs, 'href', ''));
    const ability = href.match(/tre\d+-(\d+)/i);
    const point = href.match(/zsd(\d+)/i);
    const name = normalizeWhitespace(elementText(link));
    const externalId = ability?.[1] || point?.[1] || attr(link.attrs, 'cid') || name;
    if (!name || !externalId) continue;
    knowledge.push({
      externalId: String(externalId),
      name,
      kind: ability ? 'ability' : 'knowledge_point',
      evidenceType: 'provider_asserted',
      sourceUrl: absoluteUrl(href, baseUrl),
    });
  }
  const seenKnowledge = new Set();
  const uniqueKnowledge = knowledge.filter((entry) => {
    const key = `${entry.kind}:${entry.externalId}`;
    if (seenKnowledge.has(key)) return false;
    seenKnowledge.add(key);
    return true;
  });

  const rightTags = findByClass(item, 'tag').map(elementText).map(normalizeWhitespace).filter(Boolean);
  const isNew = hasClass(rootAttrs, 'new') || rightTags.includes('新题');
  if (isNew && !rightTags.includes('新题')) rightTags.push('新题');
  const providerLabels = rightTags.map((value) => ({
    dimension: value === '新题' ? 'fresh' : 'provider_tag',
    value,
    tagValue: value,
    relationType: 'provider_label',
    evidenceType: 'provider_asserted',
  }));

  const infoTitles = findElements(item, (attrs) => attr(attrs, 'title') != null)
    .map((entry) => String(attr(entry.attrs, 'title', '')));
  const usageTitle = infoTitles.find((value) => /次组卷/.test(decodeHtmlEntities(value)));
  const usageMatch = String(usageTitle || '').match(/(\d+)\s*次组卷/);
  const referenceContainer = firstByClass(item, 'look-more-src');
  const referenceLabel = normalizeWhitespace(
    elementText(firstByClass(referenceContainer?.outer || '', 'info-txt'))
      || elementText(referenceContainer),
  );
  const referenceCountMatch = referenceLabel.match(/(\d+)\s*卷引用/);
  const referencePapers = findByClass(referenceContainer?.outer || item, 'src-item', 'a')
    .map((entry) => ({
      name: normalizeWhitespace(attr(entry.attrs, 'title') || elementText(entry)),
      url: absoluteUrl(attr(entry.attrs, 'href'), baseUrl),
    }))
    .filter((entry) => entry.name);

  const dateElement = firstByClass(item, 'no-bound', 'span');
  const websiteTimeText = normalizeWhitespace(
    attr(dateElement?.attrs, 'title') || elementText(dateElement),
  ) || null;
  const categoryId = attr(addAttrs, 'categoryid') || attr(addAttrs, 'categoryId');
  const categoryName = attr(addAttrs, 'categoryname') || attr(addAttrs, 'categoryName');
  const qdid = attr(addAttrs, 'qdid');
  const qdname = attr(addAttrs, 'qdname');
  const qdvalue = attr(addAttrs, 'qdvalue');
  const questionTypeId = attr(addAttrs, 'qyid');
  const questionTypeName = attr(addAttrs, 'qyname');
  const titleAbbreviation = attr(addAttrs, 'titleabbreviation');
  const externalId = attr(rootAttrs, 'questionid') || attr(addAttrs, 'quesid');
  const bankIdValue = attr(rootAttrs, 'bankid') || attr(addAttrs, 'bankid');
  const rawDifficulty = {
    qdid: qdid == null ? null : String(qdid),
    qdname: qdname == null ? null : String(qdname),
    qdvalue: qdvalue == null || qdvalue === '' ? null : Number(qdvalue),
  };
  const difficultyLabel = difficulty.label || normalizeWhitespace(qdname) || null;
  const easeCoefficient = difficulty.coefficient == null
    ? (rawDifficulty.qdvalue == null ? null : rawDifficulty.qdvalue)
    : difficulty.coefficient;
  const providerCategory = categoryId || categoryName ? {
    id: categoryId == null || categoryId === '' ? null : String(categoryId),
    name: categoryName == null || categoryName === '' ? null : normalizeWhitespace(categoryName),
  } : null;

  return {
    externalId: externalId == null ? null : String(externalId),
    questionId: externalId == null ? null : String(externalId),
    bankId: bankIdValue == null || bankIdValue === '' ? null : Number(bankIdValue),
    bankid: bankIdValue == null || bankIdValue === '' ? null : Number(bankIdValue),
    questionType: info[0] || normalizeWhitespace(questionTypeName) || null,
    questionTypeId: questionTypeId == null ? null : String(questionTypeId),
    questionTypeName: questionTypeName == null ? null : normalizeWhitespace(questionTypeName),
    qyid: questionTypeId == null ? null : String(questionTypeId),
    qyname: questionTypeName == null ? null : normalizeWhitespace(questionTypeName),
    difficultyLabel,
    difficultyCode: rawDifficulty.qdid,
    difficultyQdid: rawDifficulty.qdid,
    difficultyName: rawDifficulty.qdname,
    easeCoefficient,
    difficultyCoefficient: easeCoefficient,
    qdid: rawDifficulty.qdid,
    qdname: rawDifficulty.qdname,
    qdvalue: rawDifficulty.qdvalue,
    rawDifficulty,
    contentHtml: contentHtml || null,
    plainText: plainText || null,
    contentSource: 'list_api',
    contentComplete: Boolean(contentHtml && plainText),
    detailFetched: false,
    detailUrl,
    sourceShort,
    sourceTitle,
    sourceUrl,
    titleAbbreviation: titleAbbreviation == null ? null : normalizeWhitespace(titleAbbreviation),
    titleabbreviation: titleAbbreviation == null ? null : normalizeWhitespace(titleAbbreviation),
    providerCategoryId: categoryId == null || categoryId === '' ? null : String(categoryId),
    providerCategoryName: categoryName == null || categoryName === '' ? null : normalizeWhitespace(categoryName),
    categoryId: categoryId == null || categoryId === '' ? null : String(categoryId),
    categoryName: categoryName == null || categoryName === '' ? null : normalizeWhitespace(categoryName),
    providerCategory,
    websiteTimeText,
    date: websiteTimeText,
    providerUpdatedAt: websiteTimeText,
    useCount: usageMatch ? Number(usageMatch[1]) : null,
    assembleCount: usageMatch ? Number(usageMatch[1]) : null,
    referenceCount: referenceCountMatch
      ? Number(referenceCountMatch[1])
      : (referencePapers.length ? referencePapers.length : null),
    referencePapers,
    referenceLabel: referenceLabel || null,
    isNew,
    subquestionCount: countSubquestions(plainText),
    childCount: attr(addAttrs, 'childnum') == null ? null : Number(attr(addAttrs, 'childnum')),
    hasImage: assets.some((asset) => asset.type === 'question_image'),
    hasFormula: assets.some((asset) => asset.type === 'formula_image' || asset.type === 'svg'),
    hasTable: /<table\b/i.test(contentHtml),
    knowledge: uniqueKnowledge,
    providerLabels,
    assets,
    answerHtml: null,
    analysisHtml: null,
    solutionHtml: null,
    answerStatus: 'not_collected',
    raw: {
      questionId: externalId == null ? null : String(externalId),
      bankId: bankIdValue == null ? null : String(bankIdValue),
      qyid: questionTypeId == null ? null : String(questionTypeId),
      qyname: questionTypeName == null ? null : String(questionTypeName),
      qdid: rawDifficulty.qdid,
      qdname: rawDifficulty.qdname,
      qdvalue: rawDifficulty.qdvalue,
      categoryid: providerCategory?.id || null,
      categoryname: providerCategory?.name || null,
      titleabbreviation: titleAbbreviation || null,
      websiteTimeText,
      assembleCount: usageMatch ? Number(usageMatch[1]) : null,
      referenceCount: referenceCountMatch ? Number(referenceCountMatch[1]) : null,
      questionIndex: questionIndex == null ? null : Number(questionIndex),
    },
  };
}

function extractQuestionBlocks(html) {
  const source = String(html ?? '');
  return findByClass(source, 'tk-quest-item', 'div').map((entry) => entry.outer);
}

function normalizeQuestionContent(item, assets) {
  const allAssets = (Array.isArray(assets) ? assets : []).filter((asset) => asset?.sourceUrl);
  const skippedAssets = allAssets.filter((asset) => asset.skipped || asset.ignored);
  const normalizedAssets = allAssets.filter((asset) => !asset.skipped && !asset.ignored);
  const assetsByUrl = new Map(normalizedAssets.map((asset) => [asset.sourceUrl, {
    ...asset,
    assetKey: canonicalAssetKey(asset.assetType || asset.type, asset.sourceUrl),
  }]));
  const sourceHtml = removeAssetImagesBySource(item?.contentHtml, skippedAssets.map((asset) => asset.sourceUrl));
  const normalized = normalizePackageHtml(sourceHtml, assetsByUrl);
  const html = String(normalized.html || '').trim();
  const text = normalizeWhitespace(stripHtml(html));
  const stable = html || text;
  return {
    html: html || null,
    text: text || null,
    hash: stable ? sha256(stable) : null,
    assets: normalizedAssets.map((asset) => assetsByUrl.get(asset.sourceUrl) || asset),
    missingAssets: normalized.missingAssets || [],
    errors: normalized.errors || [],
  };
}

function finalizeQuestion(question) {
  const item = question && typeof question === 'object' ? { ...question } : {};
  const assets = (Array.isArray(item.assets) ? item.assets : []).map((asset) => {
    const sourceUrl = String(asset.sourceUrl || asset.url || '').trim();
    const assetType = normalizeAssetType(sourceUrl, asset.originalType || asset.type);
    return {
      ...asset,
      sourceUrl,
      url: sourceUrl,
      type: assetType,
      assetType,
      originalType: asset.originalType || asset.type || null,
    };
  }).filter((asset) => asset.sourceUrl);
  const uniqueAssets = [];
  const seenAssets = new Set();
  for (const asset of assets) {
    if (seenAssets.has(asset.sourceUrl)) continue;
    seenAssets.add(asset.sourceUrl);
    uniqueAssets.push(asset);
  }
  const normalizedContent = normalizeQuestionContent(item, uniqueAssets);
  // The list collector never publishes a package directly, but keeping the
  // same normalized HTML/hash here makes the SQLite snapshot immediately
  // consumable by qbpkg and prevents a later apply from seeing raw CDN URLs.
  const html = normalizedContent.html;
  const text = normalizeWhitespace(normalizedContent.text || stripHtml(html) || item.plainText);
  const stable = html || text;
  return {
    ...item,
    contentHtml: html || null,
    plainText: text || null,
    contentSource: item.contentSource || 'list_api',
    contentComplete: Boolean(html && text),
    contentHash: stable ? sha256(stable) : null,
    // Recompute after every asset/HTML rewrite. A formula fallback or a
    // skipped placeholder changes the canonical HTML and must change the
    // list revision hash as well.
    listContentHash: stable ? sha256(stable) : null,
    detailContentHash: item.detailContentHash || null,
    detailFetched: false,
    answerHtml: null,
    analysisHtml: null,
    solutionHtml: null,
    answerStatus: 'not_collected',
    subquestionCount: Number(item.subquestionCount) || countSubquestions(text),
    hasImage: normalizedContent.assets.some((asset) => asset.type === 'question_image'),
    hasFormula: normalizedContent.assets.some((asset) => asset.type === 'formula_image' || asset.type === 'svg'),
    assets: normalizedContent.assets,
    htmlAssetErrors: normalizedContent.errors || [],
    missingAssets: normalizedContent.missingAssets || [],
    difficultyCode: item.difficultyCode == null ? null : String(item.difficultyCode),
    difficultyQdid: item.difficultyQdid == null
      ? (item.difficultyCode == null ? null : String(item.difficultyCode))
      : String(item.difficultyQdid),
    easeCoefficient: item.easeCoefficient == null
      ? (item.difficultyCoefficient == null ? null : Number(item.difficultyCoefficient))
      : Number(item.easeCoefficient),
    raw: item.raw || {},
  };
}

function parseQuestionListHtml(html, baseUrl = DEFAULT_BASE_URL) {
  const source = String(html ?? '');
  const blocks = extractQuestionBlocks(source);
  const questions = blocks.map((block) => finalizeQuestion(parseQuestionBlock(block, baseUrl)));
  if (questions.some((question) => !normalizeId(question.externalId))) {
    throw new QuestionSyncError('题目列表存在缺少稳定题号的题卡。', 'list_api_contract');
  }
  return {
    questions,
    questionIds: questions.map((question) => String(question.externalId)),
    html: source,
  };
}

function parseQuestionListPayload(payload, baseUrl = DEFAULT_BASE_URL) {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (error) {
      throw new QuestionSyncError(`题目列表接口不是有效 JSON：${error.message}`, 'list_api_contract');
    }
  }
  if (!value || String(value.code) !== '0' || !value.data || typeof value.data !== 'object') {
    throw new QuestionSyncError(
      `题目列表接口返回异常：${jsonStringify(value).slice(0, 800)}`,
      'list_api_contract',
    );
  }
  const html = String(value.data.html || '');
  const totalRaw = Number(value.data.total);
  const total = Number.isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : null;
  if (total == null) {
    throw new QuestionSyncError('题目列表接口缺少有效 total。', 'list_api_contract');
  }
  const parsed = parseQuestionListHtml(html, baseUrl);
  const ids = parsed.questionIds;
  if (ids.some((value) => !normalizeId(value))) {
    throw new QuestionSyncError('题目列表存在空题号。', 'list_api_contract');
  }
  if (new Set(ids).size !== ids.length) {
    throw new QuestionSyncError('题目列表单页含重复题目 ID。', 'page_duplicate_questions');
  }
  if (total > 0 && !html.trim()) {
    throw new QuestionSyncError('题目列表 total>0 但 html 为空。', 'empty_page');
  }
  if (total > 0 && ids.length === 0) {
    throw new QuestionSyncError('题目列表 total>0 但未解析到题目。', 'list_api_contract');
  }
  if (total === 0 && ids.length > 0) {
    throw new QuestionSyncError('题目列表 total=0 但 html 含题目。', 'list_api_contract');
  }
  return {
    code: '0',
    total,
    pageCapacity: 10,
    questions: parsed.questions,
    questionIds: ids,
    html,
    data: value.data,
    rawPayload: value,
  };
}

// The textbook-root probe only needs the provider's denominator.  Keep this
// parser separate from the normal page parser so the probe never parses or
// persists the ten question cards returned alongside `total`.
function parseQuestionListTotalPayload(payload) {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (error) {
      throw new QuestionSyncError(`题目列表接口不是有效 JSON：${error.message}`, 'list_api_contract');
    }
  }
  if (!value || String(value.code) !== '0' || !value.data || typeof value.data !== 'object') {
    throw new QuestionSyncError(
      `题目列表接口返回异常：${jsonStringify(value).slice(0, 800)}`,
      'list_api_contract',
    );
  }
  const total = Number(value.data.total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new QuestionSyncError('教材根目录接口缺少有效 total。', 'list_api_contract');
  }
  return { code: '0', total };
}

function parseCatalogRoot(raw, textbookId) {
  let value = raw;
  if (value && typeof value === 'object' && value.data && typeof value.data === 'object'
    && !Array.isArray(value.data) && !value.children) value = value.data;
  if (Array.isArray(value)) {
    return {
      id: String(textbookId),
      title: String(textbookId),
      children: value,
      isKnowledge: 0,
    };
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.children)) {
    throw new QuestionSyncError('教材目录 JSON 缺少根节点 children。', 'tree_contract');
  }
  if (!value.id && value.children.length === 1
    && String(value.children[0]?.id || '') === String(textbookId)) {
    return value.children[0];
  }
  return value;
}

/**
 * Normalize the static tree.  The recursive JSON nesting is the display
 * parent; raw parentId is retained only in raw_json because knowledge nodes
 * use a different provider knowledge-system parent ID.
 */
function normalizeCatalogTree(raw, {
  textbookId = DEFAULT_TEXTBOOK_ID,
  bankId = DEFAULT_BANK_ID,
  bankPath = DEFAULT_BANK_PATH,
} = {}) {
  const root = parseCatalogRoot(raw, textbookId);
  const rootId = String(root.id || textbookId);
  if (rootId !== String(textbookId)) {
    throw new QuestionSyncError(
      `目录根 ID ${rootId} 与教材 ID ${textbookId} 不一致。`,
      'tree_contract',
    );
  }
  const nodes = [];
  const byId = new Map();
  const walk = (children, displayParent, ancestors, names) => {
    (Array.isArray(children) ? children : []).forEach((source, index) => {
      if (!source || typeof source !== 'object') {
        throw new QuestionSyncError('目录树包含非法节点。', 'tree_contract');
      }
      const externalId = normalizeId(source.id);
      const name = normalizeWhitespace(source.title);
      if (!externalId || !name) {
        throw new QuestionSyncError('目录节点缺少稳定 ID 或标题。', 'tree_contract');
      }
      if (byId.has(externalId)) {
        throw new QuestionSyncError(`目录 ID 重复：${externalId}`, 'tree_contract');
      }
      const isKnowledge = Number(source.isKnowledge) === 1 || source.isKnowledge === true;
      const level = ancestors.length + 1;
      const ancestorNodes = ancestors.map((id) => byId.get(id)).filter(Boolean);
      const nearestCategory = [...ancestorNodes].reverse().find((node) => !node.isKnowledge);
      const hrefQuery = parseCatalogQueryFromHref(
        source.href,
        isKnowledge ? (nearestCategory?.externalId || displayParent || externalId) : externalId,
      );
      if (isKnowledge && hrefQuery.parsed && hrefQuery.catelogTokpointId === '0') {
        throw new QuestionSyncError(`知识点目录缺少 ctk 参数：${source.href}`, 'tree_contract');
      }
      if (isKnowledge && hrefQuery.parsed
        && hrefQuery.catelogTokpointId !== externalId) {
        throw new QuestionSyncError(
          `知识点目录 ctk=${hrefQuery.catelogTokpointId} 与节点 ID=${externalId} 不一致：${source.href}`,
          'tree_contract',
        );
      }
      if (!isKnowledge && hrefQuery.parsed && hrefQuery.catelogTokpointId !== '0') {
        throw new QuestionSyncError(`普通目录意外包含 ctk 参数：${source.href}`, 'tree_contract');
      }
      const categoryId = isKnowledge
        ? (nearestCategory?.externalId || hrefQuery.categoryId || displayParent || externalId)
        : (hrefQuery.categoryId || externalId);
      const catelogTokpointId = isKnowledge ? externalId : '0';
      const ancestorIds = [...ancestors, externalId];
      const node = {
        externalId,
        textbookExternalId: String(textbookId),
        parentExternalId: displayParent ? String(displayParent) : null,
        rawParentExternalId: source.parentId == null ? null : String(source.parentId),
        level,
        type: isKnowledge ? 'point' : (level === 1 ? 'chapter' : 'section'),
        nodeType: isKnowledge ? 'point' : (level === 1 ? 'chapter' : 'section'),
        isKnowledge,
        name,
        sourcePath: source.href ? String(source.href) : null,
        path: [...names, name].filter(Boolean).join(' › '),
        sortOrder: index,
        categoryId: String(categoryId),
        catelogTokpointId: String(catelogTokpointId),
        ancestorIds,
        chapterExternalId: ancestorIds[0],
        raw: { ...source },
      };
      byId.set(externalId, node);
      nodes.push(node);
      walk(source.children, externalId, [...ancestors, externalId], [...names, name], index);
    });
  };
  walk(root.children, null, [], []);
  return {
    root: {
      externalId: rootId,
      textbookExternalId: String(textbookId),
      name: normalizeWhitespace(root.title) || String(textbookId),
      raw: root,
    },
    nodes,
    byId,
    bankId: Number(bankId),
    bankPath: String(bankPath),
  };
}

function selectCatalogs(tree, options = {}) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : (Array.isArray(tree) ? tree : []);
  const byId = new Map(nodes.map((node) => [String(node.externalId), node]));
  const requestedIds = Array.isArray(options.catalogIds) ? options.catalogIds.map(String) : [];
  let selected;
  if (requestedIds.length > 0) {
    const missing = requestedIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new QuestionSyncError(`目录树中未找到 catalog-id：${missing.join('、')}`, 'catalog_not_found');
    }
    selected = requestedIds.map((id) => byId.get(id));
  } else {
    const levels = Array.isArray(options.catalogLevels) && options.catalogLevels.length > 0
      ? new Set(options.catalogLevels.map(Number))
      : null;
    selected = nodes.filter((node) => !levels || levels.has(Number(node.level)));
  }
  const maxCatalogs = Number(options.maxCatalogs) || 0;
  if (maxCatalogs > 0) selected = selected.slice(0, maxCatalogs);
  return selected;
}

function catalogTreeUrl(options) {
  const url = new URL(
    `/zujuan/tree/ct_${options.bankId}_${options.textbookId}.json`,
    options.treeBaseUrl || 'https://static.zxxk.com',
  );
  url.searchParams.set('v', String(options.timestamp || Date.now()));
  url.searchParams.set('withCredentials', 'false');
  return url.href;
}

function initialTextbookUrl(options) {
  return new URL(
    `/${options.bankPath}/zj${options.textbookId}/`,
    options.baseUrl || DEFAULT_BASE_URL,
  ).href;
}

function questionListApiUrl(options) {
  return new URL(options.apiPath || DEFAULT_API_PATH, options.baseUrl || DEFAULT_BASE_URL).href;
}

function buildQuestionListBody(options, catalog, pageNumber) {
  const node = catalog || {};
  return {
    pageName: 'zj',
    bankId: String(options.bankId ?? DEFAULT_BANK_ID),
    courseId: '0',
    canTreeMultiple: 'false',
    canCategoryId: 'true',
    'categoryIds[0]': '0',
    quesType: '0',
    quesDiff: '0',
    difficultyMin: '-1',
    difficultyMax: '-1',
    quesYear: '0',
    paperTypeId: '0',
    scenarioizedTypeId: '0',
    tagId: '0',
    provinceId: '-1',
    learngrade: '0',
    term: '0',
    orderBy: '2',
    curPage: String(pageNumber),
    quesAttributeId: '0',
    examMethodId: '0',
    isFresh: '0',
    treeMultiple: 'false',
    categoryId: String(node.categoryId ?? node.externalId ?? '0'),
    catelogTokpointId: String(node.catelogTokpointId ?? '0'),
  };
}

function serializeFormBody(body) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body || {})) form.set(key, String(value ?? ''));
  return form.toString();
}

function buildQuestionListRequest(options, catalog, pageNumber) {
  const body = buildQuestionListBody(options, catalog, pageNumber);
  return {
    url: questionListApiUrl(options),
    // page.evaluate receives this value by structured clone.  Pass the
    // actual form-urlencoded string, never the body object (which fetch
    // would stringify as "[object Object]").
    body: serializeFormBody(body),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    credentials: 'include',
  };
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers === 'object' && !Array.isArray(headers)) {
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
      String(key).toLowerCase(), String(value),
    ]));
  }
  return {};
}

function responseStatus(response) {
  if (!response) return 0;
  try {
    if (typeof response.status === 'function') return Number(response.status()) || 0;
  } catch {}
  return Number(response.status || 0) || 0;
}

function responseHeaders(response) {
  if (!response) return {};
  try {
    if (typeof response.headers === 'function') return response.headers() || {};
  } catch {}
  return response.headers && typeof response.headers === 'object' ? response.headers : {};
}

function isProtectionText(value) {
  const text = String(value || '').toLowerCase();
  return PROTECTION_MARKERS.some((marker) => text.includes(String(marker).toLowerCase()));
}

function looksLikeHtml(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^<!doctype\s+html|^<html\b|<body\b|<script\b/.test(text)
    || isProtectionText(text);
}

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

function classifyQuestionResponse(result) {
  const response = result && typeof result === 'object' ? result : {};
  const status = Number(response.status || 0);
  const text = String(response.text ?? response.body ?? '');
  if (status === 401 || status === 403) {
    return { kind: 'verification', code: `http_${status}`, status, text };
  }
  if (status === 429) return { kind: 'retry', code: 'http_429', status, text, throttled: true };
  if (RETRYABLE_HTTP.has(status)) {
    return { kind: 'retry', code: `http_${status}`, status, text, throttled: false };
  }
  if (status >= 400) return { kind: 'fatal', code: `http_${status}`, status, text };
  if (looksLikeHtml(text)) return { kind: 'verification', code: 'json_html', status, text };
  return { kind: 'ok', code: 'ok', status, text };
}

async function evaluateFetch(page, url, request) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new QuestionSyncError('缺少可执行 fetch 的采集页面。', 'page_unavailable');
  }
  return page.evaluate(async ({ target, body, headers, credentials }) => {
    try {
      const response = await fetch(target, {
        method: 'POST',
        credentials,
        headers,
        body,
      });
      const text = await response.text();
      const responseHeaders = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      return { status: response.status, headers: responseHeaders, text };
    } catch (error) {
      return {
        status: 0,
        headers: {},
        text: '',
        networkError: String(error?.message || error),
      };
    }
  }, {
    target: url,
    body: request.body,
    headers: request.headers,
    credentials: request.credentials,
  });
}

async function bringVerificationPageToFront(page) {
  if (!page || typeof page.bringToFront !== 'function') return false;
  try {
    await page.bringToFront();
    return true;
  } catch {
    return false;
  }
}

async function waitForVerification(page, options = {}) {
  const timeoutValue = Number(options.verificationTimeout ?? DEFAULT_VERIFICATION_TIMEOUT);
  const timeout = Number.isFinite(timeoutValue) && timeoutValue >= 0
    ? timeoutValue : DEFAULT_VERIFICATION_TIMEOUT;
  const pollValue = Number(options.verificationPoll ?? DEFAULT_VERIFICATION_POLL);
  const poll = Math.max(100, Number.isFinite(pollValue) ? pollValue : DEFAULT_VERIFICATION_POLL);
  const requiresProbe = options.requireProbe === true;
  const probeValue = Number(options.verificationProbeInterval ?? DEFAULT_VERIFICATION_PROBE_INTERVAL);
  const probeInterval = Math.max(100, Number.isFinite(probeValue)
    ? probeValue : DEFAULT_VERIFICATION_PROBE_INTERVAL);
  const wait = options.sleepFn || sleep;
  const startedAt = Date.now();
  if (requiresProbe) {
    await bringVerificationPageToFront(page);
    let currentUrl = '';
    try { currentUrl = typeof page?.url === 'function' ? String(page.url()) : ''; } catch {}
    console.warn(
      `[验证] 题目 API 返回 ${options.verificationReason || '验证/防护'}，请在当前 Chrome 窗口人工恢复${currentUrl ? `（${currentUrl}）` : ''}；不会自动绕过滑块。`,
    );
  }
  const configuredInitialWait = Number(options.verificationInitialWait ?? poll);
  const initialWait = timeout === 0 ? 0 : Math.max(
    0,
    requiresProbe
      ? Math.max(configuredInitialWait, probeInterval)
      : configuredInitialWait,
  );
  if (initialWait > 0) {
    const remaining = Math.max(0, timeout - (Date.now() - startedAt));
    await wait(Math.min(initialWait, remaining));
  }
  let announced = false;
  while (true) {
    let state = { challenge: false, text: '', title: '' };
    if (page && typeof page.evaluate === 'function') {
      try {
        state = await page.evaluate(() => {
          const text = document.body?.innerText || '';
          const title = document.title || '';
          const combined = `${title}\n${text}`;
          return {
            challenge: Boolean(document.querySelector(
              '#parm_0, #parm_1, [class*="slider"], [class*="captcha"], [data-captcha="true"]',
            )) || /验证码|滑块|安全验证|请按住滑块|拖动滑块|challenge|captcha|access denied/i.test(combined),
            title,
            text: text.slice(0, 1000),
            url: location.href,
          };
        });
      } catch (error) {
        state = { challenge: true, text: error.message, title: '' };
      }
    }
    const challenge = Boolean(state?.challenge) || isProtectionText(`${state?.title || ''} ${state?.text || ''}`);
    if (!challenge) {
      if (requiresProbe) {
        console.warn('[验证] 当前页未显示挑战控件；将以间隔 API probe，恢复后继续同一目录/页。');
      }
      return state;
    }
    if (!announced) {
      console.warn('[验证] 检测到验证/防护页面，请在当前 Chrome 窗口人工完成验证；不会自动拖动滑块。');
      announced = true;
    }
    if (timeout >= 0 && Date.now() - startedAt >= timeout) {
      throw new VerificationRequiredError('人工验证等待超时，已保留当前浏览器档案和页码断点。', state);
    }
    const remaining = Math.max(0, timeout - (Date.now() - startedAt));
    await wait(Math.min(Math.max(100, poll), remaining));
  }
}

async function postQuestionList(page, options, catalog, pageNumber, { totalOnly = false } = {}) {
  const request = buildQuestionListRequest(options, catalog, pageNumber);
  const wait = options.sleepFn || sleep;
  let retryIndex = 0;
  let networkRetryIndex = 0;
  let verificationCycles = 0;
  let verificationStartedAt = null;
  while (true) {
    const result = await evaluateFetch(page, request.url, request);
    const classification = classifyQuestionResponse(result);
    if (classification.kind === 'verification') {
      verificationCycles += 1;
      const maxVerificationCycles = Number(options.maxVerificationCycles);
      if (Number.isFinite(maxVerificationCycles) && maxVerificationCycles >= 0
        && verificationCycles > maxVerificationCycles) {
        throw new VerificationRequiredError(
          `题目列表仍处于验证/防护状态，已等待 ${maxVerificationCycles} 次；请人工恢复后续跑同一页。`,
          classification,
        );
      }
      if (verificationStartedAt == null) verificationStartedAt = Date.now();
      const configuredTimeout = Number(options.verificationTimeout ?? DEFAULT_VERIFICATION_TIMEOUT);
      const elapsed = Date.now() - verificationStartedAt;
      const remainingTimeout = Math.max(0, configuredTimeout - elapsed);
      if (configuredTimeout >= 0 && remainingTimeout <= 0) {
        throw new VerificationRequiredError('人工验证等待超时，已保留当前浏览器档案和页码断点。', classification);
      }
      await waitForVerification(page, {
        ...options,
        requireProbe: true,
        verificationReason: classification.code,
        verificationTimeout: remainingTimeout,
      });
      // Verification is not counted as an API retry.  Once the operator has
      // restored the page, retry exactly this catalog/page request.
      continue;
    }
    if (classification.kind === 'retry') {
      if (retryIndex >= MAX_RETRIES) {
        throw new QuestionSyncError(
          `题目列表请求重试耗尽：HTTP ${classification.status}`,
          classification.code,
          classification,
        );
      }
      const delay = retryDelay(
        classification.throttled ? '429' : 'normal',
        retryIndex,
        result.headers,
        options.randomFn || Math.random,
      );
      retryIndex += 1;
      console.warn(`[重试] 目录 ${catalog?.externalId || ''} 第 ${pageNumber} 页 HTTP ${classification.status}，等待 ${(delay / 1000).toFixed(1)} 秒`);
      await wait(delay);
      continue;
    }
    if (classification.kind === 'fatal') {
      throw new QuestionSyncError(
        `题目列表请求失败：HTTP ${classification.status}`,
        classification.code,
        classification,
      );
    }
    if (result.networkError) {
      if (networkRetryIndex >= MAX_RETRIES) {
        throw new QuestionSyncError(`题目列表网络请求失败：${result.networkError}`, 'network_error', result);
      }
      const delay = retryDelay('normal', networkRetryIndex, {}, options.randomFn || Math.random);
      networkRetryIndex += 1;
      await wait(delay);
      continue;
    }
    try {
      const payload = result.payload
        || (result && result.code != null ? result : JSON.parse(String(result.text || '')));
      return totalOnly
        ? parseQuestionListTotalPayload(payload)
        : parseQuestionListPayload(payload, options.baseUrl || DEFAULT_BASE_URL);
    } catch (error) {
      if (error instanceof QuestionSyncError && error.code === 'list_api_contract') throw error;
      if (looksLikeHtml(result.text)) {
        if (verificationStartedAt == null) verificationStartedAt = Date.now();
        const configuredTimeout = Number(options.verificationTimeout ?? DEFAULT_VERIFICATION_TIMEOUT);
        const elapsed = Date.now() - verificationStartedAt;
        const remainingTimeout = Math.max(0, configuredTimeout - elapsed);
        await waitForVerification(page, {
          ...options,
          requireProbe: true,
          verificationReason: 'json_html',
          verificationTimeout: remainingTimeout,
        });
        continue;
      }
      throw new QuestionSyncError(
        `题目列表接口 JSON 解析失败：${error.message}`,
        'list_api_contract',
      );
    }
  }
}

async function postQuestionListTotal(page, options, catalog, pageNumber) {
  return postQuestionList(page, options, catalog, pageNumber, { totalOnly: true });
}

async function fetchCatalogTree(page, options) {
  const url = catalogTreeUrl(options);
  if (!page || typeof page.evaluate !== 'function') {
    throw new QuestionSyncError('缺少读取目录 JSON 的采集页面。', 'page_unavailable');
  }
  const result = await page.evaluate(async (target) => {
    try {
      const response = await fetch(target, { method: 'GET', credentials: 'omit', cache: 'no-store' });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      return { status: 0, text: '', networkError: String(error?.message || error) };
    }
  }, url);
  if (result && typeof result === 'object' && Array.isArray(result.children)) return result;
  if (Array.isArray(result)) return result;
  if (result?.networkError) {
    // static.zxxk.com may omit CORS headers on a particular edge.  The
    // browser context still represents the same real Chrome session, so use
    // its request client only as a safe same-session fallback for this public
    // static JSON (never for the question API).
    try {
      const context = typeof page.context === 'function' ? page.context() : null;
      if (context?.request?.get) {
        const response = await context.request.get(url, {
          timeout: options.timeout,
          failOnStatusCode: false,
        });
        const status = responseStatus(response);
        if (status < 400) return JSON.parse(await response.text());
      }
    } catch {}
    throw new QuestionSyncError(`目录请求失败：${result.networkError}`, 'tree_network_error');
  }
  if (Number(result?.status || 0) >= 400) {
    throw new QuestionSyncError(`目录请求返回 HTTP ${result.status}`, `tree_http_${result.status}`);
  }
  try {
    return JSON.parse(String(result?.text || ''));
  } catch (error) {
    throw new QuestionSyncError(`目录 JSON 解析失败：${error.message}`, 'tree_contract');
  }
}

async function navigateToTextbook(page, url, options) {
  if (!page || typeof page.goto !== 'function') throw new QuestionSyncError('缺少采集页面。', 'page_unavailable');
  let retryIndex = 0;
  let verificationStartedAt = null;
  const wait = options.sleepFn || sleep;
  while (true) {
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeout });
    } catch (error) {
      if (retryIndex >= MAX_RETRIES) throw new QuestionSyncError(`打开教材入口失败：${error.message}`, 'navigation_error');
      await wait(retryDelay('normal', retryIndex, {}, options.randomFn || Math.random));
      retryIndex += 1;
      continue;
    }
    const status = responseStatus(response);
    if (status === 401 || status === 403) {
      if (verificationStartedAt == null) verificationStartedAt = Date.now();
      const configuredTimeout = Number(options.verificationTimeout ?? DEFAULT_VERIFICATION_TIMEOUT);
      const remainingTimeout = Math.max(0, configuredTimeout - (Date.now() - verificationStartedAt));
      await waitForVerification(page, {
        ...options,
        requireProbe: true,
        verificationReason: `http_${status}`,
        verificationTimeout: remainingTimeout,
      });
      continue;
    }
    if (status === 429 || RETRYABLE_HTTP.has(status)) {
      if (retryIndex >= MAX_RETRIES) throw new QuestionSyncError(`教材入口 HTTP ${status} 重试耗尽。`, `http_${status}`);
      await wait(retryDelay(status === 429 ? '429' : 'normal', retryIndex, responseHeaders(response), options.randomFn || Math.random));
      retryIndex += 1;
      continue;
    }
    if (status >= 400) throw new QuestionSyncError(`教材入口 HTTP ${status}`, `http_${status}`);
    await waitForVerification(page, { ...options, verificationInitialWait: 0 });
    return response;
  }
}

function extensionForAsset(url, mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
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

const KNOWN_ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.jxl',
]);

function isSupportedAssetResponse(url, mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return true;
  let extension = '';
  try { extension = path.extname(new URL(url).pathname).toLowerCase(); } catch {}
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

function removeAssetImages(html, assetKeys = []) {
  const keys = new Set((Array.isArray(assetKeys) ? assetKeys : []).map(String).filter(Boolean));
  if (!keys.size) return html == null ? html : String(html);
  return String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const match = tag.match(/\bdata-asset-key\s*=\s*(?:(['"])([^'"]+)\1|([^\s>]+))/i);
    const key = match?.[2] || match?.[3] || '';
    return keys.has(key) ? '' : tag;
  });
}

function removeAssetImagesBySource(html, sourceUrls = []) {
  const urls = new Set((Array.isArray(sourceUrls) ? sourceUrls : [])
    .map((value) => String(value || '').trim()).filter(Boolean));
  if (!urls.size) return html == null ? html : String(html);
  return String(html || '').replace(
    /<img\b([^>]*?)\bsrc\s*=\s*(?:(['"])([\s\S]*?)\2|([^\s>]+))([^>]*)>/gi,
    (match, _before, _quote, quotedSource, bareSource, _after) => {
      const source = decodeHtmlEntities(quotedSource ?? bareSource ?? '').trim();
      return urls.has(source) ? '' : match;
    },
  );
}

function assertAllowedUrl(value, hosts) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new QuestionSyncError(`非法 URL：${value}`, 'host_not_allowed'); }
  if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname)) {
    throw new QuestionSyncError(`拒绝访问未授权域名：${parsed.href}`, 'host_not_allowed');
  }
  return parsed.href;
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
      try {
        const response = await context.request.get(requestUrl, {
        timeout: options.timeout,
        failOnStatusCode: false,
        });
        const status = responseStatus(response);
        const headers = responseHeaders(response);
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
        const body = Buffer.isBuffer(received) ? received : Buffer.from(received || []);
        if (body.length === 0) throw new QuestionSyncError('素材响应 body 为空。', 'asset_empty_body');
        if (body.length > MAX_ASSET_BYTES) {
          throw new QuestionSyncError(`素材超过 10MB：${requestUrl}`, 'asset_too_large');
        }
        return { body, mimeType, requestUrl };
      } catch (error) {
        const retryable = !['host_not_allowed', 'asset_too_large', 'asset_storage_error', 'asset_http_404'].includes(
          String(error?.code || ''),
        );
        if (!retryable || retryIndex >= MAX_RETRIES) throw error;
        const delay = retryDelay('normal', retryIndex, lastHeaders, options.randomFn || Math.random);
        console.warn(`[素材重试] ${requestUrl} 第 ${retryIndex + 1}/${MAX_RETRIES} 次，等待 ${(delay / 1000).toFixed(1)} 秒：${error.message}`);
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
          const probe = await context.request.get(fallbackUrl, {
            timeout: options.timeout,
            failOnStatusCode: false,
          });
          const probeBody = typeof probe?.body === 'function' ? await probe.body() : null;
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
        } catch {}
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

function acquireLock(lockPath) {
  ensureDir(path.dirname(lockPath));
  const open = () => {
    const descriptor = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(descriptor, `${process.pid}\n`);
    return descriptor;
  };
  let fd;
  try {
    fd = open();
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new QuestionSyncError(`无法创建题库同步锁：${lockPath}`, 'collector_locked', error);
    }
    // A SIGKILL can leave the tiny lock file behind.  Reuse is safe only
    // after checking the recorded PID is no longer alive; malformed locks
    // and live PIDs remain hard failures so two collectors cannot overlap.
    let pid = null;
    try { pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); } catch {}
    let stale = Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid;
    if (stale) {
      try {
        process.kill(pid, 0);
        stale = false;
      } catch (probeError) {
        stale = probeError?.code === 'ESRCH';
      }
    }
    if (!stale) {
      throw new QuestionSyncError(`已有题库同步正在运行：${lockPath}`, 'collector_locked', error);
    }
    try { fs.unlinkSync(lockPath); } catch (unlinkError) {
      throw new QuestionSyncError(`已有题库同步正在运行：${lockPath}`, 'collector_locked', unlinkError);
    }
    try {
      fd = open();
    } catch (retryError) {
      throw new QuestionSyncError(`已有题库同步正在运行：${lockPath}`, 'collector_locked', retryError);
    }
  }
  return () => {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  };
}

function ensureColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String(row.name)));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
}

function ensureCollectorSchema(db) {
  migrateRunSnapshotSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      scope_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      last_completed_page INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS textbook_nodes (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      textbook_external_id TEXT,
      parent_external_id TEXT,
      node_level INTEGER,
      node_type TEXT,
      name TEXT NOT NULL,
      source_path TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (provider, external_id)
    );
    CREATE TABLE IF NOT EXISTS questions (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      bank_id INTEGER,
      chapter_id TEXT,
      detail_url TEXT,
      source_short TEXT,
      source_title TEXT,
      source_url TEXT,
      question_type TEXT,
      question_type_id TEXT,
      difficulty_label TEXT,
      difficulty_code TEXT,
      ease_coefficient REAL,
      content_html TEXT,
      plain_text TEXT,
      content_hash TEXT,
      list_content_hash TEXT,
      detail_content_hash TEXT,
      detail_fetched INTEGER NOT NULL DEFAULT 0,
      subquestion_count INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER,
      has_image INTEGER NOT NULL DEFAULT 0,
      has_formula INTEGER NOT NULL DEFAULT 0,
      has_table INTEGER NOT NULL DEFAULT 0,
      is_new INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER,
      provider_updated_at TEXT,
      answer_html TEXT,
      analysis_html TEXT,
      answer_status TEXT NOT NULL DEFAULT 'not_collected',
      solution_html TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (provider, external_id)
    );
    CREATE TABLE IF NOT EXISTS question_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      data_json TEXT NOT NULL,
      UNIQUE(provider, question_external_id, content_hash)
    );
    CREATE TABLE IF NOT EXISTS question_knowledge (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      knowledge_external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      knowledge_kind TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(provider, question_external_id, knowledge_external_id, knowledge_kind)
    );
    CREATE TABLE IF NOT EXISTS question_catalog_memberships (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      catalog_level INTEGER,
      catalog_name TEXT,
      catalog_path TEXT,
      evidence_type TEXT NOT NULL,
      query_fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(provider, question_external_id, catalog_external_id, evidence_type, query_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS question_facets (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      value TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      query_fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(provider, question_external_id, dimension, value, evidence_type, query_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS question_assets (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      local_path TEXT,
      sha256 TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(provider, question_external_id, source_url)
    );
    CREATE TABLE IF NOT EXISTS catalog_list_stats (
      scope_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      chapter_id TEXT,
      filter_json TEXT NOT NULL,
      expected_total INTEGER,
      page_capacity INTEGER,
      expected_pages INTEGER,
      list_seen_count INTEGER NOT NULL DEFAULT 0,
      last_completed_page INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_progress (
      run_id INTEGER NOT NULL,
      worker_id INTEGER NOT NULL,
      catalog_external_id TEXT,
      catalog_name TEXT,
      catalog_path TEXT,
      current_page INTEGER,
      expected_pages INTEGER,
      expected_total INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, worker_id)
    );
    CREATE TABLE IF NOT EXISTS sync_run_catalog_progress (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      expected_total INTEGER,
      page_capacity INTEGER,
      expected_pages INTEGER,
      last_completed_page INTEGER NOT NULL DEFAULT 0,
      list_seen_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      observed_at TEXT NOT NULL,
      PRIMARY KEY(run_id, provider, textbook_external_id, catalog_external_id),
      FOREIGN KEY(run_id) REFERENCES sync_runs(id)
    );
    CREATE TABLE IF NOT EXISTS sync_run_catalog_pages (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      page_signature TEXT NOT NULL,
      question_count INTEGER NOT NULL DEFAULT 0,
      question_ids_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(run_id, provider, textbook_external_id, catalog_external_id, page_number),
      FOREIGN KEY(run_id) REFERENCES sync_runs(id)
    );
    CREATE TABLE IF NOT EXISTS source_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      snapshot_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_path TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_source_snapshots_run
      ON source_snapshots (run_id, captured_at);
    CREATE TABLE IF NOT EXISTS sync_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      source_url TEXT,
      stage TEXT NOT NULL,
      error_code TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_errors_run
      ON sync_errors (run_id, created_at);
  `);

  // Collector-only additive fields.  Existing formal/apply contracts keep
  // their original columns; these fields make list completeness explicit.
  const questionColumns = {
    content_source: "TEXT NOT NULL DEFAULT 'unknown'",
    content_complete: 'INTEGER NOT NULL DEFAULT 0',
    category_external_id: 'TEXT',
    category_name: 'TEXT',
    title_abbreviation: 'TEXT',
    website_time_text: 'TEXT',
    reference_count: 'INTEGER',
    reference_papers_json: 'TEXT',
    difficulty_qdid: 'TEXT',
  };
  const nodeColumns = {
    raw_json: "TEXT NOT NULL DEFAULT '{}'",
    category_id: 'TEXT',
    catelog_tokpoint_id: 'TEXT',
    is_knowledge: 'INTEGER NOT NULL DEFAULT 0',
    sort_order: 'INTEGER',
    catalog_path: 'TEXT',
  };
  for (const [column, definition] of Object.entries(questionColumns)) {
    ensureColumn(db, 'questions', column, definition);
    ensureColumn(db, 'sync_run_question_items', column, definition);
  }
  for (const [column, definition] of Object.entries(nodeColumns)) {
    ensureColumn(db, 'textbook_nodes', column, definition);
    ensureColumn(db, 'sync_run_catalog_items', column, definition);
  }
}

class QuestionSyncStore {
  constructor(dbPath, { dataDir = null } = {}) {
    ensureDir(path.dirname(path.resolve(dbPath)));
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.db = new DatabaseSync(path.resolve(dbPath));
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    ensureCollectorSchema(this.db);
    this.lastBeginMeta = null;
  }

  _scopeObject(scope) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return {};
    return scope;
  }

  _scopeIdentity(scope) {
    const value = this._scopeObject(scope);
    return JSON.stringify({
      provider: PROVIDER,
      bankId: String(value.bankId ?? DEFAULT_BANK_ID),
      bankPath: String(value.bankPath ?? DEFAULT_BANK_PATH),
      textbookId: String(value.textbookId ?? ''),
      catalogIds: [...(value.catalogIds || [])].map(String).sort(),
      catalogLevels: [...(value.catalogLevels || [])].map(Number).sort(),
      // These are operational bounds.  Omitting them lets an interrupted
      // probe run be resumed with larger max-catalogs/max-pages (or without
      // a row limit) while retaining the same formal textbook scope.
      downloadAssets: value.downloadAssets !== false,
      filters: value.filters || {},
    });
  }

  _latestRun(scope, statuses) {
    const rows = this.db.prepare(`
      SELECT * FROM sync_runs WHERE provider = ? ORDER BY id DESC LIMIT 50
    `).all(PROVIDER);
    const identity = this._scopeIdentity(scope);
    return rows.find((row) => {
      if (!statuses.includes(String(row.status || ''))) return false;
      try { return this._scopeIdentity(JSON.parse(row.scope_json || '{}')) === identity; } catch { return false; }
    }) || null;
  }

  _copyTableRows(table, sourceRunId, targetRunId) {
    const columns = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String(row.name));
    if (!columns.includes('run_id')) return 0;
    const copyColumns = columns.filter((column) => column !== 'run_id');
    const insertColumns = ['run_id', ...copyColumns].map(quoteIdentifier).join(', ');
    const selectColumns = ['?', ...copyColumns.map(quoteIdentifier)].join(', ');
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${insertColumns})
      SELECT ${selectColumns} FROM ${quoteIdentifier(table)} WHERE run_id = ?
    `).run(Number(targetRunId), Number(sourceRunId));
    return Number(result?.changes || 0);
  }

  beginRun(scope, { resume = true, resumeRunId = null } = {}) {
    const normalized = this._scopeObject(scope);
    const explicitResumeRunId = resumeRunId == null ? null : Number(resumeRunId);
    if (explicitResumeRunId != null) {
      const source = this.getRun(explicitResumeRunId);
      if (!source) throw new QuestionSyncError(`续采来源 run=${explicitResumeRunId} 不存在。`, 'resume_source_invalid');
      if (!source.snapshot_locked_at || Number(source.snapshot_complete || 0) === 1) {
        throw new QuestionSyncError(`续采来源 run=${explicitResumeRunId} 不是已封存的不完整运行。`, 'resume_source_invalid');
      }
      let sourceScope = {};
      try { sourceScope = JSON.parse(source.scope_json || '{}'); } catch {}
      if (this._scopeIdentity(sourceScope) !== this._scopeIdentity(normalized)) {
        throw new QuestionSyncError(`续采来源 run=${explicitResumeRunId} 与当前教材范围不匹配。`, 'resume_source_invalid');
      }
    }
    if (resume && explicitResumeRunId == null) {
      const running = this._latestRun(normalized, ['running']);
      if (running) {
        this.lastBeginMeta = { runId: Number(running.id), reused: true, clonedFrom: null };
        return Number(running.id);
      }
    }
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.db.prepare(`
        INSERT INTO sync_runs (provider, started_at, status, scope_json)
        VALUES (?, ?, 'running', ?)
      `).run(PROVIDER, nowIso(), jsonStringify(normalized));
      const runId = Number(result.lastInsertRowid);
      let clonedFrom = null;
      if (resume) {
        const source = explicitResumeRunId == null
          ? this._latestRun(normalized, ['interrupted', 'blocked', 'failed'])
          : this.getRun(explicitResumeRunId);
        if (source && Number(source.snapshot_complete || 0) !== 1) {
          const sourceId = Number(source.id);
          for (const table of [
            'sync_run_catalog_items',
            'sync_run_question_items',
            'sync_run_question_catalogs',
            'sync_run_question_tags',
            'sync_run_question_assets',
            'sync_run_checkpoints',
            'sync_run_catalog_progress',
            'sync_run_catalog_pages',
          ]) this._copyTableRows(table, sourceId, runId);
          clonedFrom = sourceId;
          this.db.prepare('UPDATE sync_runs SET message = ? WHERE id = ?')
            .run(`续采来源 run=${sourceId}`, runId);
        }
      }
      this.db.exec('COMMIT;');
      this.lastBeginMeta = { runId, reused: false, clonedFrom };
      return runId;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(Number(runId)) || null;
  }

  updateRunScope(runId, scope) {
    this.db.prepare('UPDATE sync_runs SET scope_json = ? WHERE id = ? AND status = \'running\'')
      .run(jsonStringify(scope), Number(runId));
  }

  _insertCatalogNode(node, observedAt) {
    const externalId = normalizeId(node.externalId);
    if (!externalId || !node.name) return;
    this.db.prepare(`
      INSERT INTO textbook_nodes (
        provider, external_id, textbook_external_id, parent_external_id,
        node_level, node_type, name, source_path,
        first_seen_at, last_seen_at, raw_json, category_id,
        catelog_tokpoint_id, is_knowledge, sort_order, catalog_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_id) DO UPDATE SET
        textbook_external_id = excluded.textbook_external_id,
        parent_external_id = excluded.parent_external_id,
        node_level = excluded.node_level,
        node_type = excluded.node_type,
        name = excluded.name,
        source_path = excluded.source_path,
        last_seen_at = excluded.last_seen_at,
        raw_json = excluded.raw_json,
        category_id = excluded.category_id,
        catelog_tokpoint_id = excluded.catelog_tokpoint_id,
        is_knowledge = excluded.is_knowledge,
        sort_order = excluded.sort_order,
        catalog_path = excluded.catalog_path
    `).run(
      PROVIDER,
      externalId,
      sqliteValue(node.textbookExternalId),
      sqliteValue(node.parentExternalId),
      sqliteValue(node.level),
      sqliteValue(node.type || node.nodeType),
      String(node.name),
      sqliteValue(node.sourcePath),
      observedAt,
      observedAt,
      jsonStringify(node.raw || node),
      sqliteValue(node.categoryId),
      sqliteValue(node.catelogTokpointId),
      node.isKnowledge ? 1 : 0,
      sqliteValue(node.sortOrder),
      sqliteValue(node.path || node.name),
    );
  }

  saveCatalogTree(runId, textbookId, nodes, observedAt = nowIso()) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const node of nodes || []) {
        const externalId = normalizeId(node.externalId);
        if (!externalId || !node.name) continue;
        this._insertCatalogNode(node, observedAt);
        this.db.prepare(`
          INSERT INTO sync_run_catalog_items (
            run_id, provider, textbook_external_id, catalog_external_id,
            parent_external_id, node_level, node_type, name, source_path,
            catalog_path, sort_order, captured_at, raw_json, category_id,
            catelog_tokpoint_id, is_knowledge
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id)
          DO UPDATE SET
            parent_external_id = excluded.parent_external_id,
            node_level = excluded.node_level,
            node_type = excluded.node_type,
            name = excluded.name,
            source_path = excluded.source_path,
            catalog_path = excluded.catalog_path,
            sort_order = excluded.sort_order,
            raw_json = excluded.raw_json,
            category_id = excluded.category_id,
            catelog_tokpoint_id = excluded.catelog_tokpoint_id,
            is_knowledge = excluded.is_knowledge,
            captured_at = excluded.captured_at
        `).run(
          Number(runId), PROVIDER, String(textbookId), externalId,
          sqliteValue(node.parentExternalId), sqliteValue(node.level),
          sqliteValue(node.type || node.nodeType), String(node.name),
          sqliteValue(node.sourcePath), sqliteValue(node.path || node.name),
          sqliteValue(node.sortOrder), observedAt, jsonStringify(node.raw || node),
          sqliteValue(node.categoryId), sqliteValue(node.catelogTokpointId),
          node.isKnowledge ? 1 : 0,
        );
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  getQuestion(externalId) {
    return this.db.prepare('SELECT * FROM questions WHERE provider = ? AND external_id = ?')
      .get(PROVIDER, String(externalId)) || null;
  }

  getRunCheckpoint(runId, scopeKey) {
    const row = this.db.prepare(`
      SELECT last_completed_page FROM sync_run_checkpoints
      WHERE run_id = ? AND provider = ? AND scope_key = ?
    `).get(Number(runId), PROVIDER, String(scopeKey));
    return Number(row?.last_completed_page || 0);
  }

  getCheckpoint(scopeKey) {
    const row = this.db.prepare('SELECT last_completed_page FROM sync_checkpoints WHERE scope_key = ?')
      .get(String(scopeKey));
    return Number(row?.last_completed_page || 0);
  }

  getRunPageSignatures(runId, catalogId) {
    return this.db.prepare(`
      SELECT page_number, page_signature, question_count, question_ids_json
      FROM sync_run_catalog_pages
      WHERE run_id = ? AND provider = ? AND catalog_external_id = ?
      ORDER BY page_number ASC
    `).all(Number(runId), PROVIDER, String(catalogId)).map((row) => ({
      pageNumber: Number(row.page_number),
      signature: String(row.page_signature),
      questionCount: Number(row.question_count || 0),
      questionIds: (() => {
        try { return JSON.parse(row.question_ids_json || '[]').map(String); } catch { return []; }
      })(),
    }));
  }

  getRunCatalogProgress(runId, textbookId, catalogId) {
    const row = this.db.prepare(`
      SELECT expected_total, page_capacity, expected_pages, last_completed_page,
        list_seen_count, status
      FROM sync_run_catalog_progress
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ?
    `).get(Number(runId), PROVIDER, String(textbookId), String(catalogId));
    if (!row) return null;
    return {
      expectedTotal: row.expected_total == null ? null : Number(row.expected_total),
      pageCapacity: row.page_capacity == null ? null : Number(row.page_capacity),
      expectedPages: row.expected_pages == null ? null : Number(row.expected_pages),
      lastCompletedPage: Number(row.last_completed_page || 0),
      listSeenCount: Number(row.list_seen_count || 0),
      status: String(row.status || ''),
    };
  }

  _saveGlobalQuestion(item, chapterId, observedAt) {
    const rawJson = jsonStringify(item);
    const externalId = String(item.externalId);
    const before = this.getQuestion(externalId);
    this.db.prepare(`
      INSERT INTO questions (
        provider, external_id, bank_id, chapter_id, detail_url,
        source_short, source_title, source_url, question_type, question_type_id,
        difficulty_label, difficulty_code, difficulty_qdid, ease_coefficient,
        content_html, plain_text, content_hash, list_content_hash,
        detail_content_hash, detail_fetched, content_source, content_complete,
        subquestion_count, child_count, has_image, has_formula, has_table,
        is_new, use_count, provider_updated_at, website_time_text,
        category_external_id, category_name, title_abbreviation,
        reference_count, reference_papers_json, answer_html, analysis_html,
        answer_status, solution_html, first_seen_at, last_seen_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_id) DO UPDATE SET
        bank_id = COALESCE(excluded.bank_id, questions.bank_id),
        chapter_id = COALESCE(excluded.chapter_id, questions.chapter_id),
        detail_url = COALESCE(excluded.detail_url, questions.detail_url),
        source_short = COALESCE(excluded.source_short, questions.source_short),
        source_title = COALESCE(excluded.source_title, questions.source_title),
        source_url = COALESCE(excluded.source_url, questions.source_url),
        question_type = COALESCE(excluded.question_type, questions.question_type),
        question_type_id = COALESCE(excluded.question_type_id, questions.question_type_id),
        difficulty_label = COALESCE(excluded.difficulty_label, questions.difficulty_label),
        difficulty_code = COALESCE(excluded.difficulty_code, questions.difficulty_code),
        difficulty_qdid = COALESCE(excluded.difficulty_qdid, questions.difficulty_qdid),
        ease_coefficient = COALESCE(excluded.ease_coefficient, questions.ease_coefficient),
        content_html = CASE WHEN questions.detail_fetched = 0 THEN excluded.content_html ELSE questions.content_html END,
        plain_text = CASE WHEN questions.detail_fetched = 0 THEN excluded.plain_text ELSE questions.plain_text END,
        content_hash = CASE WHEN questions.detail_fetched = 0 THEN excluded.content_hash ELSE questions.content_hash END,
        list_content_hash = excluded.list_content_hash,
        content_source = excluded.content_source,
        content_complete = MAX(questions.content_complete, excluded.content_complete),
        subquestion_count = CASE WHEN questions.detail_fetched = 0 THEN excluded.subquestion_count ELSE questions.subquestion_count END,
        child_count = COALESCE(excluded.child_count, questions.child_count),
        has_image = CASE WHEN questions.detail_fetched = 0 THEN excluded.has_image ELSE questions.has_image END,
        has_formula = CASE WHEN questions.detail_fetched = 0 THEN excluded.has_formula ELSE questions.has_formula END,
        has_table = CASE WHEN questions.detail_fetched = 0 THEN excluded.has_table ELSE questions.has_table END,
        is_new = excluded.is_new,
        use_count = COALESCE(excluded.use_count, questions.use_count),
        provider_updated_at = COALESCE(excluded.provider_updated_at, questions.provider_updated_at),
        website_time_text = COALESCE(excluded.website_time_text, questions.website_time_text),
        category_external_id = COALESCE(excluded.category_external_id, questions.category_external_id),
        category_name = COALESCE(excluded.category_name, questions.category_name),
        title_abbreviation = COALESCE(excluded.title_abbreviation, questions.title_abbreviation),
        reference_count = COALESCE(excluded.reference_count, questions.reference_count),
        reference_papers_json = COALESCE(excluded.reference_papers_json, questions.reference_papers_json),
        last_seen_at = excluded.last_seen_at,
        raw_json = CASE WHEN questions.detail_fetched = 0 THEN excluded.raw_json ELSE questions.raw_json END
    `).run(
      PROVIDER, externalId, sqliteValue(item.bankId), sqliteValue(chapterId),
      sqliteValue(item.detailUrl), sqliteValue(item.sourceShort), sqliteValue(item.sourceTitle),
      sqliteValue(item.sourceUrl), sqliteValue(item.questionType), sqliteValue(item.questionTypeId),
      sqliteValue(item.difficultyLabel), sqliteValue(item.difficultyCode), sqliteValue(item.difficultyQdid),
      sqliteValue(item.easeCoefficient), sqliteValue(item.contentHtml), sqliteValue(item.plainText),
      sqliteValue(item.contentHash), sqliteValue(item.listContentHash), sqliteValue(item.detailContentHash),
      0, sqliteValue(item.contentSource, 'list_api'), item.contentComplete ? 1 : 0,
      Number(item.subquestionCount) || 0, sqliteValue(item.childCount), item.hasImage ? 1 : 0,
      item.hasFormula ? 1 : 0, item.hasTable ? 1 : 0, item.isNew ? 1 : 0,
      sqliteValue(item.useCount), sqliteValue(item.providerUpdatedAt), sqliteValue(item.websiteTimeText),
      sqliteValue(item.providerCategoryId), sqliteValue(item.providerCategoryName),
      sqliteValue(item.titleAbbreviation), sqliteValue(item.referenceCount),
      jsonStringify(item.referencePapers || [], '[]'), null, null, 'not_collected', null,
      observedAt, observedAt, rawJson,
    );
    if (item.contentHash) {
      this.db.prepare(`
        INSERT OR IGNORE INTO question_revisions
          (provider, question_external_id, content_hash, captured_at, data_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(PROVIDER, externalId, item.contentHash, observedAt, rawJson);
    }
    return before;
  }

  _saveRunQuestion(runId, textbookId, item, chapterId, observedAt) {
    this.db.prepare(`
      INSERT INTO sync_run_question_items (
        run_id, provider, textbook_external_id, question_external_id,
        chapter_id, detail_url, source_short, source_title, source_url,
        question_type, question_type_id, difficulty_label, difficulty_code,
        difficulty_qdid, ease_coefficient, content_html, plain_text,
        content_hash, list_content_hash, detail_content_hash, content_version,
        question_version, snapshot_version, detail_fetched, content_source,
        content_complete, subquestion_count, child_count, has_image,
        has_formula, has_table, is_new, use_count, provider_updated_at,
        website_time_text, category_external_id, category_name,
        title_abbreviation, reference_count, reference_papers_json,
        answer_html, analysis_html, answer_status, solution_html, raw_json,
        captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, textbook_external_id, question_external_id)
      DO UPDATE SET
        chapter_id = COALESCE(excluded.chapter_id, sync_run_question_items.chapter_id),
        detail_url = COALESCE(excluded.detail_url, sync_run_question_items.detail_url),
        source_short = COALESCE(excluded.source_short, sync_run_question_items.source_short),
        source_title = COALESCE(excluded.source_title, sync_run_question_items.source_title),
        source_url = COALESCE(excluded.source_url, sync_run_question_items.source_url),
        question_type = COALESCE(excluded.question_type, sync_run_question_items.question_type),
        question_type_id = COALESCE(excluded.question_type_id, sync_run_question_items.question_type_id),
        difficulty_label = COALESCE(excluded.difficulty_label, sync_run_question_items.difficulty_label),
        difficulty_code = COALESCE(excluded.difficulty_code, sync_run_question_items.difficulty_code),
        difficulty_qdid = COALESCE(excluded.difficulty_qdid, sync_run_question_items.difficulty_qdid),
        ease_coefficient = COALESCE(excluded.ease_coefficient, sync_run_question_items.ease_coefficient),
        content_html = COALESCE(excluded.content_html, sync_run_question_items.content_html),
        plain_text = COALESCE(excluded.plain_text, sync_run_question_items.plain_text),
        content_hash = COALESCE(excluded.content_hash, sync_run_question_items.content_hash),
        list_content_hash = COALESCE(excluded.list_content_hash, sync_run_question_items.list_content_hash),
        content_source = COALESCE(excluded.content_source, sync_run_question_items.content_source),
        content_complete = MAX(sync_run_question_items.content_complete, excluded.content_complete),
        subquestion_count = excluded.subquestion_count,
        child_count = COALESCE(excluded.child_count, sync_run_question_items.child_count),
        has_image = excluded.has_image,
        has_formula = excluded.has_formula,
        has_table = excluded.has_table,
        is_new = excluded.is_new,
        use_count = COALESCE(excluded.use_count, sync_run_question_items.use_count),
        provider_updated_at = COALESCE(excluded.provider_updated_at, sync_run_question_items.provider_updated_at),
        website_time_text = COALESCE(excluded.website_time_text, sync_run_question_items.website_time_text),
        category_external_id = COALESCE(excluded.category_external_id, sync_run_question_items.category_external_id),
        category_name = COALESCE(excluded.category_name, sync_run_question_items.category_name),
        title_abbreviation = COALESCE(excluded.title_abbreviation, sync_run_question_items.title_abbreviation),
        reference_count = COALESCE(excluded.reference_count, sync_run_question_items.reference_count),
        reference_papers_json = COALESCE(excluded.reference_papers_json, sync_run_question_items.reference_papers_json),
        raw_json = excluded.raw_json,
        captured_at = excluded.captured_at
    `).run(
      Number(runId), PROVIDER, String(textbookId), String(item.externalId),
      sqliteValue(chapterId), sqliteValue(item.detailUrl), sqliteValue(item.sourceShort),
      sqliteValue(item.sourceTitle), sqliteValue(item.sourceUrl), sqliteValue(item.questionType),
      sqliteValue(item.questionTypeId), sqliteValue(item.difficultyLabel), sqliteValue(item.difficultyCode),
      sqliteValue(item.difficultyQdid), sqliteValue(item.easeCoefficient), sqliteValue(item.contentHtml),
      sqliteValue(item.plainText), sqliteValue(item.contentHash), sqliteValue(item.listContentHash),
      sqliteValue(item.detailContentHash), sqliteValue(item.contentHash || item.listContentHash),
      sqliteValue(item.contentSource, 'list_api'), item.contentComplete ? 1 : 0,
      Number(item.subquestionCount) || 0, sqliteValue(item.childCount), item.hasImage ? 1 : 0,
      item.hasFormula ? 1 : 0, item.hasTable ? 1 : 0, item.isNew ? 1 : 0,
      sqliteValue(item.useCount), sqliteValue(item.providerUpdatedAt), sqliteValue(item.websiteTimeText),
      sqliteValue(item.providerCategoryId), sqliteValue(item.providerCategoryName),
      sqliteValue(item.titleAbbreviation), sqliteValue(item.referenceCount),
      jsonStringify(item.referencePapers || [], '[]'), null, null, 'not_collected', null,
      jsonStringify(item), observedAt,
    );
  }

  _saveTag(runId, textbookId, questionId, tag, queryFingerprint, observedAt) {
    const dimension = String(tag.dimension || tag.kind || 'provider_tag');
    const value = String(tag.tagValue ?? tag.value ?? tag.name ?? '').trim();
    if (!value) return;
    const externalId = String(tag.tagExternalId ?? tag.externalId ?? '').trim();
    const relationType = String(tag.relationType || 'provider_asserted');
    const evidenceType = String(tag.evidenceType || 'provider_asserted');
    if (dimension === 'knowledge' || dimension === 'ability') {
      this.db.prepare(`
        INSERT INTO question_knowledge (
          provider, question_external_id, knowledge_external_id, name,
          knowledge_kind, evidence_type, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, question_external_id, knowledge_external_id, knowledge_kind)
        DO UPDATE SET name = excluded.name,
          evidence_type = excluded.evidence_type,
          observed_at = excluded.observed_at
      `).run(
        PROVIDER, String(questionId), externalId || value, value,
        dimension === 'ability' ? 'ability' : 'knowledge_point', evidenceType, observedAt,
      );
    }
    this.db.prepare(`
      INSERT INTO question_facets (
        provider, question_external_id, dimension, value,
        evidence_type, query_fingerprint, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, question_external_id, dimension, value, evidence_type, query_fingerprint)
      DO UPDATE SET observed_at = excluded.observed_at
    `).run(PROVIDER, String(questionId), dimension, value, evidenceType, queryFingerprint, observedAt);
    this.db.prepare(`
      INSERT INTO sync_run_question_tags (
        run_id, provider, textbook_external_id, question_external_id,
        dimension, tag_external_id, tag_value, relation_type,
        evidence_type, query_fingerprint, captured_at, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        run_id, provider, textbook_external_id, question_external_id,
        dimension, tag_external_id, tag_value, relation_type,
        evidence_type, query_fingerprint
      ) DO UPDATE SET observed_at = excluded.observed_at
    `).run(
      Number(runId), PROVIDER, String(textbookId), String(questionId),
      dimension, externalId, value, relationType, evidenceType,
      queryFingerprint, observedAt, observedAt,
    );
  }

  _saveAsset(runId, textbookId, questionId, asset, observedAt) {
    if (asset?.skipped || asset?.ignored) return;
    const sourceUrl = String(asset.sourceUrl || asset.url || '').trim();
    if (!sourceUrl) return;
    const assetType = normalizeAssetType(sourceUrl, asset.assetType || asset.type);
    const key = canonicalAssetKey(assetType, sourceUrl);
    const storagePath = asset.storagePath || asset.localPath || null;
    this.db.prepare(`
      INSERT INTO question_assets (
        provider, question_external_id, source_url, asset_type,
        local_path, sha256, mime_type, byte_size, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, question_external_id, source_url) DO UPDATE SET
        asset_type = excluded.asset_type,
        local_path = COALESCE(excluded.local_path, question_assets.local_path),
        sha256 = COALESCE(excluded.sha256, question_assets.sha256),
        mime_type = COALESCE(excluded.mime_type, question_assets.mime_type),
        byte_size = COALESCE(excluded.byte_size, question_assets.byte_size),
        observed_at = excluded.observed_at
    `).run(
      PROVIDER, String(questionId), sourceUrl, assetType, storagePath,
      sqliteValue(asset.contentSha256 || asset.sha256), sqliteValue(asset.mimeType),
      sqliteValue(asset.byteSize), observedAt,
    );
    this.db.prepare(`
      INSERT INTO sync_run_question_assets (
        run_id, provider, textbook_external_id, question_external_id,
        asset_key, asset_type, source_url, content_sha256, storage_path,
        mime_type, byte_size, captured_at, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, textbook_external_id, question_external_id, asset_key)
      DO UPDATE SET
        asset_type = excluded.asset_type,
        source_url = excluded.source_url,
        content_sha256 = COALESCE(excluded.content_sha256, sync_run_question_assets.content_sha256),
        storage_path = COALESCE(excluded.storage_path, sync_run_question_assets.storage_path),
        mime_type = COALESCE(excluded.mime_type, sync_run_question_assets.mime_type),
        byte_size = COALESCE(excluded.byte_size, sync_run_question_assets.byte_size),
        observed_at = excluded.observed_at
    `).run(
      Number(runId), PROVIDER, String(textbookId), String(questionId), key,
      assetType, sourceUrl, sqliteValue(asset.contentSha256 || asset.sha256),
      sqliteValue(storagePath), sqliteValue(asset.mimeType), sqliteValue(asset.byteSize),
      observedAt, observedAt,
    );
  }

  _saveMembership(runId, textbookId, questionId, membership, queryFingerprint, observedAt) {
    const catalogId = normalizeId(membership.externalId);
    if (!catalogId) return;
    this.db.prepare(`
      INSERT INTO question_catalog_memberships (
        provider, question_external_id, catalog_external_id,
        catalog_level, catalog_name, catalog_path,
        evidence_type, query_fingerprint, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, question_external_id, catalog_external_id, evidence_type, query_fingerprint)
      DO UPDATE SET catalog_level = excluded.catalog_level,
        catalog_name = excluded.catalog_name,
        catalog_path = excluded.catalog_path,
        observed_at = excluded.observed_at
    `).run(
      PROVIDER, String(questionId), catalogId, sqliteValue(membership.level),
      sqliteValue(membership.name), sqliteValue(membership.path || membership.name),
      'query_membership', queryFingerprint, observedAt,
    );
    this.db.prepare(`
      INSERT INTO sync_run_question_catalogs (
        run_id, provider, textbook_external_id, question_external_id,
        catalog_external_id, catalog_level, catalog_name, catalog_path,
        evidence_type, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, textbook_external_id, question_external_id, catalog_external_id)
      DO UPDATE SET catalog_level = excluded.catalog_level,
        catalog_name = excluded.catalog_name,
        catalog_path = excluded.catalog_path,
        captured_at = excluded.captured_at
    `).run(
      Number(runId), PROVIDER, String(textbookId), String(questionId), catalogId,
      sqliteValue(membership.level), sqliteValue(membership.name),
      sqliteValue(membership.path || membership.name), 'query_membership', observedAt,
    );
  }

  savePage({
    runId,
    textbookExternalId,
    catalog,
    nodes = [],
    pageNumber,
    expectedTotal,
    pageCapacity = 10,
    expectedPages,
    questions = [],
    queryFingerprint,
    filterJson = '{}',
    rawSnapshot = null,
  }) {
    const observedAt = nowIso();
    const normalizedCatalog = catalog || {};
    const normalizedScopeKey = String(queryFingerprint || '').trim();
    if (!normalizedScopeKey) throw new QuestionSyncError('页面缺少 queryFingerprint。', 'checkpoint_contract');
    const normalizedQuestions = questions.map(finalizeQuestion).filter((item) => item.externalId);
    const nodeById = new Map((nodes || []).map((node) => [String(node.externalId), node]));
    const memberships = [];
    const chain = Array.isArray(normalizedCatalog.ancestorIds)
      ? normalizedCatalog.ancestorIds
      : [normalizedCatalog.externalId];
    for (const id of chain) {
      const node = nodeById.get(String(id)) || (String(id) === String(normalizedCatalog.externalId) ? normalizedCatalog : null);
      if (node?.externalId) memberships.push(node);
    }
    let inserted = 0;
    let updated = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // Tests/direct callers may provide nodes only to savePage; normal runs
      // save the tree once before paging, so this is idempotent.
      for (const node of nodes || []) {
        if (node?.externalId && node?.name) {
          this._insertCatalogNode(node, observedAt);
          this.db.prepare(`
            INSERT INTO sync_run_catalog_items (
              run_id, provider, textbook_external_id, catalog_external_id,
              parent_external_id, node_level, node_type, name, source_path,
              catalog_path, sort_order, captured_at, raw_json, category_id,
              catelog_tokpoint_id, is_knowledge
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id)
            DO NOTHING
          `).run(
            Number(runId), PROVIDER, String(textbookExternalId), String(node.externalId),
            sqliteValue(node.parentExternalId), sqliteValue(node.level),
            sqliteValue(node.type || node.nodeType), String(node.name), sqliteValue(node.sourcePath),
            sqliteValue(node.path || node.name), sqliteValue(node.sortOrder), observedAt,
            jsonStringify(node.raw || node), sqliteValue(node.categoryId),
            sqliteValue(node.catelogTokpointId), node.isKnowledge ? 1 : 0,
          );
        }
      }
      for (const question of normalizedQuestions) {
        const before = this._saveGlobalQuestion(question, normalizedCatalog.chapterExternalId || normalizedCatalog.externalId, observedAt);
        if (!before) inserted += 1;
        else if (before.list_content_hash !== question.listContentHash) updated += 1;
        this._saveRunQuestion(
          runId,
          textbookExternalId,
          question,
          normalizedCatalog.chapterExternalId || normalizedCatalog.externalId,
          observedAt,
        );
        for (const membership of memberships) {
          this._saveMembership(runId, textbookExternalId, question.externalId, membership, normalizedScopeKey, observedAt);
        }
        const tags = [
          ...(question.providerLabels || []),
          ...(question.knowledge || []).map((entry) => ({
            dimension: entry.kind === 'ability' ? 'ability' : 'knowledge',
            tagExternalId: entry.externalId,
            tagValue: entry.name,
            relationType: entry.kind,
            evidenceType: entry.evidenceType || 'provider_asserted',
          })),
        ];
        if (question.providerCategoryId || question.providerCategoryName) {
          tags.push({
            dimension: 'provider_category',
            tagExternalId: question.providerCategoryId,
            tagValue: question.providerCategoryName || question.providerCategoryId,
            relationType: 'provider_category',
            evidenceType: 'provider_asserted',
          });
        }
        for (const tag of tags) this._saveTag(runId, textbookExternalId, question.externalId, tag, normalizedScopeKey, observedAt);
        for (const asset of question.assets || []) this._saveAsset(runId, textbookExternalId, question.externalId, asset, observedAt);
        void before;
      }

      const ids = normalizedQuestions.map((question) => String(question.externalId));
      const pageSignature = sha256(ids.join(','));
      this.db.prepare(`
        INSERT INTO sync_run_catalog_pages (
          run_id, provider, textbook_external_id, catalog_external_id,
          page_number, page_signature, question_count, question_ids_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id, page_number)
        DO UPDATE SET page_signature = excluded.page_signature,
          question_count = excluded.question_count,
          question_ids_json = excluded.question_ids_json,
          observed_at = excluded.observed_at
      `).run(
        Number(runId), PROVIDER, String(textbookExternalId), String(normalizedCatalog.externalId),
        Number(pageNumber), pageSignature, ids.length, jsonStringify(ids, '[]'), observedAt,
      );
      // Recompute the occurrence count from the idempotent page snapshot.
      // Retrying a page, or cloning a completed page during resume, must not
      // add the same page to list_seen_count a second time.
      const occurrenceCount = Number(this.db.prepare(`
        SELECT COALESCE(SUM(question_count), 0) AS n
        FROM sync_run_catalog_pages
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
          AND catalog_external_id = ?
      `).get(
        Number(runId), PROVIDER, String(textbookExternalId), String(normalizedCatalog.externalId),
      )?.n || 0);
      const completeStatus = Number(expectedPages || 0) > 0
        && Number(pageNumber) >= Number(expectedPages);
      this.db.prepare(`
        INSERT INTO sync_run_catalog_progress (
          run_id, provider, textbook_external_id, catalog_external_id,
          expected_total, page_capacity, expected_pages, last_completed_page,
          list_seen_count, status, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id)
        DO UPDATE SET
          expected_total = COALESCE(excluded.expected_total, sync_run_catalog_progress.expected_total),
          page_capacity = COALESCE(excluded.page_capacity, sync_run_catalog_progress.page_capacity),
          expected_pages = COALESCE(excluded.expected_pages, sync_run_catalog_progress.expected_pages),
          last_completed_page = MAX(sync_run_catalog_progress.last_completed_page, excluded.last_completed_page),
          list_seen_count = excluded.list_seen_count,
          status = CASE
            WHEN sync_run_catalog_progress.status = 'completed'
              OR excluded.status = 'completed' THEN 'completed'
            ELSE excluded.status
          END,
          observed_at = excluded.observed_at
      `).run(
        Number(runId), PROVIDER, String(textbookExternalId), String(normalizedCatalog.externalId),
        expectedTotal == null ? null : Number(expectedTotal), Number(pageCapacity) || 10,
        expectedPages == null ? null : Number(expectedPages), Number(pageNumber), occurrenceCount,
        completeStatus ? 'completed' : 'running', observedAt,
      );
      this.db.prepare(`
        INSERT INTO sync_checkpoints (
          scope_key, provider, chapter_id, filter_json, last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET last_completed_page = MAX(
          sync_checkpoints.last_completed_page, excluded.last_completed_page
        ), updated_at = excluded.updated_at
      `).run(
        normalizedScopeKey, PROVIDER,
        String(normalizedCatalog.chapterExternalId || normalizedCatalog.externalId),
        String(filterJson || '{}'), Number(pageNumber), observedAt,
      );
      this.db.prepare(`
        INSERT INTO sync_run_checkpoints (
          run_id, scope_key, provider, chapter_id, filter_json,
          last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, scope_key) DO UPDATE SET
          last_completed_page = MAX(sync_run_checkpoints.last_completed_page, excluded.last_completed_page),
          updated_at = excluded.updated_at
      `).run(
        Number(runId), normalizedScopeKey, PROVIDER,
        String(normalizedCatalog.chapterExternalId || normalizedCatalog.externalId),
        String(filterJson || '{}'), Number(pageNumber), observedAt,
      );
      this.db.prepare(`
        INSERT INTO catalog_list_stats (
          scope_key, provider, catalog_external_id, chapter_id, filter_json,
          expected_total, page_capacity, expected_pages, list_seen_count,
          last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          expected_total = COALESCE(excluded.expected_total, catalog_list_stats.expected_total),
          page_capacity = COALESCE(excluded.page_capacity, catalog_list_stats.page_capacity),
          expected_pages = COALESCE(excluded.expected_pages, catalog_list_stats.expected_pages),
          last_completed_page = MAX(catalog_list_stats.last_completed_page, excluded.last_completed_page),
          list_seen_count = excluded.list_seen_count,
          updated_at = excluded.updated_at
      `).run(
        normalizedScopeKey, PROVIDER, String(normalizedCatalog.externalId),
        String(normalizedCatalog.chapterExternalId || normalizedCatalog.externalId),
        String(filterJson || '{}'), expectedTotal == null ? null : Number(expectedTotal),
        Number(pageCapacity) || 10, expectedPages == null ? null : Number(expectedPages),
        occurrenceCount, Number(pageNumber), observedAt,
      );
      if (rawSnapshot?.filePath && rawSnapshot?.sourceUrl) {
        this.db.prepare(`
          INSERT INTO source_snapshots (
            run_id, snapshot_type, source_url, content_hash, file_path, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          Number(runId), 'question_list_api', String(rawSnapshot.sourceUrl),
          String(rawSnapshot.contentHash || ''), String(rawSnapshot.filePath), observedAt,
        );
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
    return {
      questionCount: normalizedQuestions.length,
      inserted,
      updated,
      pageSignature: sha256(normalizedQuestions.map((question) => String(question.externalId)).join(',')),
    };
  }

  recordError(runId, stage, error, sourceUrl = null) {
    this.db.prepare(`
      INSERT INTO sync_errors (run_id, source_url, stage, error_code, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      Number(runId), sourceUrl, String(stage), String(error?.code || error?.name || 'error'),
      String(error?.message || error), nowIso(),
    );
  }

  runSnapshotCounts(runId, textbookId = null) {
    const id = Number(runId);
    const filter = textbookId == null ? '' : ' AND textbook_external_id = ?';
    const args = textbookId == null ? [id] : [id, String(textbookId)];
    const count = (table) => Number(this.db.prepare(
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)} WHERE run_id = ?${filter}`,
    ).get(...args).n || 0);
    return {
      catalogCount: count('sync_run_catalog_items'),
      questionCount: count('sync_run_question_items'),
      questionCatalogCount: count('sync_run_question_catalogs'),
      questionTagCount: count('sync_run_question_tags'),
      questionAssetCount: count('sync_run_question_assets'),
    };
  }

  validateRunCompleteness(runId, scope, catalogs = [], counters = {}) {
    const value = scope && typeof scope === 'object' ? scope : {};
    const textbookId = String(value.textbookId || '');
    const counts = this.runSnapshotCounts(runId, textbookId);
    const reasons = [];
    const availableCount = Number(value.availableCatalogCount || catalogs.length);
    const selectedCount = Number(value.selectedCatalogCount || catalogs.length);
    if (value.catalogSelectionTruncated || (value.allCatalogs && selectedCount < availableCount)) {
      reasons.push('目录被 max-catalogs 截断');
    }
    if (Number(value.limit || 0) > 0) reasons.push('题目被 limit 截断');
    if (Number(counters?.errors || 0) > 0) reasons.push('运行存在错误，禁止封存为完整快照');
    const progress = this.db.prepare(`
      SELECT catalog_external_id, expected_total, expected_pages, last_completed_page
      FROM sync_run_catalog_progress
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
    `).all(Number(runId), PROVIDER, textbookId);
    const byCatalog = new Map(progress.map((row) => [String(row.catalog_external_id), row]));
    for (const catalog of catalogs) {
      const id = String(catalog.externalId);
      const row = byCatalog.get(id);
      if (!row) {
        reasons.push(`目录 ${id} 没有分页进度`);
        continue;
      }
      if (Number(row.expected_pages || 0) > 0 && Number(row.last_completed_page || 0) < Number(row.expected_pages)) {
        reasons.push(`目录 ${id} 分页未完成`);
      }
      const expectedPageCount = Number(row.expected_pages || 0);
      if (expectedPageCount > 0) {
        const pageRows = this.db.prepare(`
          SELECT page_number, page_signature FROM sync_run_catalog_pages
          WHERE run_id = ? AND provider = ? AND textbook_external_id = ? AND catalog_external_id = ?
          ORDER BY page_number ASC
        `).all(Number(runId), PROVIDER, textbookId, id);
        const pageNumbers = new Set(pageRows.map((entry) => Number(entry.page_number)));
        const signatures = new Set(pageRows.map((entry) => String(entry.page_signature)));
        if (pageRows.length < expectedPageCount
          || [...Array(expectedPageCount).keys()].some((number) => !pageNumbers.has(number + 1))) {
          reasons.push(`目录 ${id} 页完整性不足`);
        }
        if (signatures.size !== pageRows.length) reasons.push(`目录 ${id} 存在重复页签名`);
      }
      if (Number(row.expected_total || 0) > 0) {
        const actual = this.db.prepare(`
          SELECT list_seen_count AS n
          FROM sync_run_catalog_progress
          WHERE run_id = ? AND provider = ? AND textbook_external_id = ? AND catalog_external_id = ?
        `).get(Number(runId), PROVIDER, textbookId, id);
        if (Number(actual?.n || 0) < Number(row.expected_total)) reasons.push(`目录 ${id} 题目数不完整`);
      }
    }
    if (counts.catalogCount <= 0) reasons.push('运行快照缺少目录');
    if (catalogs.length > 0 && counts.questionCatalogCount <= 0) reasons.push('运行快照缺少题目目录关系');
    if (value.downloadAssets) {
      const missingAssets = this.db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_question_assets
        WHERE run_id = ? AND textbook_external_id = ?
          AND (source_url IS NULL OR source_url = ''
            OR content_sha256 IS NULL OR content_sha256 = ''
            OR storage_path IS NULL OR storage_path = '')
      `).get(Number(runId), textbookId);
      if (Number(missingAssets?.n || 0) > 0) reasons.push('题目素材未完整下载');
      const flagged = this.db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_question_items AS q
        WHERE q.run_id = ? AND q.textbook_external_id = ?
          AND (COALESCE(q.has_image, 0) = 1 OR COALESCE(q.has_formula, 0) = 1)
          AND NOT EXISTS (
            SELECT 1 FROM sync_run_question_assets AS a
            WHERE a.run_id = q.run_id AND a.provider = q.provider
              AND a.textbook_external_id = q.textbook_external_id
              AND a.question_external_id = q.question_external_id
          )
      `).get(Number(runId), textbookId);
      if (Number(flagged?.n || 0) > 0) reasons.push('题目标记的素材未写入快照');
    }
    return { complete: reasons.length === 0, reasons, counts, progress };
  }

  finishRun(runId, status, counters = {}, message = null, completeness = null) {
    const current = this.getRun(runId);
    if (!current || String(current.status) !== 'running' || current.snapshot_locked_at) return false;
    const wantsSuccess = ['success', 'completed'].includes(String(status));
    const complete = wantsSuccess && Boolean(completeness?.complete);
    const effectiveStatus = complete ? String(status) : (wantsSuccess ? 'interrupted' : String(status));
    const counts = this.runSnapshotCounts(runId, completeness?.scope?.textbookId || null);
    const finishedAt = nowIso();
    this.db.prepare(`
      UPDATE sync_runs SET finished_at = ?, status = ?, pages_ok = ?,
        questions_seen = ?, questions_inserted = ?, questions_updated = ?,
        details_fetched = 0, assets_downloaded = ?, error_count = ?,
        message = ?, catalog_item_count = ?, question_item_count = ?,
        question_catalog_count = ?, question_tag_count = ?, question_asset_count = ?,
        snapshot_complete = ?, snapshot_locked_at = ?
      WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
    `).run(
      finishedAt, effectiveStatus, Number(counters.pagesOk || 0), Number(counters.questionsSeen || 0),
      Number(counters.questionsInserted || 0), Number(counters.questionsUpdated || 0),
      Number(counters.assetsDownloaded || 0), Number(counters.errors || 0),
      message || (complete ? null : (completeness?.reasons || []).join('；') || null),
      counts.catalogCount, counts.questionCount, counts.questionCatalogCount,
      counts.questionTagCount, counts.questionAssetCount, complete ? 1 : 0, finishedAt,
      Number(runId),
    );
    return effectiveStatus;
  }

  status() {
    return {
      counts: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM questions) AS questions,
          (SELECT COUNT(*) FROM textbook_nodes) AS nodes,
          (SELECT COUNT(*) FROM question_catalog_memberships) AS catalog_links,
          (SELECT COUNT(*) FROM question_knowledge) AS knowledge_links,
          (SELECT COUNT(*) FROM question_facets) AS facets,
          (SELECT COUNT(*) FROM question_assets) AS assets
      `).get(),
      recentRuns: this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all(),
    };
  }

  close() {
    try { this.db.close(); } catch {}
  }
}

function parsePositiveInt(value, optionName, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new Error(`${optionName} 必须是${allowZero ? '非负' : '正'}整数。`);
  }
  return number;
}

function usage() {
  return `
题库基础全量同步（独立 collector 先行验证脚本）

用法：
  cd collector && npm run sync:zujuan:questions -- --textbook-id 260617

核心选项：
  --textbook-id <id>       教材来源 ID，默认 260617
  --bank-id <id>          题库 ID，默认 2
  --bank-path <path>      题库路径，默认 czsx
  --catalog-id <id>       只抓指定目录，可重复
  --catalog-level <n>     目录层级，可重复；默认抓章/小节/知识点
  --max-catalogs <n>      本次最多目录数，0 表示不限
  --start-page <n>        每个目录起始页，默认 1
  --max-pages <n>         每个目录最多页数，默认 1000
  --limit <n>             本次最多保存题数，便于验收；0 表示不限

运行选项：
  --headless              显式使用无头 Chrome；默认有头 Chrome
  --cdp-url <url>         连接已有 Chrome 的 CDP（如 http://127.0.0.1:9222），不接管/关闭该浏览器
  --connect-over-cdp <url> --cdp-url 的别名
  --delay-min <ms>        API 请求最小间隔，默认 2500
  --delay-max <ms>        API 请求最大间隔，默认 4000
  --timeout <ms>          页面/API 超时，默认 30000
  --verification-timeout <ms> 人工验证等待上限，默认 600000
  --verification-probe-interval <ms> API 验证探测间隔，默认 5000
  --no-download-assets    只记录素材 URL，不下载
  --no-save-raw           不保存 gzip API 原始快照
  --no-resume             不复用/克隆未完成运行
  --resume-run-id <id>    从指定的已封存不完整运行续采
  --db <path>             SQLite，默认 data/zujuan.sqlite3
  --data-dir <path>       快照与素材目录，默认 data/zujuan-question-sync
  --profile-dir <path>    固定 persistent profile，默认 .cache/zujuan-sync-profile
  --status                只显示 collector 状态
  --help                  显示帮助

安全行为：单浏览器会话、题目 API 并发 1；401/403、JSON 变 HTML、挑战/滑块进入人工验证等待；不会访问 robots.txt，也不会自动绕过滑块。
`;
}

function parseArgs(argv = []) {
  const cwd = process.cwd();
  const projectRoot = path.resolve(__dirname);
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    treeBaseUrl: 'https://static.zxxk.com',
    apiPath: DEFAULT_API_PATH,
    bankId: DEFAULT_BANK_ID,
    bankPath: DEFAULT_BANK_PATH,
    textbookId: DEFAULT_TEXTBOOK_ID,
    chapterId: null,
    catalogIds: [],
    catalogLevels: [],
    maxCatalogs: 0,
    startPage: 1,
    maxPages: SITE_PAGE_LIMIT,
    maxPagesProvided: false,
    limit: 0,
    headless: false,
    cdpUrl: null,
    delayMin: DEFAULT_DELAY_MIN,
    delayMax: DEFAULT_DELAY_MAX,
    timeout: DEFAULT_TIMEOUT,
    verificationTimeout: DEFAULT_VERIFICATION_TIMEOUT,
    verificationPoll: DEFAULT_VERIFICATION_POLL,
    verificationProbeInterval: DEFAULT_VERIFICATION_PROBE_INTERVAL,
    downloadAssets: true,
    saveRaw: true,
    resume: true,
    resumeRunId: null,
    dbPath: path.resolve(projectRoot, 'data/zujuan.sqlite3'),
    dataDir: path.resolve(projectRoot, 'data/zujuan-question-sync'),
    profileDir: path.resolve(projectRoot, '.cache/zujuan-sync-profile'),
    statusOnly: false,
    help: false,
  };
  const needValue = (index, flag) => {
    if (index + 1 >= argv.length || String(argv[index + 1]).startsWith('--')) throw new Error(`${flag} 缺少参数值。`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--help': case '-h': options.help = true; break;
      case '--textbook-id': options.textbookId = String(needValue(index, flag)); index += 1; break;
      case '--chapter-id': options.chapterId = String(needValue(index, flag)); index += 1; break;
      case '--bank-id': options.bankId = parsePositiveInt(needValue(index, flag), flag); index += 1; break;
      case '--bank-path': options.bankPath = String(needValue(index, flag)).trim(); index += 1; break;
      case '--catalog-id': options.catalogIds.push(String(needValue(index, flag))); index += 1; break;
      case '--catalog-level': {
        const level = parsePositiveInt(needValue(index, flag), flag);
        if (![1, 2, 3].includes(level)) throw new Error('--catalog-level 只能是 1、2、3。');
        options.catalogLevels.push(level); index += 1; break;
      }
      case '--max-catalogs': options.maxCatalogs = parsePositiveInt(needValue(index, flag), flag, { allowZero: true }); index += 1; break;
      case '--start-page': options.startPage = parsePositiveInt(needValue(index, flag), flag); index += 1; break;
      case '--max-pages': options.maxPages = parsePositiveInt(needValue(index, flag), flag); options.maxPagesProvided = true; index += 1; break;
      case '--limit': options.limit = parsePositiveInt(needValue(index, flag), flag, { allowZero: true }); index += 1; break;
      case '--headless': options.headless = true; break;
      case '--headful': options.headless = false; break;
      case '--cdp-url': case '--connect-over-cdp': options.cdpUrl = String(needValue(index, flag)).trim(); index += 1; break;
      case '--delay-min': options.delayMin = parsePositiveInt(needValue(index, flag), flag, { allowZero: true }); index += 1; break;
      case '--delay-max': options.delayMax = parsePositiveInt(needValue(index, flag), flag, { allowZero: true }); index += 1; break;
      case '--timeout': options.timeout = parsePositiveInt(needValue(index, flag), flag); index += 1; break;
      case '--verification-timeout': options.verificationTimeout = parsePositiveInt(needValue(index, flag), flag, { allowZero: true }); index += 1; break;
      case '--verification-poll': options.verificationPoll = parsePositiveInt(needValue(index, flag), flag, { allowZero: true }); index += 1; break;
      case '--verification-probe-interval': options.verificationProbeInterval = parsePositiveInt(needValue(index, flag), flag); index += 1; break;
      case '--no-download-assets': options.downloadAssets = false; break;
      case '--download-assets': options.downloadAssets = true; break;
      case '--no-save-raw': options.saveRaw = false; break;
      case '--no-resume': options.resume = false; break;
      case '--resume-run-id': options.resumeRunId = parsePositiveInt(needValue(index, flag), flag); index += 1; break;
      // The HTTP collector already enforces this acknowledgement before it
      // starts a child.  Accept the established CLI flag so the new script
      // can be selected without widening the server request contract.
      case '--acknowledge-source-policy': break;
      case '--db': options.dbPath = path.resolve(cwd, needValue(index, flag)); index += 1; break;
      case '--data-dir': options.dataDir = path.resolve(cwd, needValue(index, flag)); index += 1; break;
      case '--profile-dir': options.profileDir = path.resolve(cwd, needValue(index, flag)); index += 1; break;
      case '--status': options.statusOnly = true; break;
      default: throw new Error(`未知参数：${flag}`);
    }
  }
  if (!options.textbookId.trim()) throw new Error('--textbook-id 不能为空。');
  options.chapterId = String(options.chapterId || options.textbookId).trim();
  if (!options.chapterId) throw new Error('--chapter-id 不能为空。');
  if (!options.bankPath.trim()) throw new Error('--bank-path 不能为空。');
  if (options.cdpUrl) {
    let parsedCdp;
    try { parsedCdp = new URL(options.cdpUrl); } catch { throw new Error('--cdp-url 必须是有效的 CDP URL。'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsedCdp.protocol)) {
      throw new Error('--cdp-url 只支持 http(s)/ws(s) URL。');
    }
  }
  if (options.delayMax < options.delayMin) throw new Error('--delay-max 不能小于 --delay-min。');
  if (options.maxPages > SITE_PAGE_LIMIT) throw new Error(`--max-pages 不能超过 ${SITE_PAGE_LIMIT}。`);
  if (!options.resume && options.resumeRunId != null) {
    throw new Error('--resume-run-id 不能与 --no-resume 同时使用。');
  }
  options.catalogIds = [...new Set(options.catalogIds.map((value) => value.trim()).filter(Boolean))];
  options.catalogLevels = [...new Set(options.catalogLevels)].sort();
  return options;
}

function buildScope(options, catalogCount = 0, selectedCount = 0, summaryInfo = {}) {
  const effectiveCatalogLevels = options.catalogLevels.length > 0
    ? options.catalogLevels
    : [1, 2, 3];
  const explicitlySelectedCatalogs = options.catalogIds.length > 0 || options.catalogLevels.length > 0;
  // Keep the old array form readable for existing callers, but new runs use
  // the single textbook-root total probe instead of a chapter-total sum.
  const summaryCatalogs = Array.isArray(summaryInfo) ? summaryInfo : [];
  const textbookExpectedTotalRaw = Array.isArray(summaryInfo)
    ? null : summaryInfo?.textbookExpectedTotal;
  const textbookExpectedTotalNumber = textbookExpectedTotalRaw == null || textbookExpectedTotalRaw === ''
    ? NaN : Number(textbookExpectedTotalRaw);
  const textbookExpectedTotal = Number.isSafeInteger(textbookExpectedTotalNumber)
    && textbookExpectedTotalNumber >= 0
    ? textbookExpectedTotalNumber
    : null;
  const summaryStrategy = String(
    Array.isArray(summaryInfo) ? 'textbook_root_probe' : (summaryInfo?.summaryStrategy || 'textbook_root_probe'),
  );
  const summaryCatalogIds = Array.isArray(summaryCatalogs)
    ? summaryCatalogs.map((catalog) => String(catalog?.externalId || '')).filter(Boolean)
    : [];
  const summaryLevels = Array.isArray(summaryCatalogs)
    ? summaryCatalogs.map((catalog) => Number(catalog?.level)).filter(Number.isFinite)
    : [];
  return {
    provider: PROVIDER,
    bankId: options.bankId,
    bankPath: options.bankPath,
    textbookId: options.textbookId,
    catalogIds: options.catalogIds,
    chapterIds: [String(options.chapterId || options.textbookId)],
    catalogLevels: effectiveCatalogLevels,
    allCatalogs: !explicitlySelectedCatalogs,
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
    availableCatalogCount: catalogCount,
    selectedCatalogCount: selectedCount,
    // This is the provider's textbook-root total.  It is intentionally kept
    // separate from each catalog progress row, whose counts are page
    // occurrences and whose expected_total is only that node's total.
    textbookExpectedTotal,
    summaryStrategy,
    summaryCatalogIds,
    summaryCatalogLevel: summaryLevels.length > 0 ? Math.min(...summaryLevels) : null,
    catalogSelectionTruncated: !explicitlySelectedCatalogs
      && Number(options.maxCatalogs || 0) > 0
      && selectedCount < catalogCount,
    startPage: options.startPage,
    maxPages: options.maxPages,
    maxPagesProvided: options.maxPagesProvided,
    limit: options.limit,
    downloadAssets: options.downloadAssets,
    contentSource: 'list_api',
    details: false,
    detailFallback: true,
    refreshDetails: false,
    includeVisibleSolutions: false,
    answerStatus: 'not_collected',
    requireDetails: false,
    requireAssets: options.downloadAssets,
    resumeFromRunId: options.resumeRunId,
  };
}

/**
 * Validate an explicitly selected source run with the established Collector
 * contract while allowing this list collector to widen operational bounds.
 * A partial one-page probe may therefore continue as a full run, but cannot
 * change textbook, catalog selection, filters, or asset policy.
 */
function validateQuestionListResumeSourceRun(dbPath, sourceRunId, targetScope) {
  let db;
  let sourceScope = {};
  try {
    db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    const row = db.prepare('SELECT scope_json FROM sync_runs WHERE id = ?').get(Number(sourceRunId));
    if (row) {
      try { sourceScope = JSON.parse(row.scope_json || '{}'); } catch {}
    }
  } finally {
    try { db?.close(); } catch {}
  }
  const sourceMaxPages = Number(sourceScope.maxPages || 0);
  const targetMaxPages = Number(targetScope.maxPages || 0);
  if (sourceMaxPages > 0 && targetMaxPages > 0 && targetMaxPages < sourceMaxPages) {
    throw new QuestionSyncError('续采不能缩小 --max-pages。', 'resume_source_invalid');
  }
  const sourceLimit = Number(sourceScope.limit || 0);
  const targetLimit = Number(targetScope.limit || 0);
  if ((sourceLimit === 0 && targetLimit > 0)
    || (sourceLimit > 0 && targetLimit > 0 && targetLimit < sourceLimit)) {
    throw new QuestionSyncError('续采不能缩小 --limit。', 'resume_source_invalid');
  }
  return validateResumeSourceRun(dbPath, sourceRunId, {
    ...targetScope,
    maxPages: sourceScope.maxPages ?? targetScope.maxPages,
    limit: sourceScope.limit ?? targetScope.limit,
  });
}

function saveRawPage(options, runId, catalog, pageNumber, responseText) {
  if (!options.saveRaw) return null;
  const capturedAt = nowIso();
  const relative = path.join(
    'raw', capturedAt.slice(0, 10), `run-${runId}`,
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

function validatePageResult(
  parsed,
  pageNumber,
  expectedPages,
  previousSignatures,
  previousQuestionIds = null,
  expectedTotal = null,
) {
  if (!parsed || !Array.isArray(parsed.questions) || !Array.isArray(parsed.questionIds)) {
    throw new QuestionSyncError('题目列表页解析结果不完整。', 'list_api_contract');
  }
  const page = Number(pageNumber);
  const total = Number(parsed.total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new QuestionSyncError('题目列表页 total 无效。', 'list_api_contract');
  }
  if (expectedTotal != null && total !== Number(expectedTotal)) {
    throw new QuestionSyncError(`分页期间 total 从 ${expectedTotal} 变为 ${total}。`, 'pagination_total_changed');
  }
  if (parsed.questions.length !== parsed.questionIds.length) {
    throw new QuestionSyncError('题目列表页题卡数与题号数不一致。', 'list_api_contract');
  }
  if (parsed.questionIds.some((value) => value == null
    || ['null', 'undefined'].includes(normalizeId(value).toLowerCase())
    || !normalizeId(value))) {
    throw new QuestionSyncError('题目列表页存在空题号。', 'list_api_contract');
  }
  const ids = parsed.questionIds.map((value) => normalizeId(value));
  if (new Set(ids).size !== ids.length) throw new QuestionSyncError('单页题号重复。', 'page_duplicate_questions');
  const computedPages = Math.max(1, Math.ceil(total / 10));
  if (Number(expectedPages) > 0 && Number(expectedPages) !== computedPages) {
    throw new QuestionSyncError(
      `题目列表页数契约不一致：期望 ${expectedPages}，根据 total 应为 ${computedPages}。`,
      'pagination_contract',
    );
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > computedPages) {
    throw new QuestionSyncError(`题目列表页码 ${pageNumber} 超出 total 对应范围。`, 'pagination_contract');
  }
  const expectedCount = total === 0
    ? 0
    : (page < computedPages ? 10 : (total - ((computedPages - 1) * 10)));
  if (ids.length !== expectedCount) {
    throw new QuestionSyncError(
      `${ids.length === 0 ? '空页：' : ''}第 ${pageNumber} 页题目数 ${ids.length} 不符合 total=${total} 的分页契约（应为 ${expectedCount}）。`,
      ids.length === 0 ? 'empty_page' : 'pagination_contract',
    );
  }
  const signature = sha256(ids.join(','));
  if (previousSignatures?.has(signature)) throw new QuestionSyncError(`第 ${pageNumber} 页与此前页面重复。`, 'pagination_loop');
  if (previousQuestionIds && ids.some((id) => previousQuestionIds.has(id))) {
    throw new QuestionSyncError(`第 ${pageNumber} 页与此前页面存在重复题号。`, 'pagination_overlap');
  }
  return signature;
}

async function loadPlaywright() {
  try { return require('playwright-core'); } catch {
    const configured = process.env.PLAYWRIGHT_CORE_PATH;
    if (!configured) throw new Error('缺少 playwright-core，请先在 collector 目录 npm install。');
    return require(configured);
  }
}

async function connectCollectorOverCDP(playwright, options) {
  const cdpUrl = String(options?.cdpUrl || '').trim();
  if (!cdpUrl) return null;
  if (typeof playwright?.chromium?.connectOverCDP !== 'function') {
    throw new QuestionSyncError('当前 Playwright 不支持 connectOverCDP。', 'cdp_unavailable');
  }
  let browser;
  try {
    browser = await playwright.chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    throw new QuestionSyncError(`连接 Chrome CDP 失败：${error.message}`, 'cdp_connect', error);
  }
  const contexts = typeof browser.contexts === 'function' ? browser.contexts() : [];
  const context = contexts[0] || null;
  if (!context) {
    // Do not call browser.close(): the CDP browser belongs to the operator.
    throw new QuestionSyncError('CDP Chrome 没有可用的浏览器上下文。', 'cdp_context');
  }
  return { browser, context };
}

async function chooseCollectorPage(context, preferredPage = null) {
  if (preferredPage) return { page: preferredPage, owned: false };
  // In CDP mode the context carries the operator's cookies/session, but the
  // user's existing tabs remain untouched.  Always use a dedicated tab so a
  // run cannot navigate or close a tab the operator is viewing.
  if (typeof context?.newPage !== 'function') {
    throw new QuestionSyncError('CDP 浏览器没有可用的新建采集 tab。', 'page_unavailable');
  }
  return { page: await context.newPage(), owned: true };
}

async function runSync(options, dependencies = {}) {
  const opts = { ...options };
  ensureDir(opts.dataDir);
  ensureDir(opts.profileDir);
  const store = dependencies.store || new QuestionSyncStore(opts.dbPath, { dataDir: opts.dataDir });
  const release = acquireLock(`${opts.dbPath}${LOCK_SUFFIX}`);
  const initialScope = buildScope(opts);
  let runId;
  let context = dependencies.context || null;
  let page = dependencies.page || null;
  let connectedOverCDP = false;
  let ownedPage = false;
  const counters = {
    pagesOk: 0,
    questionsSeen: 0,
    questionsInserted: 0,
    questionsUpdated: 0,
    assetsDownloaded: 0,
    errors: 0,
  };
  let selectedCatalogs = [];
  let tree = null;
  const requestGate = createRequestGate(opts.delayMin, opts.delayMax);
  const assetCache = new Map();
  let scope = initialScope;
  let finalStatus = 'success';
  let finalMessage = null;
  try {
    if (opts.resumeRunId != null) {
      validateQuestionListResumeSourceRun(opts.dbPath, opts.resumeRunId, initialScope);
    }
    runId = store.beginRun(initialScope, {
      resume: opts.resume,
      resumeRunId: opts.resumeRunId,
    });
    console.log(`run=${runId}`);
    if (!context) {
      const playwright = dependencies.playwright || await loadPlaywright();
      if (opts.cdpUrl) {
        const connected = await connectCollectorOverCDP(playwright, opts);
        context = connected.context;
        connectedOverCDP = true;
      } else {
        context = await launchCollectorContext(playwright, {
          ...opts,
          // New script contract: default is explicitly headed.  The metadata
          // launcher receives the same stable persistent profile path.
          headless: opts.headless === true,
        });
      }
    }
    if (!page) {
      if (connectedOverCDP) {
        const selected = await chooseCollectorPage(context);
        page = selected.page;
        ownedPage = selected.owned;
      } else {
        page = context.pages?.()[0] || await context.newPage();
      }
    }
    await navigateToTextbook(page, initialTextbookUrl(opts), opts);
    const rawTree = dependencies.catalogTree || await fetchCatalogTree(page, opts);
    tree = normalizeCatalogTree(rawTree, opts);
    const eligibleCatalogs = selectCatalogs(tree, { ...opts, maxCatalogs: 0 });
    selectedCatalogs = opts.maxCatalogs > 0
      ? eligibleCatalogs.slice(0, opts.maxCatalogs)
      : eligibleCatalogs;
    if (selectedCatalogs.length === 0) throw new QuestionSyncError('未选择任何目录。', 'catalog_not_found');
    scope = buildScope(opts, eligibleCatalogs.length, selectedCatalogs.length);
    store.updateRunScope(runId, scope);
    store.saveCatalogTree(runId, opts.textbookId, tree.nodes);
    console.log(`[目录] 全部节点 ${tree.nodes.length}，本次目录 ${selectedCatalogs.length}`);

    // The provider can return the complete textbook total from the textbook
    // page session.  This is a total-only probe: the response also contains
    // ten question cards, but they must not become a page/checkpoint or
    // question snapshot.  A bounded `--limit` run intentionally skips this
    // extra request: the limit contract is that only complete real API pages
    // are requested and persisted, and the denominator is explicitly
    // unknown for that diagnostic run.
    if (opts.limit > 0) {
      scope = buildScope(
        opts,
        eligibleCatalogs.length,
        selectedCatalogs.length,
        { textbookExpectedTotal: null, summaryStrategy: 'unknown_limited_run' },
      );
      store.updateRunScope(runId, scope);
      console.log('[统计] --limit 运行跳过教材根目录 total 探针');
    } else {
      await requestGate(opts.sleepFn || sleep);
      const textbookRoot = {
        externalId: String(opts.textbookId),
        categoryId: String(opts.textbookId),
        catelogTokpointId: '0',
      };
      const rootProbe = await postQuestionListTotal(page, opts, textbookRoot, 1);
      const textbookExpectedTotal = Number(rootProbe.total);
      scope = buildScope(
        opts,
        eligibleCatalogs.length,
        selectedCatalogs.length,
        { textbookExpectedTotal, summaryStrategy: 'textbook_root_probe' },
      );
      store.updateRunScope(runId, scope);
      console.log(`[统计] 教材根目录 total=${textbookExpectedTotal}`);
    }

    const explicitLastPage = opts.maxPagesProvided
      ? Number(opts.maxPages)
      : Number.POSITIVE_INFINITY;
    const catalogStates = selectedCatalogs.map((catalog) => {
      const filterJson = '{}';
      const scopeKey = sha256(`${PROVIDER}|${opts.textbookId}|${catalog.externalId}|${filterJson}`);
      // A new run must replay a successful source from page 1.  Resume
      // boundaries are run-owned (stale running runs are reused and sealed
      // partial runs are cloned in beginRun); consulting the old mutable
      // provider-wide checkpoint here would silently create an incomplete
      // fresh snapshot after a previous successful run.
      const checkpoint = opts.resume ? store.getRunCheckpoint(runId, scopeKey) : 0;
      const savedPages = opts.resume ? store.getRunPageSignatures(runId, catalog.externalId) : [];
      const savedPageNumbers = new Set(savedPages.map((entry) => Number(entry.pageNumber)));
      const previousSignatures = new Set(savedPages.map((entry) => entry.signature));
      const previousQuestionIds = new Set(savedPages.flatMap((entry) => entry.questionIds));
      const savedProgress = opts.resume
        ? store.getRunCatalogProgress(runId, opts.textbookId, catalog.externalId)
        : null;
      const hasPageOne = savedPageNumbers.has(1);
      return {
        catalog,
        filterJson,
        scopeKey,
        checkpoint,
        savedPageNumbers,
        previousSignatures,
        previousQuestionIds,
        expectedPages: savedProgress?.expectedPages ?? null,
        expectedTotal: savedProgress?.expectedTotal ?? null,
        // A node with no persisted page 1 must start at page 1 in its normal
        // turn. Resumed nodes with cloned pages continue from checkpoint+1.
        nextPage: hasPageOne ? Math.max(opts.startPage, checkpoint + 1, 2) : 1,
      };
    });

    const fetchCatalogPage = async (state, pageNumber) => {
      const { catalog, filterJson, scopeKey } = state;
      await requestGate(opts.sleepFn || sleep);
      const parsed = await postQuestionList(page, opts, catalog, pageNumber);
      const pageTotal = Number(parsed.total);
      const expectedPagesRaw = Math.max(1, Math.ceil(pageTotal / 10));
      if (state.expectedTotal != null && pageTotal !== state.expectedTotal) {
        throw new QuestionSyncError(
          `目录 ${catalog.externalId} 分页期间 total 从 ${state.expectedTotal} 变为 ${pageTotal}。`,
          'pagination_total_changed',
        );
      }
      if (state.expectedPages != null && expectedPagesRaw !== state.expectedPages) {
        throw new QuestionSyncError(
          `目录 ${catalog.externalId} 分页期间页数从 ${state.expectedPages} 变为 ${expectedPagesRaw}。`,
          'pagination_total_changed',
        );
      }
      state.expectedTotal = pageTotal;
      state.expectedPages = expectedPagesRaw;
      const signature = validatePageResult(
        parsed,
        pageNumber,
        state.expectedPages,
        state.previousSignatures,
        state.previousQuestionIds,
        state.expectedTotal,
      );
      state.previousSignatures.add(signature);
      state.savedPageNumbers.add(Number(pageNumber));
      for (const questionId of parsed.questionIds) state.previousQuestionIds.add(String(questionId));
      // `--limit` is a stopping condition, not a row-level filter.  The
      // page checkpoint may advance only after the complete API page (and
      // all of its assets) has been committed, so an accepted page can
      // intentionally exceed the limit by up to the page capacity.
      const questions = parsed.questions;
      if (opts.downloadAssets) {
        for (const question of questions) {
          const downloaded = [];
          for (const asset of question.assets || []) {
            const sourceUrl = String(asset.sourceUrl || asset.url || '');
            let result = assetCache.get(sourceUrl);
            const wasCached = assetCache.has(sourceUrl);
            if (!wasCached) {
              result = await downloadAsset(context, opts, asset);
              assetCache.set(sourceUrl, result);
              if (result.contentSha256) counters.assetsDownloaded += 1;
            }
            downloaded.push(result);
          }
          question.assets = downloaded;
        }
      }
      const chapterExternalId = String(catalog.chapterExternalId || catalog.externalId);
      const normalizedCatalog = {
        ...catalog,
        chapterExternalId,
        ancestorIds: catalog.ancestorIds || [catalog.externalId],
      };
      const rawSnapshot = saveRawPage(opts, runId, catalog, pageNumber, parsed.rawPayload || parsed.html);
      const result = store.savePage({
        runId,
        textbookExternalId: opts.textbookId,
        catalog: normalizedCatalog,
        nodes: tree.nodes,
        pageNumber,
        expectedTotal: state.expectedTotal,
        pageCapacity: 10,
        expectedPages: state.expectedPages,
        questions,
        queryFingerprint: scopeKey,
        filterJson,
        rawSnapshot,
      });
      counters.pagesOk += 1;
      counters.questionsSeen += questions.length;
      counters.questionsInserted += result.inserted || 0;
      counters.questionsUpdated += result.updated || 0;
      console.log(`[列表] catalog=${catalog.externalId} page=${pageNumber}/${state.expectedPages} questions=${questions.length} total=${state.expectedTotal}`);
      state.nextPage = Math.max(state.nextPage, Number(pageNumber) + 1);
      return { questions, result };
    };

    // All real catalogs start from their own saved checkpoint.  Nodes without
    // a saved page 1 begin at page 1 here; the root total probe above is never
    // represented as a catalog page or question snapshot.
    for (const state of catalogStates) {
      if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break;
      let pageNumber = Math.max(1, state.nextPage);
      while (pageNumber <= explicitLastPage) {
        if (state.expectedPages != null && pageNumber > state.expectedPages) break;
        await fetchCatalogPage(state, pageNumber);
        if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break;
        if (state.expectedTotal === 0 || pageNumber >= state.expectedPages) break;
        pageNumber += 1;
      }
    }
    const completeness = store.validateRunCompleteness(runId, scope, selectedCatalogs, counters);
    if (!completeness.complete) finalStatus = 'interrupted';
    store.finishRun(runId, finalStatus, counters, finalMessage, { ...completeness, scope });
    return { runId, status: finalStatus, counters, completeness };
  } catch (error) {
    counters.errors += 1;
    finalMessage = String(error.message || error);
    if (runId) {
      // Error persistence is diagnostic only. A damaged/old database must
      // never replace the original crawl failure with a secondary SQLite
      // error (for example, a missing sync_errors table).
      try {
        store.recordError(runId, 'run', error);
      } catch (recordErrorFailure) {
        console.error(`[错误记录失败] ${recordErrorFailure.message}`);
      }
    }
    if (error instanceof VerificationRequiredError || error.code === 'waiting_verification') finalStatus = 'blocked';
    else if (['network_error', 'navigation_error', 'tree_network_error'].includes(String(error.code || ''))
      || /^http_(408|429|5\d\d)$/.test(String(error.code || ''))) finalStatus = 'interrupted';
    else finalStatus = error instanceof StopCrawlError ? 'blocked' : 'failed';
    if (runId) {
      const completeness = store.validateRunCompleteness(runId, scope, selectedCatalogs, counters);
      store.finishRun(runId, finalStatus, counters, finalMessage, { ...completeness, scope });
    }
    throw error;
  } finally {
    if (connectedOverCDP) {
      // The browser and context are owned by the operator's Chrome process.
      // Only dispose a tab created by this run; never close the CDP browser.
      if (ownedPage && page && typeof page.close === 'function') {
        try { await page.close(); } catch {}
      }
    } else if (context && !dependencies.context) {
      await closeCollectorContext(context);
    }
    store.close();
    release();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(usage()); return; }
    if (options.statusOnly) {
      const store = new QuestionSyncStore(options.dbPath, { dataDir: options.dataDir });
      try { console.log(JSON.stringify(store.status(), null, 2)); } finally { store.close(); }
      return;
    }
    await runSync(options);
  } catch (error) {
    console.error(`\n[错误] ${error.message}`);
    if (!options?.help) console.error('使用 --help 查看参数。');
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_ASSET_HOSTS,
  DEFAULT_API_PATH,
  DEFAULT_BANK_ID,
  DEFAULT_BANK_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_TEXTBOOK_ID,
  DEFAULT_VERIFICATION_PROBE_INTERVAL,
  FORMAL_ASSET_TYPES,
  MAX_RETRIES,
  PROTECTION_MARKERS,
  QuestionSyncError,
  QuestionSyncStore,
  SITE_PAGE_LIMIT,
  VerificationRequiredError,
  buildQuestionListBody,
  buildQuestionListRequest,
  buildScope,
  catalogTreeUrl,
  classifyAsset,
  classifyQuestionResponse,
  connectCollectorOverCDP,
  decodeHtmlEntities,
  downloadAsset,
  fetchCatalogTree,
  finalizeQuestion,
  initialTextbookUrl,
  isProtectionText,
  looksLikeHtml,
  normalizeAssetType,
  normalizeCatalogTree,
  normalizeWhitespace,
  parseArgs,
  parseDifficulty,
  parseQuestionBlock,
  parseQuestionListHtml,
  parseQuestionListPayload,
  parseQuestionListTotalPayload,
  postQuestionList,
  postQuestionListTotal,
  retryAfterMs,
  retryDelay,
  responseStatus,
  createRequestGate,
  selectCatalogs,
  serializeFormBody,
  stripHtml,
  usage,
  validatePageResult,
  validateQuestionListResumeSourceRun,
  waitForVerification,
  runSync,
  runCli,
};

function runCli() {
  // A connected-over-CDP Playwright transport may keep a socket/event loop
  // handle after its dedicated tab is closed.  This is CLI-only cleanup:
  // all run finally blocks have completed, and we deliberately do not call
  // browser.close() because that browser belongs to the operator.
  return main().finally(() => process.exit(process.exitCode || 0));
}

if (require.main === module) runCli();
