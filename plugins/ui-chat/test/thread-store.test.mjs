// `thread-store` 每线程视图 fold 测试（node --test）：锁住 8 条事件语义。
// 覆盖：快照替换、run 生命周期、缺 started 自愈、reset 清空、迟到帧丢弃、无关终局忽略、
// 取消保留、工具卡有序 fold、run id 认领、store 订阅 / 快照稳定性。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDelta,
  applyRunStarted,
  applySnapshot,
  applyToolDelta,
  applyToolEnd,
  applyToolStart,
  clearPendingUser,
  createThreadStore,
  dropInFlight,
  emptyView,
  FINISHED_MEMORY,
  foldRunFinished,
  isStreaming,
  reconcilePendingUser,
  setPendingUser,
} from '../execute/web/thread-store.ts'

function historyFixture() {
  return {
    body: { current: 'c1', conversations: [{ id: 'c1', kind: 'main', head: { def: 'h2' } }] },
    refs: {
      h1: { id: 'm1', role: 'user', content: 'hi', prev: null },
      h2: { id: 'm2', role: 'assistant', content: 'yo', prev: { def: 'h1' } },
    },
  }
}

test('emptyView：空视图形状', () => {
  const view = emptyView('t1')
  assert.equal(view.thread, 't1')
  assert.equal(view.inFlight, null)
  assert.equal(view.pendingUser, null)
  assert.deepEqual(view.messages, [])
  assert.deepEqual(view.finishedRuns, [])
  assert.equal(view.kind, 'main')
})

test('快照：替换权威段且不动在途回合（语义 7）', () => {
  let view = emptyView()
  view = applySnapshot(view, historyFixture(), 'c1')
  assert.equal(view.conversation.id, 'c1')
  assert.equal(view.kind, 'main')
  assert.equal(view.messages.length, 2)
  assert.equal(view.messages[0].def.content, 'hi')
  assert.equal(view.messages[1].def.content, 'yo')
  assert.equal(view.revision, 1)
  // 在途回合不被快照清除
  view = applyRunStarted(view, { run: 'r1', thread: 't1' })
  const after = applySnapshot(view, historyFixture(), 'c1')
  assert.notEqual(after.inFlight, null)
  assert.equal(after.inFlight.run, 'r1')
  // 显式丢弃才清
  assert.equal(dropInFlight(after, 'r1').inFlight, null)
})

test('快照收口定稿：finalizing 的在途回合被快照原地替换（定稿替换）', () => {
  let view = applyDelta(emptyView(), { run: 'r1', text: '流式中' })
  // 流式中快照：保留在途
  assert.notEqual(applySnapshot(view, historyFixture(), 'c1').inFlight, null)
  // 定稿中快照：收口
  view = foldRunFinished(view, { run: 'r1', status: 'done' }).view
  assert.equal(view.inFlight.finalizing, true)
  const settled = applySnapshot(view, historyFixture(), 'c1')
  assert.equal(settled.inFlight, null)
  assert.equal(settled.messages.length, 2)
})

test('生命周期：started → delta 追加 → finished 收束（语义 2）', () => {
  let view = emptyView()
  view = applyRunStarted(view, { run: 'r1', thread: 't1' })
  view = applyDelta(view, { run: 'r1', text: '你' })
  view = applyDelta(view, { run: 'r1', text: '好' })
  assert.equal(view.inFlight.text, '你好')
  assert.equal(isStreaming(view), true)
  const folded = foldRunFinished(view, { run: 'r1', status: 'done' })
  assert.equal(folded.action, 'finalize')
  assert.equal(folded.view.inFlight.finalizing, true)
})

test('缺 started 自愈：首个 delta 即建在途回合（语义 4）', () => {
  let view = emptyView()
  view = applyDelta(view, { run: 'r9', thread: 't1', text: 'x' })
  assert.equal(view.inFlight.run, 'r9')
  assert.equal(view.inFlight.text, 'x')
})

test('run id 认领：缺 run 的自愈回合被 started 认领而非替换', () => {
  let view = emptyView()
  view = applyDelta(view, { thread: 't1', text: 'partial' })
  assert.equal(view.inFlight.run, null)
  view = applyRunStarted(view, { run: 'r2', thread: 't1' })
  assert.equal(view.inFlight.run, 'r2')
  assert.equal(view.inFlight.text, 'partial')
})

test('run id 认领（delta 路径）：自愈回合被后续 run id 认领而非替换', () => {
  let view = applyDelta(emptyView(), { thread: 't1', text: 'partial' })
  assert.equal(view.inFlight.run, null)
  view = applyDelta(view, { run: 'r2', text: ' more' })
  assert.equal(view.inFlight.run, 'r2')
  assert.equal(view.inFlight.text, 'partial more')
})

