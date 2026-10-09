import { syncTaskErrorMessage } from './sync-task.js'

const emptyPage = () => ({ items: [], page: {}, cursor: undefined, positions: [], loaded: false })
const unwrap = response => response?.data || response

export function createImportResultsState() {
  return {
    selectedId: undefined, selected: undefined, history: [], nextBeforeId: undefined,
    activeTab: 'batches', historyLoading: false, pageLoading: false, error: '',
    pages: { batches: emptyPage(), issues: emptyPage() },
  }
}

export function createImportResultsModel(api, state = createImportResultsState()) {
  let taskId, generation = 0, historyRevision = 0, pageRevision = 0

  async function loadHistory(more = false) {
    const targetTask = taskId, epoch = generation, revision = ++historyRevision
    state.historyLoading = true
    try {
      const data = unwrap(await api.history(targetTask, { beforeId: more ? state.nextBeforeId : undefined, pageSize: 20 }))
      if (epoch !== generation || revision !== historyRevision) return
      state.history = more ? [...state.history, ...data.items.filter(item => !state.history.some(row => row.importId === item.importId))] : data.items
      state.nextBeforeId = data.nextBeforeId
    } catch (cause) {
      if (epoch === generation && revision === historyRevision) state.error = syncTaskErrorMessage(cause, '入库历史加载失败')
    } finally {
      if (epoch === generation && revision === historyRevision) state.historyLoading = false
    }
  }

  async function loadPage(kind, cursor, positions) {
    const targetTask = taskId, importId = state.selectedId, epoch = generation, revision = ++pageRevision
    if (!importId) return false
    state.pageLoading = true; state.error = ''
    try {
      const data = unwrap(await api[kind](targetTask, importId, { cursor, pageSize: 20 }))
      if (epoch !== generation || revision !== pageRevision || importId !== state.selectedId) return false
      state.selected = data.import
      Object.assign(state.pages[kind], { items: data.items, page: data.page, cursor: data.page.cursor, positions, loaded: true })
      return true
    } catch (cause) {
      if (epoch === generation && revision === pageRevision) state.error = syncTaskErrorMessage(cause, '入库结果加载失败，已保留当前页')
      return false
    } finally {
      if (epoch === generation && revision === pageRevision) state.pageLoading = false
    }
  }

  function loadActive() {
    pageRevision += 1; state.pageLoading = false
    if (!state.pages[state.activeTab].loaded) return loadPage(state.activeTab, undefined, [])
  }

  function selectImport() {
    generation += 1; pageRevision += 1; historyRevision += 1
    state.pageLoading = false; state.historyLoading = false; state.error = ''
    state.selected = state.history.find(row => row.importId === state.selectedId)
    state.pages.batches = emptyPage(); state.pages.issues = emptyPage()
    return loadActive()
  }

  async function refresh() {
    const epoch = generation, kind = state.activeTab
    const [, refreshed] = await Promise.all([loadHistory(), loadPage(kind, undefined, [])])
    if (refreshed && epoch === generation) state.pages[kind === 'batches' ? 'issues' : 'batches'] = emptyPage()
  }

  function next() {
    const page = state.pages[state.activeTab]
    if (!page.page.nextCursor || state.pageLoading) return
    return loadPage(state.activeTab, page.page.nextCursor, [...page.positions, page.cursor])
  }

  function previous() {
    const page = state.pages[state.activeTab]
    if (!page.positions.length || state.pageLoading) return
    return loadPage(state.activeTab, page.positions.at(-1), page.positions.slice(0, -1))
  }

  async function reset(newTaskId, currentImportId) {
    taskId = newTaskId
    generation += 1; historyRevision += 1; pageRevision += 1
    state.selectedId = currentImportId; state.selected = undefined; state.history = []; state.nextBeforeId = undefined
    state.pages.batches = emptyPage(); state.pages.issues = emptyPage(); state.error = ''; state.pageLoading = false
    await Promise.all([loadHistory(), loadPage(state.activeTab, undefined, [])])
  }

  function dispose() { generation += 1; historyRevision += 1; pageRevision += 1 }
  return { state, reset, selectImport, loadHistory, loadActive, refresh, next, previous, dispose }
}
