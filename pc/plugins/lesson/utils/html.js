const SAFE_TAGS = new Set([
  'A', 'B', 'BR', 'CODE', 'DEL', 'EM', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE',
  'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD',
  'TR', 'U', 'UL',
])
const SAFE_ATTRS = new Set(['alt', 'class', 'colspan', 'data-asset-key', 'height', 'href', 'rel', 'rowspan', 'target', 'title', 'width'])
const ASSET_KEY_RE = /^[a-zA-Z0-9._:-]{1,160}$/

export function isSafeImageSource(value) {
  return typeof value === 'string' && (value.startsWith('blob:') || value.startsWith('/lesson/plan/asset/'))
}

function safeExternalUrl(value) {
  try {
    const parsed = new URL(value, window.location.origin)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : ''
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
      if (!ASSET_KEY_RE.test(key)) continue
      result.setAttribute(name, key)
      if (node.tagName === 'IMG') {
        const resolved = typeof assetResolver === 'function' ? assetResolver(key) : ''
        if (isSafeImageSource(resolved)) {
          result.setAttribute('src', resolved)
        } else {
          const placeholder = document.createElement('span')
          placeholder.className = 'lp-asset-missing'
          placeholder.title = key
          placeholder.textContent = resolved === 'loading' ? '[图片加载中]' : '[图]'
          return placeholder
        }
      }
      continue
    }
    result.setAttribute(name, attr.value)
  }
  if (node.tagName === 'IMG') {
    result.setAttribute('loading', 'lazy')
    result.setAttribute('referrerpolicy', 'no-referrer')
  }
  for (const child of Array.from(node.childNodes)) result.append(cleanNode(child, assetResolver))
  return result
}

/**
 * 题干 HTML 进入 v-html 前的白名单清洗。图片只允许 Blob URL 或本插件素材接口地址，
 * 其余一律替换为占位符，避免外链拉取来源站资源。
 */
export function sanitizeHtml(value, assetResolver) {
  if (value === null || value === undefined) return ''
  const source = String(value)
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
    return source
      .replace(/<\/?(?:script|iframe|style|object|embed|svg|math)[^>]*>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(?:src|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  }
  const parsed = new DOMParser().parseFromString(`<div>${source}</div>`, 'text/html')
  const wrapper = document.createElement('div')
  for (const child of Array.from(parsed.body.firstElementChild?.childNodes || [])) wrapper.append(cleanNode(child, assetResolver))
  return wrapper.innerHTML
}
