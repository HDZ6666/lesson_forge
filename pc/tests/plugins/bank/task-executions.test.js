import assert from 'node:assert/strict'
import {executionSummary, executionLabel} from '../../../plugins/bank/utils/task-executions.js'
assert.equal(executionSummary({executionCount:2,status:'queued'}),'已执行 2 次，第 3 次待执行')
assert.equal(executionSummary({executionCount:2,status:'running',startedAt:'now'}),'已执行 2 次')
assert.equal(executionLabel({status:'cancelled'},2),'未启动')
assert.equal(executionLabel({executionNumber:2},2),'第 2 次')