test('tool.delta 缺 started 自愈：无在途回合时先建在途回合', () => {
  const view = applyToolDelta(emptyView(), { run: 'r1', thread: 't1', call_id: 'a', chunk: 'x' })
  assert.notEqual(view.inFlight, null)
  assert.equal(view.inFlight.run, 'r1')
})

test('取消后的在途回合被权威快照清除，不再重复渲染', () => {
  let view = applyDelta(emptyView(), { run: 'r1', text: 'half' })
  view = foldRunFinished(view, { run: 'r1', status: 'cancelled' }).view
  assert.equal(view.inFlight.cancelled, true)
  const settled = applySnapshot(view, historyFixture(), 'c1')
  assert.equal(settled.inFlight, null)
  assert.equal(settled.messages.length, 2)
})

test('reset 清空重放：不再重复追加（语义 6）', () => {
  let view = emptyView()
  view = applyDelta(view, { run: 'r1', text: 'abc' })
  view = applyDelta(view, { run: 'r1', reset: true, text: 'x' })
  assert.equal(view.inFlight.text, 'x')
  view = applyDelta(view, { run: 'r1', reset: true })
  assert.equal(view.inFlight.text, '')
})

test('迟到帧丢弃：定稿后同 run 的 delta / tool 不再起回合（语义 3）', () => {
  let view = emptyView()
  view = applyRunStarted(view, { run: 'r1', thread: 't1' })
  const folded = foldRunFinished(view, { run: 'r1', status: 'done' })
  view = dropInFlight(folded.view, 'r1')
  assert.equal(view.inFlight, null)
  const late = applyDelta(view, { run: 'r1', text: 'ghost' })
  assert.equal(late.inFlight, null)
  assert.equal(late, view)
  const lateTool = applyToolStart(view, { run: 'r1', call_id: 'c', tool: 'read' })
  assert.equal(lateTool.inFlight, null)
})

test('无关终局忽略：无匹配在途回合不触发重拉（语义 5）', () => {
  let view = applySnapshot(emptyView(), historyFixture(), 'c1')
  const folded = foldRunFinished(view, { run: 'write-1', status: 'done' })
  assert.equal(folded.action, 'ignore')
  // 记入 finishedRuns，后续同 run 迟到帧同样丢弃
  assert.deepEqual(folded.view.finishedRuns, ['write-1'])
  assert.equal(foldRunFinished(folded.view, { run: 'write-1', status: 'done' }).action, 'ignore')
})

test('finishedRuns 有界：不超过 FINISHED_MEMORY', () => {
  let view = emptyView()
  for (let index = 0; index < FINISHED_MEMORY + 8; index += 1) {
    view = foldRunFinished(view, { run: `r${index}`, status: 'done' }).view
  }
  assert.equal(view.finishedRuns.length, FINISHED_MEMORY)
  assert.equal(view.finishedRuns[0], `r${FINISHED_MEMORY + 7}`)
})

test('取消：保留在途并标记 cancelled，不再流式（语义 2）', () => {
  let view = applyDelta(emptyView(), { run: 'r1', text: 'half' })
  const folded = foldRunFinished(view, { run: 'r1', status: 'cancelled' })
  assert.equal(folded.action, 'cancel')
  assert.equal(folded.view.inFlight.cancelled, true)
  assert.equal(folded.view.inFlight.text, 'half')
  assert.equal(isStreaming(folded.view), false)
})

test('匹配放宽：任一侧缺 run id 视为匹配', () => {
  const view = applyDelta(emptyView(), { text: 'no-run' })
  const folded = foldRunFinished(view, { run: 'r7', status: 'done' })
  assert.equal(folded.action, 'finalize')
})

test('工具卡 fold：有序、按 call_id 去重后置末、chunks 追加、end 标记', () => {
  let view = applyRunStarted(emptyView(), { run: 'r1', thread: 't1' })
  view = applyToolStart(view, { run: 'r1', call_id: 'a', tool: 'read', args: { path: 'x' } })
  view = applyToolStart(view, { run: 'r1', call_id: 'b', tool: 'grep' })
  assert.deepEqual(
    view.inFlight.tools.map((item) => item.callId),
    ['a', 'b'],
  )
  view = applyToolStart(view, { run: 'r1', call_id: 'a', tool: 'read' })
  assert.deepEqual(
    view.inFlight.tools.map((item) => item.callId),
    ['b', 'a'],
  )
  view = applyToolDelta(view, { run: 'r1', call_id: 'a', chunk: 'line1\n' })
  view = applyToolDelta(view, { run: 'r1', call_id: 'a', chunk: 'line2' })
  const toolA = view.inFlight.tools.find((item) => item.callId === 'a')
  assert.equal(toolA.chunks, 'line1\nline2')
  view = applyToolEnd(view, { run: 'r1', call_id: 'a', ok: true })
  assert.equal(view.inFlight.tools.find((item) => item.callId === 'a').done, true)
  assert.equal(view.inFlight.tools.find((item) => item.callId === 'a').ok, true)
})

