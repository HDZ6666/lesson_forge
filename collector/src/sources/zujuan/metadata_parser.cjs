'use strict';

/**
 * Pure parsers for version / textbook discovery pages and the
 * `chaptertextbooks` API fragment.  Missing stable IDs are reported, never
 * fabricated.
 */

const { StopCrawlError } = require('../../shared/errors.cjs');
const { isStableExternalId, normalizeWhitespace } = require('../../shared/utils.cjs');
const { parseAnchors, sliceElementById } = require('../../shared/html.cjs');
const { classifyHtmlProtection, protectionStopMessage } = require('./response_classifier.cjs');
const { textbookSourceUrl } = require('./urls.cjs');

function parseGradeVolume(name) {
  const text = normalizeWhitespace(name);
  if (!text) return { grade: null, volume: null };
  const volumeMatch = text.match(/(上册|下册|全一册)$/);
  const volume = volumeMatch ? volumeMatch[1] : null;
  if (!volume) return { grade: null, volume: null };
  const grade = normalizeWhitespace(text.slice(0, -volume.length)) || null;
  return { grade, volume };
}

function normalizeIsNew(input) {
  if (input == null || input === '') return null;
  if (input === 'Y' || input === 'N') return input;
  if (input === true || input === 1 || input === '1' || input === 'true') return 'Y';
  if (input === false || input === 0 || input === '0' || input === 'false') return 'N';
  if (typeof input === 'object') {
    const className = String(input.className || input.class || '');
    const attrs = input.attributes || {};
    if (
      /\bnew-version\b/.test(className) ||
      attrs['data-new'] === 'true' ||
      attrs['data-is-new'] === 'Y' ||
      input.isNew === true
    )
      return 'Y';
    if ('className' in input || 'class' in input || input.attributes) return 'N';
    return null;
  }
  const text = String(input);
  if (/\bnew-version\b/.test(text) || text === '新教材') return 'Y';
  return null;
}

function sameValue(left, right) {
  if (left == null && right == null) return true;
  return String(left) === String(right);
}

function textbookRawJson(textbook) {
  return JSON.stringify({
    href: textbook.href,
    sourceUrl: textbook.sourceUrl,
    qbmid: textbook.qbmid,
    ...(textbook.raw && typeof textbook.raw === 'object' ? textbook.raw : {}),
  });
}

function textbookListSignature(items) {
  return (items || []).map((item) => `${item.externalTextbookId || ''}:${item.textbookName || ''}`).join('|');
}

function normalizeVersionRecords(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new StopCrawlError('版本列表为空，可能发生页面契约变化。', 'version_contract');
  }
  return items.map((item, index) => {
    const versionName = normalizeWhitespace(item.versionName || item.text || '');
    if (!versionName) {
      throw new StopCrawlError('版本名称为空，可能发生页面契约变化。', 'version_contract');
    }
    const rawId = item.externalVersionId == null ? '' : String(item.externalVersionId).trim();
    return {
      externalVersionId: rawId || null,
      versionName,
      isNew: normalizeIsNew(item),
      sortOrder: item.sortOrder ?? index,
      sourceUrl: item.sourceUrl || null,
      selected: Boolean(item.selected),
      raw: item,
    };
  });
}

function normalizeTextbookRecords(items, options = {}) {
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0 && !options.allowEmpty) {
    throw new StopCrawlError('教材列表为空，可能发生页面契约变化。', 'textbook_contract');
  }
  return rows.map((item, index) => {
    const textbookName = normalizeWhitespace(item.textbookName || item.text || '');
    if (!textbookName) {
      throw new StopCrawlError('教材名称为空，可能发生页面契约变化。', 'textbook_contract');
    }
    const rawId = item.externalTextbookId == null ? '' : String(item.externalTextbookId).trim();
    const parsed = parseGradeVolume(textbookName);
    const href = item.href || item.attributes?.href || null;
    return {
      externalTextbookId: rawId || null,
      versionExternalId: options.versionExternalId || item.versionExternalId || null,
      textbookName,
      grade: parsed.grade,
      volume: parsed.volume,
      href,
      sourceUrl: textbookSourceUrl({ ...item, href, externalTextbookId: rawId || null }, options),
      qbmid: item.qbmid || item.attributes?.['data-qbmid'] || null,
      sortOrder: item.sortOrder ?? index,
      bootstrapChapterExternalId: item.bootstrapChapterExternalId || null,
      selected: Boolean(item.selected),
      raw: item,
    };
  });
}

function parseVersionsFromHtml(html, extra = {}) {
  const inner = sliceElementById(html, 'chapter_textbook_version');
  if (inner == null) {
    throw new StopCrawlError('页面缺少版本选择区域 #chapter_textbook_version。', 'version_contract');
  }
  const raw = parseAnchors(inner).map((anchor, index) => ({
    externalVersionId:
      anchor.attributes.versionid ||
      anchor.attributes['data-versionid'] ||
      anchor.attributes['data-version-id'] ||
      null,
    versionName: anchor.text,
    className: anchor.className,
    selected: /\bselected\b/.test(anchor.className),
    urlTemplate: anchor.attributes.url || null,
    href: anchor.attributes.href || null,
    qbmid: anchor.attributes['data-qbmid'] || null,
    sortOrder: index,
    sourceUrl: extra.sourceUrl || null,
    attributes: anchor.attributes,
  }));
  return normalizeVersionRecords(raw);
}

