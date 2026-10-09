import { defineConfig } from 'vite'
import baseConfig from './vite.config'

// Local-only frontend preview for the isolated refactor service.
export default defineConfig((context) => {
  process.env.VITE_APP_TITLE = '教案系统 · 重构预览'
  const config = baseConfig(context)
  config.define = { ...config.define, 'import.meta.env.VITE_APP_BASE_API': JSON.stringify('/dev-api') }
  config.server = {
    ...config.server, host: '127.0.0.1', port: 18080, strictPort: true, open: false,
    proxy: { '/dev-api': { target: 'http://127.0.0.1:19099', changeOrigin: true,
      rewrite: (path) => path.replace(/^\/dev-api/, '') } },
  }
  return config
})
