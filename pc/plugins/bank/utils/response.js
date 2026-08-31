/**
 * Normalize the response shapes used by RuoYi and by the bank endpoints.
 * The endpoint contract is allowed to return a page object directly, or
 * through the conventional data envelope.
 */
export function unwrapResponse(response) {
  if (response && response.data !== undefined && response.rows === undefined && response.list === undefined) {
    return response.data
  }
  return response
}

export function unwrapPage(response) {
  const value = unwrapResponse(response)
  if (Array.isArray(value)) return { rows: value, total: value.length }
  if (!value || typeof value !== 'object') return { rows: [], total: 0 }
  const rows = value.rows || value.list || value.records || value.items || []
  return {
    rows: Array.isArray(rows) ? rows : [],
    total: Number(value.total ?? value.totalCount ?? value.count ?? rows.length) || 0,
  }
}

export function unwrapList(response) {
  const value = unwrapResponse(response)
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  return value.rows || value.list || value.records || value.items || value.data || []
}

export function unwrapTree(response) {
  const value = unwrapResponse(response)
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.children)) return value.children
  return unwrapList(value)
}

export function toFieldValue(value, ...keys) {
  if (!value || typeof value !== 'object') return undefined
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key]
  }
  return undefined
}