test('渲染段交错：正文与工具卡按到达序排布（工具不被挤到文末）', () => {
  let view = applyRunStarted(emptyView(), { run: 'r1', thread: 't1' })
  view = applyDelta(view, { run: 'r1', text: '先看一下' })
  view = applyToolStart(view, { run: 'r1', call_id: 'a', tool: 'read' })
  view = applyDelta(view, { run: 'r1', text: '再搜一下' })
  view = applyToolStart(view, { run: 'r1', call_id: 'b', tool: 'grep' })
  view = applyDelta(view, { run: 'r1', text: '结论' })
  assert.deepEqual(
    view.inFlight.segments.map((segment) => segment.kind),
    ['text', 'tool', 'text', 'tool', 'text'],
  )
  assert.equal(view.inFlight.segments[0].text, '先看一下')
  assert.equal(view.inFlight.segments[2].text, '再搜一下')
  // 连续正文合并为一段
  view = applyDelta(view, { run: 'r1', text: '！' })
  assert.equal(view.inFlight.segments.length, 5)
  assert.equal(view.inFlight.segments[4].text, '结论！')
  // 工具去重置末时渲染段同步置末
  view = applyToolStart(view, { run: 'r1', call_id: 'a', tool: 'read' })
  assert.deepEqual(
    view.inFlight.segments.map((segment) => (segment.kind === 'tool' ? segment.callId : 'text')),
    ['text', 'text', 'b', 'text', 'a'],
  )
})

test('reset 重放：清空正文段、保留工具段、新正文排到末位', () => {
  let view = applyRunStarted(emptyView(), { run: 'r1', thread: 't1' })
  view = applyDelta(view, { run: 'r1', text: '旧文' })
  view = applyToolStart(view, { run: 'r1', call_id: 'a', tool: 'read' })
  view = applyDelta(view, { run: 'r1', reset: true, text: '新文' })
  assert.equal(view.inFlight.text, '新文')
  assert.deepEqual(
    view.inFlight.segments.map((segment) => segment.kind),
    ['tool', 'text'],
  )
  assert.equal(view.inFlight.segments[1].text, '新文')
})

test('推理分片：累积为 reasoning 段、先于同帧正文、reset 一并清空', () => {
  let view = applyRunStarted(emptyView(), { run: 'r1', thread: 't1' })
  view = applyDelta(view, { run: 'r1', reasoning: '先想' })
  view = applyDelta(view, { run: 'r1', reasoning: '一下' })
  view = applyDelta(view, { run: 'r1', text: '答案' })
  assert.equal(view.inFlight.reasoning, '先想一下')
  assert.equal(view.inFlight.text, '答案')
  assert.deepEqual(
    view.inFlight.segments.map((segment) => segment.kind),
    ['reasoning', 'text'],
  )
  assert.equal(view.inFlight.segments[0].text, '先想一下')
  // 同帧同时带推理与正文：推理段在前
  view = applyRunStarted(emptyView(), { run: 'r2', thread: 't1' })
  view = applyDelta(view, { run: 'r2', reasoning: '想', text: '答' })
  assert.deepEqual(
    view.inFlight.segments.map((segment) => segment.kind),
    ['reasoning', 'text'],
  )
  // reset 清空正文与推理段，工具段保留
  view = applyToolStart(view, { run: 'r2', call_id: 't', tool: 'read' })
  view = applyDelta(view, { run: 'r2', reset: true, reasoning: '重想', text: '重答' })
  assert.deepEqual(
    view.inFlight.segments.map((segment) => segment.kind),
    ['tool', 'reasoning', 'text'],
  )
  assert.equal(view.inFlight.reasoning, '重想')
  assert.equal(view.inFlight.text, '重答')
})

test('线程切换：dropInFlight 不传 run 清空任意在途回合（语义 8 的一半）', () => {
  const view = applyDelta(emptyView(), { run: 'r1', text: 'x' })
  assert.equal(dropInFlight(view).inFlight, null)
})

