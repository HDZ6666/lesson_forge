import request from '@/utils/request'

const baseUrl = '/lesson/plan'

export function getPlanOptions() {
  return request({ url: `${baseUrl}/options`, method: 'get' })
}

export function listPlanVersions(query) {
  return request({ url: `${baseUrl}/versions`, method: 'get', params: query })
}

export function listPlanTextbooks(query) {
  return request({ url: `${baseUrl}/textbooks`, method: 'get', params: query })
}

export function getPlanCatalogTree(textbookId) {
  return request({ url: `${baseUrl}/catalog-tree`, method: 'get', params: { textbookId } })
}

export function getDefaultRules(data) {
  return request({ url: `${baseUrl}/rules/default`, method: 'post', data })
}

export function simulateRules(data) {
  return request({ url: `${baseUrl}/simulate`, method: 'post', data })
}

export function generatePlan(data) {
  return request({ url: `${baseUrl}/generate`, method: 'post', data })
}

export function listGenerations(query) {
  return request({ url: `${baseUrl}/generation/list`, method: 'get', params: query })
}

export function getGeneration(generationId) {
  return request({ url: `${baseUrl}/generation/${encodeURIComponent(generationId)}`, method: 'get' })
}

export function regeneratePlan(generationId) {
  return request({ url: `${baseUrl}/generation/${encodeURIComponent(generationId)}/regenerate`, method: 'post' })
}

export function replaceGenerationItem(generationId, itemId) {
  return request({
    url: `${baseUrl}/generation/${encodeURIComponent(generationId)}/items/${encodeURIComponent(itemId)}/replace`,
    method: 'post',
  })
}

export function updateGenerationText(generationId, data) {
  return request({ url: `${baseUrl}/generation/${encodeURIComponent(generationId)}/text`, method: 'put', data })
}

export function deleteGenerations(generationIds) {
  return request({ url: `${baseUrl}/generation/${generationIds.join(',')}`, method: 'delete' })
}

// 导出与题图都是二进制：走带鉴权头的 request，由调用方转成 Blob URL 或保存文件。
export function exportGeneration(generationId) {
  return request({
    url: `${baseUrl}/generation/${encodeURIComponent(generationId)}/export`,
    method: 'get',
    responseType: 'blob',
    timeout: 120000,
  })
}

export function getPlanAsset(questionId, assetKey) {
  return request({
    url: `${baseUrl}/asset/${encodeURIComponent(questionId)}/${encodeURIComponent(assetKey)}`,
    method: 'get',
    responseType: 'blob',
  })
}
