'use strict';

/**
 * Pure parsers for the zujuan question list API.
 *
 * Input is the provider's JSON envelope / question card HTML; output is the
 * normalized question record consumed by the SQLite store and by qbpkg.  This
 * module performs no network or database access.
 */

const { QuestionSyncError } = require('../../shared/errors.cjs');
const {
  jsonStringify,
  normalizeId,
  normalizeWhitespace,
  sha256,
} = require('../../shared/utils.cjs');
const {
  absoluteUrl,
  attr,
  decodeHtmlEntities,
  elementText,
  findByAttribute,
  findByClass,
  findElements,
  firstByAttribute,
  firstByClass,
  hasClass,
  stripHtml,
} = require('../../shared/html.cjs');
const {
  assetKey: canonicalAssetKey,
  normalizeHtml: normalizePackageHtml,
} = require('../../qbpkg/normalize.cjs');
const { DEFAULT_BASE_URL } = require('./constants.cjs');

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
    contentComplete: Boolean(html || text)
      && Boolean(text || /<img\b[^>]*\bdata-asset-key=/i.test(html || ''))
      && normalizedContent.missingAssets.length === 0
      && normalizedContent.errors.length === 0,
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
  const parsed = parseQuestionListHtml(html, baseUrl);
  const ids = parsed.questionIds;
  if (ids.some((value) => !normalizeId(value))) {
    throw new QuestionSyncError('题目列表存在空题号。', 'list_api_contract');
  }
  if (new Set(ids).size !== ids.length) {
    throw new QuestionSyncError('题目列表单页含重复题目 ID。', 'page_duplicate_questions');
  }
  // `total` is display-only. A missing, non-integer, negative, or
  // self-contradictory value must not fail the page.
  let total = normalizeDisplayTotal(value.data.total);
  if (total === 0 && ids.length > 0) total = null;
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
  return { code: '0', total: normalizeDisplayTotal(value.data.total) };
}

function normalizeDisplayTotal(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return null;
  return number;
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

module.exports = {
  classifyAsset,
  countSubquestions,
  extractQuestionBlocks,
  finalizeQuestion,
  normalizeAssetType,
  normalizeDisplayTotal,
  normalizeQuestionContent,
  parseDifficulty,
  parseQuestionBlock,
  parseQuestionListHtml,
  parseQuestionListPayload,
  parseQuestionListTotalPayload,
  removeAssetImages,
  removeAssetImagesBySource,
  stripListOrdinal,
};
