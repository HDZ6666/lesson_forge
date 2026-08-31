const SAFE_TAGS = new Set([
  'A', 'B', 'BR', 'CODE', 'DEL', 'EM', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE',
  'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD',
  'TR', 'U', 'UL',
])
const SAFE_ATTRS = new Set(['alt', 'class', 'colspan', 'data-asset-key', 'height', 'href', 'rel', 'rowspan', 'target', 'title', 'width'])
const SAFE_PROTOCOLS = new Set(['http:', 'https:'])

function safeExternalUrl(value) {
  try {
    const parsed = new URL(value, window.location.origin)
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : ''
  } catch {
    return ''
  }
}

function cleanNode(node, assetResolver) {
  if (node.nodeType === 3) return node.cloneNode()
  if (node.nodeType !== 1) return document.createTextNode('')
  if (!SAFE_TAGS.has(node.tagName)) {
    const fragment = document.createDocumentFragment()
    for (const child of Array.from(node.childNodes)) fragment.append(cleanNode(child, assetResolver))
    return fragment
  }

  const result = document.createElement(node.tagName.toLowerCase())
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase()
    if (!SAFE_ATTRS.has(name) || name.startsWith('on') || name === 'style') continue
    if (name === 'href') {
      const href = safeExternalUrl(attr.value)
      if (!href) continue
      result.setAttribute('href', href)
      result.setAttribute('rel', 'noopener noreferrer nofollow')
      continue
    }
    if (name === 'data-asset-key') {
      const key = attr.value.trim()
      if (!key || !/^[a-zA-Z0-9._:-]{1,160}$/.test(key)) continue
      result.setAttribute(name, key)
      if (node.tagName === 'IMG' && typeof assetResolver === 'function') {
        const resolved = assetResolver(key)
        if (typeof resolved === 'string' && resolved.startsWith('/bank/question/')) {
          result.setAttribute('src', resolved)
        } else {
          const placeholder = document.createElement('span')
          placeholder.className = 'qb-asset-missing'
          placeholder.title = key
          placeholder.textContent = '[素材未下载]'
          return placeholder
        }
      }
      continue
    }
    if (name !== 'src') result.setAttribute(name, attr.value)
  }
  if (node.tagName === 'IMG') {
    result.setAttribute('loading', 'lazy')
    result.setAttribute('referrerpolicy', 'no-referrer')
  }
  for (const child of Array.from(node.childNodes)) result.append(cleanNode(child, assetResolver))
  return result
}

/**
 * Sanitize source HTML before it reaches v-html. Images are inert unless the
 * caller resolves their data-asset-key through the authenticated asset API.
 */
export function sanitizeHtml(value, assetResolver) {
  if (value === null || value === undefined) return ''
  const source = String(value)
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
    return source
      .replace(/<\/?(?:script|iframe|style|object|embed|svg|math)[^>]*>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(?:src|href)\s*=\s*(?:"\s*(?:javascript|data):[^\"]*"|'\s*(?:javascript|data):[^']*'|[^\s>]+)/gi, '')
  }
  const parsed = new DOMParser().parseFromString(`<div>${source}</div>`, 'text/html')
  const wrapper = document.createElement('div')
  for (const child of Array.from(parsed.body.firstElementChild?.childNodes || [])) wrapper.append(cleanNode(child, assetResolver))
  return wrapper.innerHTML
}

export function buildAssetUrl(questionId, assetKey) {
  if (questionId === undefined || questionId === null || !/^\d+$/.test(String(questionId)) || typeof assetKey !== 'string' || assetKey === '.' || assetKey === '..' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(assetKey)) return ''
  return `/bank/question/${encodeURIComponent(String(questionId))}/asset/${encodeURIComponent(assetKey)}`
}

export function resolveAssetUrl(asset, questionId) {
  const status = String(asset?.downloadStatus || '').toLowerCase()
  if (!asset?.storagePath || !['ready', 'downloaded'].includes(status)) return ''
  return buildAssetUrl(questionId, asset?.assetKey)
}
