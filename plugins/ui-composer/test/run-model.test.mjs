// 回合 run 追踪纯模型测试（node --test）：分辨本插件派发的回合 run 与宿主其它 command / submit run，
// 覆盖「槽写落账后才派发 chat.send」「落账事件先于 pendingWrite 的竞态」「非本插件 run 不置忙」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  armWrite,
  beginWrite,
  clearExpecting,
  createRunState,
  endWrite,
  expectTurn,
  isExpecting,
  isThreadBusy,
  trackRunFinished,
  trackRunStarted,
} from '../execute/web/run-model.ts'

test('写 / 回合全序列：写落账后才等回合 run，回合结束清空忙态', () => {
  let state = createRunState()
  assert.equal(isThreadBusy(state, 'a'), false)

  state = beginWrite(state, 'a')
  assert.equal(isThreadBusy(state, 'a'), true)
  state = endWrite(state, 'a')
  assert.equal(isThreadBusy(state, 'a'), false)

  const armed = armWrite(state, 'a', 'w1')
  assert.equal(armed.dispatch, false)
  state = armed.state
  assert.equal(isThreadBusy(state, 'a'), true)

  const writeEnd = trackRunFinished(state, 'w1', 'a')
  assert.equal(writeEnd.kind, 'write')
  state = writeEnd.state
  assert.equal(isThreadBusy(state, 'a'), false)

  state = expectTurn(state, 'a')
  assert.equal(isThreadBusy(state, 'a'), true)
  const started = trackRunStarted(state, 't1', 'a')
  assert.equal(started.turnStarted, true)
  state = started.state
  assert.equal(state.runs.a, 't1')
  assert.equal(isThreadBusy(state, 'a'), true)

  const turnEnd = trackRunFinished(state, 't1', 'a')
  assert.equal(turnEnd.kind, 'turn')
  assert.equal(isThreadBusy(turnEnd.state, 'a'), false)
})

test('非本插件的 run：started 不认领、finished 不置忙也不构成回合结束', () => {
  let state = createRunState()
  const started = trackRunStarted(state, 'foreign', 'a')
  assert.equal(started.turnStarted, false)
  state = started.state
  assert.equal(state.runs.a, undefined)

  const finished = trackRunFinished(state, 'foreign', 'a')
  assert.equal(finished.kind, 'other')
  assert.equal(isThreadBusy(finished.state, 'a'), false)
})

test('竞态：写 run 落账事件先于 armWrite 时，armWrite 立即要求派发', () => {
  let state = createRunState()
  state = trackRunFinished(state, 'w1', 'a').state
  const armed = armWrite(state, 'a', 'w1')
  assert.equal(armed.dispatch, true)
  assert.equal(armed.state.pendingWrite.a, undefined)
  assert.equal(armed.state.finishedRuns.w1, undefined)
})

test('isExpecting：等回合期间为真，run.started 认领或 clearExpecting 后为假', () => {
  let state = expectTurn(createRunState(), 'a')
  assert.equal(isExpecting(state, 'a'), true)
  assert.equal(isExpecting(state, 'b'), false)
  state = trackRunStarted(state, 't1', 'a').state
  assert.equal(isExpecting(state, 'a'), false)
  state = clearExpecting(expectTurn(createRunState(), 'a'), 'a')
  assert.equal(isExpecting(state, 'a'), false)
})

test('expecting 被 clearExpecting 收回后，迟到的 run.started 不认领', () => {
  let state = expectTurn(createRunState(), 'a')
  state = clearExpecting(state, 'a')
  assert.equal(trackRunStarted(state, 't1', 'a').turnStarted, false)
})

test('结束记录有界：大量无关 run 不无限增长，最新一条可认领', () => {
  let state = createRunState()
  for (let i = 0; i < 100; i += 1) state = trackRunFinished(state, `r${i}`, 'a').state
  assert.ok(Object.keys(state.finishedRuns).length <= 64)
  assert.equal(state.finishedRuns.r99, true)
})
