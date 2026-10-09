import assert from 'node:assert/strict'
import { runCoverageView } from '../../../plugins/bank/utils/run-coverage.js'

const evidence = { format: 'run-coverage-v1', sourceReport: { count: 40000, observedAt: '2026-10-01T00:00:00Z' },
  collectedQuestionCount: 30000, scan: { targetsKnown: true, selectedCatalogCount: 5,
    availableCatalogCount: 8,
    scanCompletedCatalogCount: 3, unscannedCatalogCount: 2, failedPageCount: 1,
    parseErrorCount: 0, assetErrorCount: 0, duplicatePageCount: 0 } }
const view = runCoverageView(evidence)
assert.equal(view.sourceCount, 40000)
assert.equal(view.difference, 10000)
assert.equal(view.unscanned, 2)
assert.equal(view.available, 8)
assert.equal(view.assetErrors, 0)
// Missing evidence stays unknown. A legacy aggregate cannot imply all targets were scanned.
const unknown = runCoverageView({ ...evidence, sourceReport: {},
  scan: { targetsKnown: false, scanCompletedCatalogCount: 20, failedPageCount: null } })
assert.equal(unknown.sourceCount, null)
assert.equal(unknown.difference, null)
assert.equal(unknown.scanned, null)
assert.equal(unknown.available, null)
assert.equal(unknown.unscanned, null)
assert.equal(unknown.failedPages, null)
assert.equal(runCoverageView(null), null)
const zero = runCoverageView({ ...evidence, sourceReport: { count: 0 }, collectedQuestionCount: 0 })
assert.equal(zero.sourceCount, 0)
assert.equal(zero.difference, 0)
const newer = runCoverageView({ ...evidence, collectedQuestionCount: 41000 })
assert.equal(newer.difference, -1000) // Never clamp this to a fabricated missing-question count.
const limited = runCoverageView({ ...evidence,
  scan: { ...evidence.scan, maxPages: 30, startPage: 2, questionLimit: 1000, catalogSelectionTruncated: true } })
assert.equal(limited.limits.length, 4)
console.log('run coverage: unknown, zero, count difference and scope limits passed')
