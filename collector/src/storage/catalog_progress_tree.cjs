'use strict';

/**
 * Pure projection of catalog nodes + question memberships + per-catalog page
 * stats into the nested progress tree shown by /v1/catalog-progress and the
 * legacy collector.  Unique question counts roll up over descendants.
 */

function buildCatalogProgressTree({
  nodes = [],
  memberships = [],
  stats = {},
  currentByCatalog = {},
} = {}) {
  const questionsByCatalog = new Map();
  for (const row of memberships) {
    const catalogId = String(row.catalogExternalId || '');
    const questionId = String(row.questionExternalId || '');
    if (!catalogId || !questionId) continue;
    if (!questionsByCatalog.has(catalogId)) questionsByCatalog.set(catalogId, new Set());
    questionsByCatalog.get(catalogId).add(questionId);
  }
  const byId = new Map();
  const childrenOf = new Map();
  for (const node of nodes) {
    const id = String(node.externalId);
    byId.set(id, node);
    const parentId = node.parentExternalId ? String(node.parentExternalId) : '';
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
    childrenOf.get(parentId).push(id);
  }
  const descendantCache = new Map();
  const descendantIds = (id) => {
    if (descendantCache.has(id)) return descendantCache.get(id);
    const ids = [id];
    for (const childId of childrenOf.get(id) || []) ids.push(...descendantIds(childId));
    descendantCache.set(id, ids);
    return ids;
  };
  const uniqueCount = (ids) => {
    const seen = new Set();
    for (const id of ids) {
      const questions = questionsByCatalog.get(id);
      if (!questions) continue;
      for (const questionId of questions) seen.add(questionId);
    }
    return seen.size;
  };
  const buildNode = (id) => {
    const node = byId.get(id);
    const stat = stats[id] || {};
    const expectedTotal = stat.expectedTotal == null ? null : Number(stat.expectedTotal);
    const expectedPages = stat.expectedPages == null ? null : Number(stat.expectedPages);
    const lastCompletedPage = Number(stat.lastCompletedPage || 0);
    const crawledUnique = uniqueCount(descendantIds(id));
    return {
      externalId: id,
      name: node.name,
      level: Number(node.level || 0),
      path: node.path || node.name,
      parentExternalId: node.parentExternalId ? String(node.parentExternalId) : null,
      expectedTotal,
      expectedPages,
      lastCompletedPage,
      crawledUnique,
      current: currentByCatalog[id] || null,
      children: (childrenOf.get(id) || []).map(buildNode),
    };
  };
  const roots = [];
  const seenRoot = new Set();
  for (const node of nodes) {
    const id = String(node.externalId);
    const parentId = node.parentExternalId ? String(node.parentExternalId) : '';
    if (parentId && byId.has(parentId)) continue;
    if (seenRoot.has(id)) continue;
    seenRoot.add(id);
    roots.push(buildNode(id));
  }
  const walkPages = (list, key) => list.reduce((sum, node) => (
    sum + Number(node[key] || 0) + walkPages(node.children, key)
  ), 0);
  const pagesDone = walkPages(roots, 'lastCompletedPage');
  const pagesTotal = walkPages(roots, 'expectedPages');
  return {
    questionUnique: uniqueCount(nodes.map((node) => String(node.externalId))),
    catalogCount: nodes.length,
    pagesDone,
    pagesTotal,
    progressPercent: pagesTotal > 0
      ? Math.min(100, Math.round((Math.min(pagesDone, pagesTotal) / pagesTotal) * 1000) / 10)
      : null,
    current: Object.values(currentByCatalog),
    catalogs: roots,
  };
}

module.exports = { buildCatalogProgressTree };
