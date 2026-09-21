// 事件分类、双重门控、权限状态与通知形态（纯函数，零依赖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SWITCHES,
  PERMISSION_DENIED_CODE,
  classify,
  evaluate,
  formatBody,
  guidanceFor,
  notificationContent,
  publishState,
  readPermission,
  resolveSwitches,
  resolveSwitchesFromCommandValue,
  throttleKey,
  truncate,
} from '../web/entry.js'

const switchesOn = resolveSwitches(null)

test('approval.pending 按 item.kind 三路分流', () => {
  const toolCall = classify({ impl: 'approval', topic: 'approval.pending', payload: { item: { kind: 'tool_call', thread: 't1' } } })
  assert.equal(toolCall.kind, 'approval_pending')
  assert.equal(toolCall.title, '待审批')
  assert.equal(toolCall.thread, 't1')
  assert.equal(toolCall.always, false)
  assert.equal(toolCall.unthrottled, false)

  const orchestration = classify({ topic: 'approval.pending', payload: { item: { kind: 'orchestration_change', thread: 't1' } } })
  assert.equal(orchestration.kind, 'orchestration_change')
  assert.equal(orchestration.title, '待审批：编排变更')
  assert.equal(orchestration.always, true)
  assert.equal(orchestration.unthrottled, false)

  const pluginWrite = classify({ topic: 'approval.pending', payload: { item: { kind: 'plugin_write', thread: 't2' } } })
  assert.equal(pluginWrite.kind, 'plugin_write')
  assert.equal(pluginWrite.title, '待审批：插件写入')
  assert.equal(pluginWrite.always, true)
})

test('approval.pending 兼容扁平载荷与缺 thread 兜底', () => {
  const flat = classify({ topic: 'approval.pending', payload: { kind: 'tool_call', thread: 't9' } })
  assert.equal(flat.thread, 't9')
  const noThread = classify({ topic: 'approval.pending', payload: { kind: 'tool_call' } })
  assert.equal(noThread.thread, null)
  assert.equal(throttleKey(noThread.thread, noThread.kind), 'approval_pending')
})

test('run.finished：完成 / 失败 / 模型错误前缀分流', () => {
  const done = classify({ topic: 'run.finished', payload: { run: 'r1', thread: 't1', status: 'done' } })
  assert.equal(done.kind, 'run_finished')
  assert.equal(done.title, '回合完成')
  assert.equal(done.always, false)

  const failed = classify({ topic: 'run.finished', payload: { run: 'r1', thread: 't1', status: 'refused' } })
  assert.equal(failed.kind, 'run_failed')
  assert.equal(failed.title, '回合失败')
  assert.equal(failed.always, true)

  const model = classify({
    topic: 'run.finished',
    payload: { run: 'r1', thread: 't1', status: 'refused', reasons: ['model_rate_limited'] },
  })
  assert.equal(model.kind, 'model_error')
  assert.equal(model.title, '模型错误')
  assert.equal(model.always, true)

  const transport = classify({
    topic: 'run.finished',
    payload: { run: 'r1', thread: 't1', status: 'refused', reasons: ['transport_failed'] },
  })
  assert.equal(transport.kind, 'model_error')

  const notModel = classify({
    topic: 'run.finished',
    payload: { run: 'r1', thread: 't1', status: 'refused', reasons: ['eff_error'] },
  })
  assert.equal(notModel.kind, 'run_failed')

  assert.equal(classify({ topic: 'run.finished', payload: { status: 'cancelled' } }), null)
  assert.equal(classify({ topic: 'run.finished', payload: { status: 'idle' } }), null)
})

test('断线合成事件始终通知', () => {
  const down = classify({ impl: 'shell', topic: 'shell.disconnected', payload: {} })
  assert.equal(down.kind, 'disconnected')
  assert.equal(down.title, '断线')
  assert.equal(down.always, true)
  assert.equal(down.unthrottled, false)
  const up = classify({ impl: 'shell', topic: 'shell.reconnected', payload: {} })
  assert.equal(up.kind, 'reconnected')
  assert.equal(up.title, '已重连')
})

