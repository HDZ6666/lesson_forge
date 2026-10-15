import assert from 'node:assert/strict'
import { discoveryFailureText, isNewPlan, planBookStage, planProgress, planPhase } from '../../../plugins/bank/utils/sync-plan.js'
const book = { enabled: true, inCurrentCycle: true, taskInCurrentCycle: true }
const books = ['queued', 'collecting', 'checking', 'importing', 'completed', 'partial', 'failed'].map(taskStage => ({ ...book, taskStage }))
books.push({ ...book, enabled: false }, { ...book, inCurrentCycle: false })
const progress = planProgress(books)
assert.equal(progress.total, 8)
assert.equal(progress.finished, 4)
assert.equal(progress.completed, 1)
assert.equal(planBookStage({ ...book, taskStage: 'completed', taskInCurrentCycle: false }).key, 'queued')
assert.equal(planPhase({planId:1, enabled:true, cycleNo:1}, progress), '逐本同步中')
assert.equal(planPhase({planId:1, enabled:true, discoveryTaskId:5, discoveryStatus:'completed'}, progress), '登记教材清单')
assert.equal(planPhase({planId:1, enabled:false}, progress), '整个计划已暂停，队列和成果保留')

assert.equal(planPhase({planId:1, enabled:false, controlState:'pausing'}, progress), '正在停止采集、核验和入库，请等待当前工作收尾')
assert.equal(planPhase({planId:1, enabled:true, cycleState:'completed',autoUpdate:false},progress),'本轮处理完毕，自动更新关闭')
assert.equal(planProgress([{...book,taskStage:'paused'}]).paused,1)

assert.equal(planBookStage({...book, exceptionKind:'scope_failure'}).label, '故障隔离，待修复')
assert.equal(planPhase({planId:1,enabled:true,cycleNo:1,cycleState:'running'}, {finished:2,total:2}), '等待成果核验、入库或来源恢复')

// R13: a failed discovery with a known list continues; first-time and protection failures wait.
assert.match(discoveryFailureText({discoveryError:'接口超时',discoveryFailure:'stale_list'}), /清单未刷新，继续同步已知教材/)
assert.match(discoveryFailureText({discoveryError:'接口超时',discoveryFailure:'no_list'}), /尚未登记完整教材清单/)
assert.match(discoveryFailureText({discoveryError:'返回验证',discoveryFailure:'source_protection'}), /来源要求验证/)
assert.doesNotMatch(discoveryFailureText({discoveryError:'返回验证',discoveryFailure:'source_protection'}), /继续同步已知教材/)
assert.equal(planPhase({planId:1,enabled:true,cycleNo:2,cycleState:'running',discoveryError:'接口超时',discoveryFailure:'stale_list'},{finished:0,total:2}),'逐本同步中')
assert.equal(planPhase({planId:1,enabled:true,discoveryError:'接口超时',discoveryFailure:'no_list'},{finished:0,total:0}),'教材发现待处理')

// A newly recreated, paused plan has no prior queue to "continue".
const pristine = { planId: 2, enabled: false, cycleState: 'idle', cycleNo: 0, controlState: 'paused' }
assert.equal(isNewPlan(pristine), true)
assert.match(planPhase(pristine, planProgress([])), /尚未开始/)
assert.equal(isNewPlan({ ...pristine, cycleNo: 1 }), false)
assert.equal(isNewPlan({ ...pristine, discoveryTaskId: 9 }), false)
assert.equal(isNewPlan({ ...pristine, lastDiscoveryTaskId: 9 }), false)