test('store：getSnapshot 稳定、commit 触发订阅并带 meta、可退订', () => {
  const store = createThreadStore(emptyView())
  const first = store.getSnapshot()
  assert.equal(store.getSnapshot(), first)
  const seen = []
  const off = store.subscribe((view, meta) => seen.push({ view, meta }))
  const next = applyDelta(first, { run: 'r1', text: 'a' })
  store.commit(next, { type: 'delta' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].view, next)
  assert.equal(seen[0].meta.type, 'delta')
  assert.equal(store.getSnapshot(), next)
  // 同引用提交不通知
  store.commit(next, { type: 'delta' })
  assert.equal(seen.length, 1)
  off()
  store.commit(applyDelta(next, { run: 'r1', text: 'b' }), { type: 'delta' })
  assert.equal(seen.length, 1)
})

test('register 作用域：卸载 / 重挂后消息与在途流仍在，重挂快照不冲掉在途回合', () => {
  // register 只建一次 store，组件卸载 / 重挂都复用该实例。
  const store = createThreadStore(emptyView())
  // 首挂：权威快照 + 在途流。
  let view = applySnapshot(store.getSnapshot(), historyFixture(), 'c1')
  view = applyRunStarted(view, { run: 'r1', thread: 't1' })
  view = applyDelta(view, { run: 'r1', text: '生成中' })
  store.commit(view, { type: 'snapshot' })
  // 卸载后重挂：组件重新拉快照（mount effect 路径），在途回合不被快照清除。
  const remounted = applySnapshot(store.getSnapshot(), historyFixture(), 'c1')
  assert.equal(remounted.messages.length, 2)
  assert.equal(remounted.inFlight.text, '生成中')
  assert.equal(isStreaming(remounted), true)
})

test('乐观用户气泡：设置 / 清除幂等', () => {
  const empty = emptyView()
  assert.equal(empty.pendingUser, null)
  assert.equal(clearPendingUser(empty), empty)
  const def = { role: 'user', parts: [{ type: 'text', text: 'hi' }] }
  const view = setPendingUser(empty, def)
  assert.equal(view.pendingUser, def)
  assert.notEqual(view, empty)
  assert.equal(clearPendingUser(view).pendingUser, null)
})

test('乐观用户气泡：卸载 / 重挂后仍在，权威快照含同文消息时收口', () => {
  const store = createThreadStore(emptyView())
  // 首挂：权威快照 + 在途回合 + 乐观用户气泡（用户消息尚未落权威历史）。
  let view = applySnapshot(store.getSnapshot(), historyFixture(), 'c1')
  view = applyRunStarted(view, { run: 'r1', thread: 't1' })
  view = applyDelta(view, { run: 'r1', text: '生成中' })
  view = setPendingUser(view, { role: 'user', parts: [{ type: 'text', text: '新问题' }] })
  store.commit(view, { type: 'snapshot' })
  // 卸载后重挂：mount effect 重新拉快照，在途回合与乐观气泡均不被清除。
  const remounted = reconcilePendingUser(applySnapshot(store.getSnapshot(), historyFixture(), 'c1'))
  assert.equal(remounted.inFlight.text, '生成中')
  assert.notEqual(remounted.pendingUser, null)
  assert.equal(remounted.pendingUser.parts[0].text, '新问题')
  // 正确收口：权威快照已含同文用户消息 → 乐观气泡清除，在途回合不动。
  const settledHistory = {
    body: { current: 'c1', conversations: [{ id: 'c1', kind: 'main', head: { def: 'h3' } }] },
    refs: {
      h1: { id: 'm1', role: 'user', content: 'hi', prev: null },
      h2: { id: 'm2', role: 'assistant', content: 'yo', prev: { def: 'h1' } },
      h3: { id: 'm3', role: 'user', content: '新问题', prev: { def: 'h2' } },
    },
  }
  const settled = reconcilePendingUser(applySnapshot(remounted, settledHistory, 'c1'))
  assert.equal(settled.pendingUser, null)
  assert.equal(settled.inFlight.text, '生成中')
})

test('乐观用户气泡：取消 / 线程切换走显式清除', () => {
  let view = applyDelta(emptyView(), { run: 'r1', text: 'half' })
  view = setPendingUser(view, { role: 'user', parts: [] })
  // 取消：终局折叠后显式清气泡。
  const cancelled = foldRunFinished(view, { run: 'r1', status: 'cancelled' }).view
  assert.equal(clearPendingUser(cancelled).pendingUser, null)
  // 线程切换：在途回合与气泡同一提交清空。
  const switched = dropInFlight(clearPendingUser(view))
  assert.equal(switched.pendingUser, null)
  assert.equal(switched.inFlight, null)
})