test('orchestration.unhealthy：thread:null 退化去重键、正文带次数', () => {
  const descriptor = classify({ impl: 'evolve-metrics', topic: 'orchestration.unhealthy', payload: { thread: null, count: 3 } })
  assert.equal(descriptor.kind, 'orchestration_unhealthy')
  assert.equal(descriptor.thread, null)
  assert.equal(descriptor.unthrottled, true)
  assert.equal(throttleKey(descriptor.thread, descriptor.kind), 'orchestration_unhealthy')
  assert.match(descriptor.summary, /3 次/)
  assert.match(descriptor.summary, /编排回滚到上一世代/)
})

test('question.pending 始终通知', () => {
  const descriptor = classify({ impl: 'question', topic: 'question.pending', payload: { run: 'r1', thread: 't1', id: 'q1' } })
  assert.equal(descriptor.kind, 'question_pending')
  assert.equal(descriptor.title, '提问待作答')
  assert.equal(descriptor.always, true)
  assert.equal(descriptor.unthrottled, true)
})

test('未订阅事件返回 null', () => {
  assert.equal(classify({ topic: 'model.delta', payload: {} }), null)
  assert.equal(classify(null), null)
})

test('双重门控：开关 + 权限 granted 才弹', () => {
  const descriptor = classify({ topic: 'run.finished', payload: { status: 'refused' } })
  assert.equal(evaluate(descriptor, { switches: switchesOn, permission: 'granted', focused: true }).show, true)
  assert.equal(evaluate(descriptor, { switches: { ...switchesOn, run_failed: false }, permission: 'granted' }).reason, 'switch_off')
  assert.equal(evaluate(descriptor, { switches: switchesOn, permission: 'default' }).reason, 'permission_default')
  assert.equal(evaluate(descriptor, { switches: switchesOn, permission: 'denied' }).reason, 'permission_denied')
  assert.equal(evaluate(descriptor, { switches: switchesOn, permission: 'unsupported' }).reason, 'permission_default')
})

test('only_when_unfocused 仅约束 tool_call 待审批与回合完成', () => {
  const approval = classify({ topic: 'approval.pending', payload: { kind: 'tool_call' } })
  assert.equal(evaluate(approval, { switches: switchesOn, permission: 'granted', focused: true }).reason, 'focused')
  assert.equal(
    evaluate(approval, { switches: { ...switchesOn, only_when_unfocused: false }, permission: 'granted', focused: true }).show,
    true,
  )
  const done = classify({ topic: 'run.finished', payload: { status: 'done' } })
  assert.equal(evaluate(done, { switches: switchesOn, permission: 'granted', focused: true }).reason, 'focused')

  const structural = classify({ topic: 'approval.pending', payload: { kind: 'plugin_write' } })
  assert.equal(evaluate(structural, { switches: switchesOn, permission: 'granted', focused: true }).show, true)
  const unhealthy = classify({ topic: 'orchestration.unhealthy', payload: { thread: null } })
  assert.equal(evaluate(unhealthy, { switches: switchesOn, permission: 'granted', focused: true }).show, true)
})

test('resolveSwitches：缺键默认 true、显式 false 才关', () => {
  const resolved = resolveSwitches({ run_finished: false, approval_pending: true, disconnected: 'no' })
  assert.equal(resolved.run_finished, false)
  assert.equal(resolved.approval_pending, true)
  assert.equal(resolved.disconnected, true)
  assert.equal(resolved.question_pending, true)
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(DEFAULT_SWITCHES).sort())
})

