const knownCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null

export function runCoverageView(value) {
  if (!value || value.format !== 'run-coverage-v1') return null
  const scan = value.scan || {}
  const sourceCount = knownCount(value.sourceReport?.count)
  const collectedCount = knownCount(value.collectedQuestionCount)
  const limits = []
  if (knownCount(scan.startPage) > 1) limits.push(`从第 ${scan.startPage} 页开始`)
  if (knownCount(scan.maxPages) > 0) limits.push(`每个目录最多 ${scan.maxPages} 页`)
  if (knownCount(scan.questionLimit) > 0) limits.push(`本次题目上限 ${scan.questionLimit}`)
  if (scan.catalogSelectionTruncated === true) limits.push('只选择了部分来源目录')
  return {
    sourceCount, collectedCount, observedAt: value.sourceReport?.observedAt || null,
    difference: sourceCount == null || collectedCount == null ? null : sourceCount - collectedCount,
    available: knownCount(scan.availableCatalogCount),
    targets: knownCount(scan.selectedCatalogCount),
    scanned: scan.targetsKnown ? knownCount(scan.scanCompletedCatalogCount) : null,
    unscanned: scan.targetsKnown ? knownCount(scan.unscannedCatalogCount) : null,
    failedPages: knownCount(scan.failedPageCount), parseErrors: knownCount(scan.parseErrorCount),
    assetErrors: knownCount(scan.assetErrorCount), duplicatePages: knownCount(scan.duplicatePageCount),
    limits,
  }
}
