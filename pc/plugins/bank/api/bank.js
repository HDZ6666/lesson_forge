import request from "@/utils/request";

export const listSubjects = (query) => request({ url: '/bank/subject/list', method: 'get', params: query });
export const listSourceProfiles = () => request({ url: '/bank/subject/profiles', method: 'get' });
export const addSubject = (data) => request({ url: '/bank/subject', method: 'post', data });
export const updateSubject = (data) => request({ url: '/bank/subject', method: 'put', data });

// 题库接口。数组参数由 request 拦截器按重复键编码，兼容 FastAPI list 字段。
export function listVersions(query) {
  return request({
    url: "/bank/version/list",
    method: "get",
    params: query,
  });
}

export function getVersion(versionId) {
  return request({ url: `/bank/version/${encodeURIComponent(versionId)}`, method: "get" });
}

export function addVersion(data) {
  return request({ url: "/bank/version", method: "post", data });
}

export function updateVersion(data) {
  return request({ url: "/bank/version", method: "put", data });
}

export function deleteVersions(versionIds) {
  return request({ url: `/bank/version/${versionIds.join(",")}`, method: "delete" });
}

export function listTextbooks(query) {
  return request({
    url: "/bank/textbook/list",
    method: "get",
    params: query,
  });
}

export function getTextbook(textbookId) {
  return request({ url: `/bank/textbook/${encodeURIComponent(textbookId)}`, method: "get" });
}

export function addTextbook(data) {
  return request({ url: "/bank/textbook", method: "post", data });
}

export function updateTextbook(data) {
  return request({ url: "/bank/textbook", method: "put", data });
}

export function deleteTextbooks(textbookIds) {
  return request({ url: `/bank/textbook/${textbookIds.join(",")}`, method: "delete" });
}

export function listCatalog(query) {
  return request({
    url: "/bank/catalog/tree",
    method: "get",
    params: query,
  });
}

export function listCatalogPage(query) {
  return request({ url: "/bank/catalog/list", method: "get", params: query });
}

export function getCatalog(catalogId) {
  return request({ url: `/bank/catalog/${encodeURIComponent(catalogId)}`, method: "get" });
}

export function addCatalog(data) {
  return request({ url: "/bank/catalog", method: "post", data });
}

export function updateCatalog(data) {
  return request({ url: "/bank/catalog", method: "put", data });
}

export function deleteCatalogs(catalogIds) {
  return request({ url: `/bank/catalog/${catalogIds.join(",")}`, method: "delete" });
}

export function listQuestions(query) {
  return request({
    url: "/bank/question/list",
    method: "get",
    params: query,
  });
}

export function addQuestion(data) {
  return request({ url: "/bank/question", method: "post", data });
}

export function updateQuestion(data) {
  return request({ url: "/bank/question", method: "put", data });
}

export function updateQuestionStatus(questionId, status) {
  return request({ url: `/bank/question/${encodeURIComponent(questionId)}/status/${status}`, method: "put" });
}

export function deleteQuestions(questionIds) {
  return request({ url: `/bank/question/${questionIds.join(",")}`, method: "delete" });
}

export function getQuestion(questionId) {
  return request({
    url: "/bank/question/" + questionId,
    method: "get",
  });
}

export function listQuestionAssets(questionId) {
  return request({
    url: "/bank/question/" + questionId + "/asset/list",
    method: "get",
  });
}

export function listAssets(query) {
  return request({
    url: "/bank/asset/list",
    method: "get",
    params: query,
  });
}

export function getQuestionAsset(questionId, assetKey) {
  return request({
    url: "/bank/question/" + encodeURIComponent(questionId) + "/asset/" + encodeURIComponent(assetKey),
    method: "get",
    responseType: "blob",
  });
}

export function getBatch(batchId) {
  return request({
    url: "/bank/batch/" + encodeURIComponent(batchId),
    method: "get",
  });
}

export function listBatches(query) {
  return request({
    url: "/bank/batch/list",
    method: "get",
    params: query,
  });
}

export function approveBatch(batchId, data) {
  return request({
    url: "/bank/batch/" + batchId + "/approve",
    method: "post",
    data: data,
  });
}

export function publishBatch(batchId, data) {
  return request({
    url: "/bank/batch/" + batchId + "/publish",
    method: "post",
    data: data,
  });
}

export function rollbackBatch(batchId, data) {
  return request({
    url: "/bank/batch/" + batchId + "/rollback",
    method: "post",
    data: data,
  });
}

// 同步采集库候选数据的对比与审核接口。
export function listSyncComparisons(entityType, query) {
  return request({
    url: `/bank/sync/${encodeURIComponent(entityType)}/compare`,
    method: "get",
    params: query,
  });
}