test('从 notify.state 返回值（整份 config body）取 ui.notify', () => {
  const value = { version: 1, ui: { theme: 'system', notify: { run_finished: false } } }
  const resolved = resolveSwitchesFromCommandValue(value)
  assert.equal(resolved.run_finished, false)
  assert.equal(resolved.approval_pending, true)
  // 缺 ui.notify / 返回值非对象都退化为全默认 true
  assert.deepEqual(resolveSwitchesFromCommandValue({ version: 1 }), switchesOn)
  assert.deepEqual(resolveSwitchesFromCommandValue(null), switchesOn)
})

test('权限状态读取与已拒绝指引', () => {
  assert.equal(readPermission({ Notification: { permission: 'granted' } }), 'granted')
  assert.equal(readPermission({}), 'unsupported')

  const withTable = guidanceFor('denied', { [PERMISSION_DENIED_CODE]: { title: '通知被拒绝', body: '请在站点设置中允许通知' } })
  assert.deepEqual(withTable, { code: PERMISSION_DENIED_CODE, text: '请在站点设置中允许通知' })
  const fallback = guidanceFor('denied', null)
  assert.equal(fallback.code, PERMISSION_DENIED_CODE)
  assert.ok(fallback.text.length > 0)
  assert.equal(guidanceFor('granted', null), null)
  assert.equal(guidanceFor('default', null), null)
})

test('publishState 写同页全局并派发自定义事件', () => {
  const events = []
  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init?.detail
    }
  }
  const win = {
    CustomEvent: FakeCustomEvent,
    dispatchEvent(event) {
      events.push(event)
    },
  }
  const payload = publishState(win, { permission: 'denied', switches: switchesOn, guidance: guidanceFor('denied', null) })
  assert.equal(win.__chronoNotify, payload)
  assert.equal(payload.permission, 'denied')
  assert.equal(events.length, 1)
  assert.equal(events[0].type === 'chrono-notify:state' || events[0].detail.permission === 'denied', true)
})

test('正文 = 会话标签 + 首行摘要，按 80 码点截断', () => {
  assert.equal(formatBody('t1', '第一行\n第二行'), 't1 · 第一行')
  const long = '字'.repeat(200)
  const body = formatBody('t1', long)
  assert.ok(Array.from(body).length <= 80, `长度 ${Array.from(body).length}`)
  assert.ok(body.endsWith('…'))
  assert.equal(truncate('abc', 80), 'abc')
})

test('通知内容：标题为事件类型、合并计数附正文、无操作按钮字段', () => {
  const descriptor = classify({ topic: 'approval.pending', payload: { kind: 'tool_call', thread: 't1' } })
  const single = notificationContent(descriptor, 1)
  assert.equal(single.title, '待审批')
  assert.equal(single.body, 't1')
  const merged = notificationContent(descriptor, 3)
  assert.match(merged.body, /×3/)
  assert.equal(Object.hasOwn(single, 'actions'), false)
  assert.equal(Object.hasOwn(single, 'buttons'), false)
})

test('通知标题 / 固定正文按 notify_* 码取自文案表，缺表回落内置', () => {
  const messages = {
    notify_run_failed: { title: '失败通知', body: 'x' },
    notify_orchestration_unhealthy: { title: '健康通知', body: '连续失败 {count} 次，可在设置 → 编排回滚到上一世代' },
  }
  const failed = classify({ topic: 'run.finished', payload: { status: 'refused', thread: 't1' } })
  assert.equal(failed.code, 'notify_run_failed')
  const content = notificationContent(failed, 1, messages)
  assert.equal(content.title, '失败通知')
  // 缺表回落内置标题
  assert.equal(notificationContent(failed, 1, null).title, '回合失败')

  const unhealthy = classify({ topic: 'orchestration.unhealthy', payload: { thread: null, count: 3 } })
  assert.equal(unhealthy.code, 'notify_orchestration_unhealthy')
  assert.equal(unhealthy.count, 3)
  assert.match(notificationContent(unhealthy, 1, messages).body, /连续失败 3 次/)

  const down = classify({ topic: 'shell.disconnected', payload: {} })
  assert.equal(down.code, 'notify_disconnected')
  assert.equal(down.summaryCode, 'notify_disconnected')
})