function parseTextbooksFromApiHtml(html, options = {}) {
  const text = String(html || '');
  const protection = classifyHtmlProtection(text);
  if (protection.terminalBlock || (protection.transientChallenge && !protection.hasContent)) {
    throw new StopCrawlError(protectionStopMessage(protection), 'challenge');
  }
  const wrapped =
    sliceElementById(text, 'chapter_textbooks') == null ? `<div id="chapter_textbooks">${text}</div>` : text;
  return parseTextbooksFromHtml(wrapped, options);
}

function parseTextbooksFromHtml(html, options = {}) {
  const inner = sliceElementById(html, 'chapter_textbooks');
  if (inner == null) {
    throw new StopCrawlError('页面缺少教材选择区域 #chapter_textbooks。', 'textbook_contract');
  }
  const raw = parseAnchors(inner)
    .map((anchor, index) => {
      const href = anchor.attributes.href || '';
      const fromHref = href.match(/\/zj(\d+)\b/);
      return {
        externalTextbookId: anchor.attributes['chapter-id'] || (fromHref ? fromHref[1] : null),
        textbookName: anchor.text,
        href,
        qbmid: anchor.attributes['data-qbmid'] || null,
        selected: /\bselected\b/.test(anchor.className),
        className: anchor.className,
        sortOrder: index,
        attributes: anchor.attributes,
      };
    })
    .filter((item) => item.textbookName && !item.textbookName.includes('加载中'));
  return normalizeTextbookRecords(raw, options);
}

function parseBootstrapChapterFromHtml(html) {
  const treeOpen = html.match(/<div\b[^>]*\btk-tree\b[^>]*>/i);
  const treeIdFromClassFirst = treeOpen?.[0].match(/\btree-id="([^"]+)"/i)?.[1] || null;
  const level1 =
    html.match(/<li\b[^>]*\bdata-level="1"[^>]*>/i) ||
    html.match(/<li\b[^>]*\btree-id="[^"]+"[^>]*\bdata-level="1"[^>]*>/i);
  const bootstrapFromLevel =
    level1?.[0].match(/\btree-id="([^"]+)"/i)?.[1] ||
    html.match(/<li\b[^>]*\btree-id="([^"]+)"[^>]*\bdata-level="1"/i)?.[1] ||
    null;
  const fallbackLevel = html.match(/<li\b[^>]*\bdata-level="1"[^>]*\btree-id="([^"]+)"/i)?.[1] || null;
  return {
    textbookTreeId: treeIdFromClassFirst,
    bootstrapChapterExternalId: bootstrapFromLevel || fallbackLevel || null,
  };
}

function emptyValidation() {
  return { missingIds: [], duplicateIds: [], missingBootstrapChapters: [] };
}

function validateDiscovery(versions, textbooks) {
  const validation = emptyValidation();
  const versionIds = new Map();
  const textbookIds = new Map();
  for (const version of versions || []) {
    if (!isStableExternalId(version.externalVersionId)) {
      validation.missingIds.push({
        type: 'version',
        name: version.versionName,
        value: version.externalVersionId,
      });
    } else if (versionIds.has(version.externalVersionId)) {
      validation.duplicateIds.push({ type: 'version', id: version.externalVersionId });
    } else {
      versionIds.set(version.externalVersionId, version);
    }
  }
  for (const textbook of textbooks || []) {
    if (!isStableExternalId(textbook.externalTextbookId)) {
      validation.missingIds.push({
        type: 'textbook',
        name: textbook.textbookName,
        value: textbook.externalTextbookId,
      });
    } else if (textbookIds.has(textbook.externalTextbookId)) {
      validation.duplicateIds.push({ type: 'textbook', id: textbook.externalTextbookId });
    } else {
      textbookIds.set(textbook.externalTextbookId, textbook);
    }
    if (!isStableExternalId(textbook.bootstrapChapterExternalId)) {
      validation.missingBootstrapChapters.push({
        externalTextbookId: textbook.externalTextbookId,
        textbookName: textbook.textbookName,
      });
    }
  }
  return validation;
}

function assertDiscoveryIds(versions, textbooks) {
  const validation = validateDiscovery(versions, textbooks);
  if (validation.missingIds.length > 0) {
    throw new StopCrawlError(
      `缺少稳定来源 ID，已停止且未伪造 ID：${validation.missingIds
        .map((item) => `${item.type}:${item.name || item.value || '(空)'}`)
        .join('、')}`,
      'missing_external_id',
    );
  }
  if (validation.duplicateIds.length > 0) {
    throw new StopCrawlError(
      `来源 ID 重复：${validation.duplicateIds.map((item) => `${item.type}:${item.id}`).join('、')}`,
      'duplicate_external_id',
    );
  }
  return validation;
}

function classifyChange(existing, next, fields) {
  if (!existing) return 'inserted';
  const changed = fields.some((field) => !sameValue(existing[field], next[field]));
  return changed ? 'updated' : 'unchanged';
}

module.exports = {
  assertDiscoveryIds,
  classifyChange,
  emptyValidation,
  normalizeIsNew,
  normalizeTextbookRecords,
  normalizeVersionRecords,
  parseBootstrapChapterFromHtml,
  parseGradeVolume,
  parseTextbooksFromApiHtml,
  parseTextbooksFromHtml,
  parseVersionsFromHtml,
  sameValue,
  textbookListSignature,
  textbookRawJson,
  validateDiscovery,
};
