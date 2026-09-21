// 去重与节流：5s 合并计数、同屏上限排队、结构类事件即时、thread:null 退化键。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SWITCHES, NotificationThrottle, createRuntime, throttleKey } from '../web/entry.js'

function descriptor(kind, thread, unthrottled = false, always = false) {
  return { kind, title: kind, thread, summary: '', unthrottled, always }
}

test('同一 (thread,kind) 5s 窗口内合并计数', () => {
  const throttle = new NotificationThrottle()
  const first = throttle.admit(descriptor('approval_pending', 't1'), 1000)
  assert.equal(first.action, 'show')
  const second = throttle.admit(descriptor('approval_pending', 't1'), 2000)
  assert.equal(second.action, 'merge')
  assert.equal(second.count, 2)
  const third = throttle.admit(descriptor('approval_pending', 't1'), 5999)
  assert.equal(third.count, 3)
  const afterWindow = throttle.admit(descriptor('approval_pending', 't1'), 6001)
  assert.equal(afterWindow.action, 'show')
  assert.equal(afterWindow.count, 1, '窗口过后计数复位')
  assert.equal(throttle.activeCount(), 2, '窗口过后为新的一条（旧条仍在屏）')
})

test('不同 thread / kind 各自成键', () => {
  const throttle = new NotificationThrottle()
  throttle.admit(descriptor('approval_pending', 't1'), 0)
  const otherThread = throttle.admit(descriptor('approval_pending', 't2'), 0)
  assert.equal(otherThread.action, 'show')
  const otherKind = throttle.admit(descriptor('run_failed', 't1'), 0)
  assert.equal(otherKind.action, 'show')
})

test('同屏最多 3 条，超出按到达顺序排队', () => {
  const throttle = new NotificationThrottle()
  assert.equal(throttle.admit(descriptor('run_failed', 'a'), 0).action, 'show')
  assert.equal(throttle.admit(descriptor('run_failed', 'b'), 0).action, 'show')
  assert.equal(throttle.admit(descriptor('run_failed', 'c'), 0).action, 'show')
  const overflow = throttle.admit(descriptor('run_failed', 'd'), 0)
  assert.equal(overflow.action, 'queue')
  assert.equal(throttle.queuedCount(), 1)
  const next = throttle.release()
  assert.equal(next.thread, 'd')
  assert.equal(throttle.queuedCount(), 0)
  assert.equal(throttle.release(), null)
})

test('结构性事件不受节流：始终即时、不占同屏配额、不合并', () => {
  const throttle = new NotificationThrottle()
  for (let i = 0; i < 5; i++) {
    const decision = throttle.admit(descriptor('question_pending', 't1', true, true), i)
    assert.equal(decision.action, 'show')
  }
  assert.equal(throttle.activeCount(), 0)
  assert.equal(throttle.queuedCount(), 0)
})

test('thread:null 退化为 kind 键（周期 unhealthy 合并）', () => {
  assert.equal(throttleKey(null, 'orchestration_unhealthy'), 'orchestration_unhealthy')
  assert.equal(throttleKey('', 'orchestration_unhealthy'), 'orchestration_unhealthy')
  assert.equal(throttleKey('t1', 'orchestration_unhealthy'), 't1|orchestration_unhealthy')
  const throttle = new NotificationThrottle()
  // 结构性不合并；用同键的普通类验证 thread:null 退化键的合并
  throttle.admit(descriptor('orchestration_unhealthy', null, true, true), 0)
  const first = throttle.admit(descriptor('orchestration_unhealthy', null, false, true), 0)
  const second = throttle.admit(descriptor('orchestration_unhealthy', null, false, true), 100)
  assert.equal(first.action, 'show')
  assert.equal(second.action, 'merge')
  assert.equal(second.count, 2)
})

test('runtime：门控不通过时不 show、不报错；通过后节流合并生效', () => {
  const shown = []
  const runtime = createRuntime({
    permission: 'default',
    focused: false,
    show: (descriptor, count) => shown.push({ descriptor, count }),
  })
  const record = { topic: 'approval.pending', payload: { kind: 'tool_call', thread: 't1' } }
  const skipped = runtime.handle(record)
  assert.equal(skipped.action, 'skip')
  assert.equal(shown.length, 0)

  runtime.setState({ permission: 'granted' })
  const first = runtime.handle(record)
  assert.equal(first.action, 'show')
  const merged = runtime.handle(record)
  assert.equal(merged.action, 'merge')
  assert.equal(shown.length, 1)
})

test('runtime：排队项在关闭后按序弹出', () => {
  const shown = []
  const runtime = createRuntime({ permission: 'granted', focused: false, show: (descriptor) => shown.push(descriptor.thread) })
  for (const thread of ['a', 'b', 'c', 'd']) {
    runtime.handle({ topic: 'approval.pending', payload: { kind: 'tool_call', thread } })
  }
  assert.deepEqual(shown, ['a', 'b', 'c'])
  const next = runtime.release()
  assert.equal(next.thread, 'd')
})

test('排队项的合并计数不丢：弹出时带累计计数', () => {
  const throttle = new NotificationThrottle()
  throttle.admit(descriptor('run_failed', 'a'), 0)
  throttle.admit(descriptor('run_failed', 'b'), 0)
  throttle.admit(descriptor('run_failed', 'c'), 0)
  const queued = throttle.admit(descriptor('run_failed', 'd'), 0)
  assert.equal(queued.action, 'queue')
  const merged = throttle.admit(descriptor('run_failed', 'd'), 100)
  assert.equal(merged.action, 'merge')
  assert.equal(merged.count, 2)
  const next = throttle.release()
  assert.equal(next.thread, 'd')
  assert.equal(next.count, 2, '合并计数应随排队项弹出')
})

test('release 后重评门控：开关关闭的排队项被丢弃', () => {
  const shown = []
  const runtime = createRuntime({ permission: 'granted', focused: false, show: (descriptor) => shown.push(descriptor.thread) })
  for (const thread of ['a', 'b', 'c', 'd']) {
    runtime.handle({ topic: 'approval.pending', payload: { kind: 'tool_call', thread } })
  }
  assert.deepEqual(shown, ['a', 'b', 'c'])
  runtime.setState({ switches: { ...DEFAULT_SWITCHES, approval_pending: false } })
  assert.equal(runtime.release(), null, '门控不满足的排队项应丢弃而非弹出')
  assert.deepEqual(shown, ['a', 'b', 'c'])
})