export function reviewSyncItems(entityType, data) {
  return request({
    url: `/bank/sync/${encodeURIComponent(entityType)}/review`,
    method: "post",
    data,
  });
}

// 同步运行任务接口。抓取只写入来源候选库，审核和发布仍由独立流程完成。
const syncRunBaseUrl = "/bank/sync/run";

/**
 * Start the metadata-only phase.  Keeping task construction here prevents
 * views from accidentally starting the legacy all-content crawl.
 */
export function startMetadataSyncRun(options = {}) {
  return request({
    url: `${syncRunBaseUrl}/metadata/start`,
    method: "post",
    data: {
    acknowledgeSourcePolicy: true,
    ...options,
    },
  });
}

/**
 * Start one content task for the explicitly selected textbooks.  The server
 * owns the catalog/question traversal; the UI only submits the snapshot and
 * stable source IDs that define the requested scope.
 */
export function startContentSyncRun({
  metadataRunId,
  textbookExternalIds = [],
  acknowledgeSourcePolicy = true,
} = {}) {
  return request({
    url: `${syncRunBaseUrl}/content/start`,
    method: "post",
    data: {
      metadataRunId,
      textbookExternalIds: [...new Set(textbookExternalIds.filter((id) => id !== undefined && id !== null && String(id).trim() !== '').map((id) => String(id)))],
      acknowledgeSourcePolicy,
    },
  });
}

/** Return the exact latest (or requested) metadata snapshot used by content selection. */
export function getMetadataSyncSnapshot(metadataRunId) {
  return request({
    url: "/bank/sync/metadata/snapshot",
    method: "get",
    params: metadataRunId ? { metadataRunId } : undefined,
  });
}

/**
 * Return the full metadata comparison used by the read-only textbook sync
 * overview.  Unlike the sync centre snapshot, this response contains both
 * the latest fetched tree and the complete current formal tree.
 */
export function getMetadataTextbookOverview(metadataRunId) {
  return request({
    url: "/bank/sync/metadata/textbook-overview",
    method: "get",
    params: metadataRunId ? { metadataRunId } : undefined,
  });
}

export function getCatalogProgress() {
  return request({
    url: "/bank/sync/catalog-progress",
    method: "get",
  });
}

export function getCurrentSyncRun() {
  return request({
    url: `${syncRunBaseUrl}/current`,
    method: "get",
  });
}

export function getSyncRun(runId) {
  return request({
    url: `${syncRunBaseUrl}/${encodeURIComponent(runId)}`,
    method: "get",
  });
}

export function listSyncRuns(query) {
  return request({
    url: `${syncRunBaseUrl}/list`,
    method: "get",
    params: query,
  });
}

export function cancelSyncRun(runId) {
  return request({
    url: `${syncRunBaseUrl}/${encodeURIComponent(runId)}/cancel`,
    method: "post",
  });
}

// 独立的同步教材任务。这些接口与原同步中心的 /bank/sync/run/* 并行存在。
const textbookSyncTaskBaseUrl = "/bank/sync/textbook/tasks";

export function createTextbookSyncTask(data = {}) {
  return request({
    url: textbookSyncTaskBaseUrl,
    method: "post",
    // The frozen create contract intentionally contains only the explicit
    // source-policy acknowledgement.  Do not forward view state or future
    // collector options from callers.
    data: {
      acknowledgeSourcePolicy: data?.acknowledgeSourcePolicy === true,
    },
  });
}

export function listTextbookSyncTasks(query) {
  return request({
    url: textbookSyncTaskBaseUrl,
    method: "get",
    params: query,
  });
}

export function getTextbookSyncTask(taskId) {
  return request({
    url: `${textbookSyncTaskBaseUrl}/${encodeURIComponent(taskId)}`,
    method: "get",
  });
}

export function getTextbookSyncTaskComparison(taskId) {
  return request({
    url: `${textbookSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/comparison`,
    method: "get",
  });
}

export function applyTextbookSyncTask(taskId, expectedCurrentTaskId = null) {
  return request({
    url: `${textbookSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/apply`,
    method: "post",
    data: { expectedCurrentTaskId },
  });
}

export function cancelTextbookSyncTask(taskId) {
  return request({
    url: `${textbookSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/cancel`,
    method: "post",
  });
}

export function retryTextbookSyncTask(taskId) {
  return request({
    url: `${textbookSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/retry`,
    method: "post",
  });
}

export function deleteTextbookSyncTask(taskId) {
  return request({
    url: `${textbookSyncTaskBaseUrl}/${encodeURIComponent(taskId)}`,
    method: "delete",
  });
}

// 独立的同步题库任务。创建任务时前端只提交本地 versionId/textbookIds。
const questionSyncTaskBaseUrl = "/bank/sync/question/tasks";

