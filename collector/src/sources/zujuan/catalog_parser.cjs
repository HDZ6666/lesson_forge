'use strict';

/**
 * Pure parser for the provider's static textbook catalog tree JSON
 * (`static.zxxk.com/zujuan/tree/ct_{bank}_{textbook}.json`).
 */

const { QuestionSyncError } = require('../../shared/errors.cjs');
const { normalizeId, normalizeWhitespace } = require('../../shared/utils.cjs');
const {
  DEFAULT_BANK_ID,
  DEFAULT_BANK_PATH,
  DEFAULT_TEXTBOOK_ID,
} = require('./constants.cjs');
const { parseCatalogQueryFromHref } = require('./urls.cjs');

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

module.exports = {
  normalizeCatalogTree,
  parseCatalogRoot,
  selectCatalogs,
};
