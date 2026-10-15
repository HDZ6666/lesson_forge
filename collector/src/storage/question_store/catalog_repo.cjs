'use strict';

/**
 * Catalog tree persistence: mutable textbook_nodes plus the immutable
 * per-run sync_run_catalog_items snapshot.
 *
 * Methods are mixed into QuestionSyncStore.prototype (see index.cjs); `this`
 * is the store instance (`this.db`, `this.dataDir`).
 */

const { jsonStringify, normalizeId, nowIso, sqliteValue } = require('../../shared/utils.cjs');
const { PROVIDER } = require('../../sources/zujuan/constants.cjs');

class CatalogRepoMethods {
  _insertCatalogNode(node, observedAt) {
    const externalId = normalizeId(node.externalId);
    if (!externalId || !node.name) return;
    this.db
      .prepare(
        `
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
    `,
      )
      .run(
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
        this.db
          .prepare(
            `
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
        `,
          )
          .run(
            Number(runId),
            PROVIDER,
            String(textbookId),
            externalId,
            sqliteValue(node.parentExternalId),
            sqliteValue(node.level),
            sqliteValue(node.type || node.nodeType),
            String(node.name),
            sqliteValue(node.sourcePath),
            sqliteValue(node.path || node.name),
            sqliteValue(node.sortOrder),
            observedAt,
            jsonStringify(node.raw || node),
            sqliteValue(node.categoryId),
            sqliteValue(node.catelogTokpointId),
            node.isKnowledge ? 1 : 0,
          );
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw error;
    }
  }
}

module.exports = { CatalogRepoMethods };
