import { onBeforeUnmount, reactive } from 'vue'

const MAX_CONCURRENT_DOWNLOADS = 4

function available(asset) {
  const status = String(asset?.downloadStatus || '').toLowerCase()
  return Boolean(asset?.storagePath && asset?.assetKey && ['ready', 'downloaded'].includes(status))
}

// Each detail drawer owns its Blob URLs. A later question invalidates pending
// downloads and revokes the previous URLs, including late responses.
export function createQuestionAssetStore(fetchAsset) {
  const urls = reactive({})
  const states = reactive({})
  let generation = 0
  let activeQuestionId = null

  function reset() {
    generation += 1
    activeQuestionId = null
    for (const [key, url] of Object.entries(urls)) {
      if (url) URL.revokeObjectURL(url)
      delete urls[key]
    }
    for (const key of Object.keys(states)) delete states[key]
  }

  async function fetchOne(questionId, asset, current) {
    let url = ''
    try {
      const blob = await fetchAsset(questionId, asset.assetKey)
      if (!(blob instanceof Blob) || /application\/(json|problem\+json)/i.test(blob.type)) {
        throw new Error('素材响应不是可用文件')
      }
      url = URL.createObjectURL(blob)
      if (generation !== current) { URL.revokeObjectURL(url); return }
      const previous = urls[asset.assetKey]
      if (previous) URL.revokeObjectURL(previous)
      urls[asset.assetKey] = url
      states[asset.assetKey] = { status: 'ready', message: '' }
    } catch (error) {
      if (generation === current) states[asset.assetKey] = { status: 'failed', message: error?.message || '素材请求失败' }
    }
  }

  async function load(questionId, assets) {
    reset()
    activeQuestionId = questionId
    const current = generation
    const pending = (assets || []).filter(available)
    for (const asset of pending) states[asset.assetKey] = { status: 'loading', message: '' }
    let next = 0
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_DOWNLOADS, pending.length) }, async () => {
      while (next < pending.length) {
        const asset = pending[next++]
        if (generation !== current) return
        await fetchOne(questionId, asset, current)
      }
    }))
  }

  function resolve(asset) {
    return available(asset) ? urls[asset.assetKey] || '' : ''
  }

  function state(asset) {
    if (!available(asset)) return { status: 'notDownloaded', message: asset?.errorMessage || '素材尚未下载' }
    return states[asset.assetKey] || { status: 'loading', message: '' }
  }

  function label(asset) {
    const value = state(asset)
    if (value.status === 'loading') return '加载中'
    if (value.status === 'ready') return asset.assetType || asset.mimeType || '素材'
    return value.message
  }

  async function retry(asset) {
    if (!activeQuestionId || !available(asset) || state(asset).status !== 'failed') return
    states[asset.assetKey] = { status: 'loading', message: '' }
    await fetchOne(activeQuestionId, asset, generation)
  }

  return { load, reset, resolve, state, label, retry }
}

export function useQuestionAssetStore(fetchAsset) {
  const store = createQuestionAssetStore(fetchAsset)
  onBeforeUnmount(store.reset)
  return store
}