export function getQuestionSyncOptions() {
  return request({
    url: "/bank/sync/question/options",
    method: "get",
  });
}

export function createQuestionSyncTask(data) {
  const textbookIds = Array.isArray(data?.textbookIds)
    ? data.textbookIds
    : [data?.textbookId];
  if (textbookIds.length !== 1 || !Number.isSafeInteger(Number(textbookIds[0])) || Number(textbookIds[0]) <= 0) {
    return Promise.reject(new Error('一次同步任务请选择一本教材'));
  }
  const requestConfig = {
    url: questionSyncTaskBaseUrl,
    method: "post",
    // The question-task endpoint accepts the formal selection plus the
    // optional per-task page policy. The server resolves provider IDs and
    // collector runs from formal data.
    data: {
      versionId: data?.versionId,
      textbookId: Number(textbookIds[0]),
    },
  };
  if (data?.limitTo1000Pages === true) requestConfig.data.limitTo1000Pages = true;
  return request(requestConfig);
}

export function listQuestionSyncTasks(query) {
  return request({
    url: questionSyncTaskBaseUrl,
    method: "get",
    params: query,
  });
}

export function getQuestionSyncTask(taskId) {
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}`,
    method: "get",
  });
}

export function requestQuestionIncrementalImport(taskId) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/import`, method: 'post' });
}

export function retryQuestionImportIntake(taskId) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/import-intake/retry`, method: 'post' });
}

export function listQuestionImports(taskId, params) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/imports`, method: 'get', params });
}

export function listQuestionImportBatches(taskId, importId, params) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/imports/${encodeURIComponent(importId)}/batches`, method: 'get', params });
}

export function listQuestionImportIssues(taskId, importId, params) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/imports/${encodeURIComponent(importId)}/issues`, method: 'get', params });
}

// Apply the immutable question snapshot to the formal question-bank tables.
// Question scopes have independent current snapshots, so the preferred
// optimistic-concurrency value is expectedStateToken (a map for a
// multi-textbook task).  Keep expectedCurrentTaskId for older backends.
export function applyQuestionSyncTask(taskId, expectedCurrentTaskId = null, expectedStateToken = null) {
  let expectedReviewRevision = null
  // Also accept a single options object for callers that already have the
  // normalized task status at hand.
  if (expectedCurrentTaskId && typeof expectedCurrentTaskId === 'object' && !Array.isArray(expectedCurrentTaskId)) {
    expectedReviewRevision = expectedCurrentTaskId.expectedReviewRevision ?? null
    expectedStateToken = expectedCurrentTaskId.expectedStateToken ?? expectedCurrentTaskId.expected_state_token ?? null
    expectedCurrentTaskId = expectedCurrentTaskId.expectedCurrentTaskId ?? expectedCurrentTaskId.expected_current_task_id ?? null
  }
  const data = { expectedCurrentTaskId }
  if (expectedReviewRevision !== null) data.expectedReviewRevision = expectedReviewRevision
  if (expectedStateToken !== null && expectedStateToken !== undefined) data.expectedStateToken = expectedStateToken
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/apply`,
    method: "post",
    data,
  });
}

export function getQuestionReviewCatalogs(taskId, query) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/review/catalogs`, method: 'get', params: query });
}
export function getQuestionReviewQuestions(taskId, query) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/review/questions`, method: 'get', params: query, timeout: 35000 });
}
export function getQuestionReviewDetail(taskId, externalId, query) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/review/questions/${encodeURIComponent(externalId)}`, method: 'get', params: query, timeout: 35000 });
}
export function setQuestionReviewSelection(taskId, data, query) {
  return request({ url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/review/selection`, method: 'post', params: query, data });
}

export function getQuestionSyncCatalogComparison(taskId, query) {
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/catalog-comparison`,
    method: "get",
    params: query,
  });
}

export function getQuestionSyncQuestionComparison(taskId, query) {
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/question-comparison`,
    method: "get",
    params: query,
  });
}

export function getQuestionSyncQuestionDetail(taskId, externalId, query) {
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/questions/${encodeURIComponent(externalId)}`,
    method: "get",
    params: query,
  });
}

export function cancelQuestionSyncTask(taskId) {
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/cancel`,
    method: "post",
  });
}

export function retryQuestionSyncTask(taskId) {
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/retry`,
    method: "post",
  });
}

// Resume the interrupted question task in place.  The server creates the
// collector run and preserves the existing task ID, snapshot and checkpoint.
export function resumeQuestionSyncTask(taskId) {
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}/resume`,
    method: "post",
  });
}

export function deleteQuestionSyncTask(taskId) {
  return request({
    url: `${questionSyncTaskBaseUrl}/${encodeURIComponent(taskId)}`,
    method: "delete",
  });
}
