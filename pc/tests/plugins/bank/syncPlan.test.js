import assert from 'node:assert/strict'
import { planBookStage, planProgress, planPhase } from '../../../plugins/bank/utils/sync-plan.js'
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
