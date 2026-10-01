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
  let generation = 0

  function reset() {
    generation += 1
    for (const [key, url] of Object.entries(urls)) {
      if (url) URL.revokeObjectURL(url)
      delete urls[key]
    }
  }

  async function load(questionId, assets) {
    reset()
    const current = generation
    const pending = (assets || []).filter(available)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_DOWNLOADS, pending.length) }, async () => {
      while (next < pending.length) {
        const asset = pending[next++]
        let url = ''
        try {
          const blob = await fetchAsset(questionId, asset.assetKey)
          if (blob instanceof Blob) url = URL.createObjectURL(blob)
        } catch {
          // A missing asset stays visible in the list without a broken link.
        }
        if (generation !== current) {
          if (url) URL.revokeObjectURL(url)
          return
        }
        if (url) urls[asset.assetKey] = url
      }
    }))
  }

  function resolve(asset) {
    return available(asset) ? urls[asset.assetKey] || '' : ''
  }

  return { load, reset, resolve }
}

export function useQuestionAssetStore(fetchAsset) {
  const store = createQuestionAssetStore(fetchAsset)
  onBeforeUnmount(store.reset)
  return store
}
