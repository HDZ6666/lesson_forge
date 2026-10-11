import { onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue'

// Cached routes stay mounted. Poll only while this page and browser tab are visible.
export function usePollingLifecycle(start, stop) {
  let active = false
  let running = false
  function update() {
    const next = active && !document.hidden
    if (next === running) return
    running = next
    if (running) start()
    else stop()
  }
  function activate() { active = true; update() }
  function deactivate() { active = false; update() }
  onMounted(() => { document.addEventListener('visibilitychange', update); activate() })
  onActivated(activate)
  onDeactivated(deactivate)
  onBeforeUnmount(() => { deactivate(); document.removeEventListener('visibilitychange', update) })
}
