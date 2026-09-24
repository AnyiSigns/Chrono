// 浏览器视图层纯函数测试（node --test）：模板选择、摘要视图、影子指标、计时格式、
// 二次确认状态机、expired 弱化、verdict 映射、文案兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  approvalStatus,
  approvalStatusTextCode,
  argsSummaryOf,
  armConfirm,
  clearConfirm,
  confirmArmed,
  CONFIRM_APPROVE_ALL,
  CONFIRM_DENY_ALL,
  createConfirmState,
  defaultExpanded,
  deltaText,
  diffCounts,
  diffItemKey,
  diffItemText,
  diffLabel,
  elapsedMs,
  fileKey,
  fileText,
  formatCount,
  formatMetric,
  formatWait,
  graphDiffText,
  identifiedItems,
  identityActive,
  identityBody,
  isCodeGenFallbackBody,
  isExpired,
  isPending,
  isUnreachableCode,
  LOADING_NOTE_MS,
  itemPresentation,
  itemTone,
  KIND_ORCHESTRATION_CHANGE,
  KIND_PLUGIN_WRITE,
  KIND_TOOL_CALL,
  metricTone,
  oldestPending,
  orchestrationView,
  pendingCount,
  pluginWriteSummary,
  pluginWriteView,
  selectTemplate,
  shadowBodyOf,
  shadowRounds,
  shadowRows,
  statusLabelCode,
  summaryLead,
  summaryText,
  toolCallView,
  verdictOf,
  verdictStatus,
  viewOf,
  waitWarning,
  withBusy,
  withoutBusy,
} from '../execute/web/model.ts'
import { lookupMessage, parseMessages, UI_TEXT } from '../execute/web/messages.ts'
import { createApprovalStore, slotWriteDirective } from '../execute/web/store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHARED_MESSAGES = resolve(HERE, '..', '..', 'ui-shell', 'execute', 'web', 'messages.v1.json')

test('输入槽写指令：有 data_gen 写补丁 + base；空改动回落整份', () => {
  const prev = { slots: { t1: { kind: 'approval.decide', id: 'a1', verdict: 'accept' } } }
  const next = { slots: { t1: { kind: 'idle' } } }
  const patched = slotWriteDirective(prev, next, undefined, { seq: 6, payload: 'a'.repeat(64) })
  const ops = patched.request.args.ops
  assert.equal(ops[1].args.id, 'input')
  assert.equal(ops[1].args.base, 6)
  assert.deepEqual(ops[0].args.body.ops, [{ op: 'replace', path: ['slots', 't1'], value: { kind: 'idle' } }])

  const full = slotWriteDirective(prev, next)
  assert.equal(full.request.args.ops[1].args.base, undefined)
  assert.equal(Array.isArray(full.request.args.ops[0].args.body.ops), false)

  const empty = slotWriteDirective(next, next, undefined, { seq: 6 })
  assert.equal(empty.request.args.ops[1].args.base, undefined)
  assert.equal(Array.isArray(empty.request.args.ops[0].args.body.ops), false)
})

function sharedTable() {
  return parseMessages(readFileSync(SHARED_MESSAGES, 'utf8'))
}

test('模板选择：三种 kind，未知 / 缺省回落 tool_call', () => {
  assert.equal(selectTemplate({ kind: 'tool_call' }), KIND_TOOL_CALL)
  assert.equal(selectTemplate({ kind: 'orchestration_change' }), KIND_ORCHESTRATION_CHANGE)
  assert.equal(selectTemplate({ kind: 'plugin_write' }), KIND_PLUGIN_WRITE)
  assert.equal(selectTemplate({ kind: 'bogus' }), KIND_TOOL_CALL)
  assert.equal(selectTemplate(null), KIND_TOOL_CALL)
})

test('默认展开：两类结构变更与 severe 档条目', () => {
  assert.equal(defaultExpanded({ kind: 'orchestration_change' }), true)
  assert.equal(defaultExpanded({ kind: 'plugin_write' }), true)
  assert.equal(defaultExpanded({ kind: 'tool_call', tier: 'severe' }), true)
  assert.equal(defaultExpanded({ kind: 'tool_call', tier: 'review' }), false)
  assert.equal(defaultExpanded({ kind: 'tool_call' }), false)
})

test('expired 弱化：仍计入停靠带、可裁决', () => {
  const pending = { status: 'pending' }
  const expired = { status: 'expired' }
  const approved = { status: 'approved' }
  assert.equal(isPending(pending), true)
  assert.equal(isPending(expired), true, 'expired 不消失')
  assert.equal(isPending(approved), false)
  assert.equal(isExpired(expired), true)
  assert.equal(itemTone(expired), 'expired')
  assert.equal(itemTone(pending), 'normal')
  assert.equal(pendingCount([pending, expired, approved, null]), 2)
  assert.equal(pendingCount(null), 0)
})

test('计时格式：mm:ss（>1h 用 h:mm:ss）与 >2min warning', () => {
  assert.equal(formatWait(0), '00:00')
  assert.equal(formatWait(65000), '01:05')
  assert.equal(formatWait(120000), '02:00')
  assert.equal(formatWait(3661000), '1:01:01')
  assert.equal(formatWait(-5), '00:00')
  assert.equal(waitWarning(120000), false)
  assert.equal(waitWarning(120001), true)
  assert.equal(waitWarning(119999), false)
})

test('等待毫秒：自 item.at 起算，缺失 / 非法回 0', () => {
  const item = { at: '2026-09-20T00:00:00.000Z' }
  const now = Date.parse('2026-09-20T00:02:05.000Z')
  assert.equal(elapsedMs(item, now), 125000)
  assert.equal(elapsedMs({}, now), 0)
  assert.equal(elapsedMs({ at: 'not-a-date' }, now), 0)
})

test('最老待审批项：只计 pending / expired，忽略非法 at', () => {
  const items = [
    { status: 'approved', at: '2026-09-20T00:00:00.000Z' },
    { status: 'pending', at: '2026-09-20T00:00:30.000Z' },
    { status: 'expired', at: '2026-09-20T00:00:10.000Z' },
    { status: 'pending', at: 'not-a-date' },
  ]
  assert.equal(oldestPending(items), Date.parse('2026-09-20T00:00:10.000Z'))
  assert.equal(oldestPending([]), null)
  assert.equal(oldestPending(null), null)
})

test('verdict 映射：动作 → 槽词汇 → 结果态', () => {
  assert.equal(verdictOf('approve'), 'accept')
  assert.equal(verdictOf('deny'), 'deny')
  assert.equal(verdictOf('x'), null)
  assert.equal(verdictStatus('accept'), 'approved')
  assert.equal(verdictStatus('deny'), 'denied')
  assert.equal(verdictStatus('expired'), null)
  assert.equal(statusLabelCode('approved'), 'approval_status_approved')
  assert.equal(statusLabelCode('denied'), 'approval_status_denied')
  assert.equal(statusLabelCode('expired'), 'approval_status_expired')
  assert.equal(statusLabelCode('pending'), 'approval_status_pending')
})

test('二次确认状态机：3s 内可确认，超时 / 清除即回退', () => {
  const idle = createConfirmState()
  assert.equal(confirmArmed(idle, CONFIRM_APPROVE_ALL, 1000), false)
  const armed = armConfirm(idle, CONFIRM_APPROVE_ALL, 1000)
  assert.equal(confirmArmed(armed, CONFIRM_APPROVE_ALL, 1000), true)
  assert.equal(confirmArmed(armed, CONFIRM_APPROVE_ALL, 3999), true)
  assert.equal(confirmArmed(armed, CONFIRM_APPROVE_ALL, 4000), false, '3s 超时回退')
  assert.equal(confirmArmed(armed, CONFIRM_DENY_ALL, 1000), false, '另一个按钮不共享确认态')
  assert.equal(confirmArmed(clearConfirm(), CONFIRM_APPROVE_ALL, 1000), false)
  assert.equal(confirmArmed(null, CONFIRM_APPROVE_ALL, 1000), false)
})

test('计数格式：k / M（≥1000 保留 1 位、去尾 .0）', () => {
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1200), '1.2k')
  assert.equal(formatCount(142000), '142k')
  assert.equal(formatCount(159000), '159k')
  assert.equal(formatCount(1500000), '1.5M')
  assert.equal(formatMetric(0.08, 'percent'), '8%')
  assert.equal(formatMetric(3.2, 'steps'), '3.2')
  assert.equal(formatMetric(4, 'steps'), '4')
})

test('指标增减：恶化 warning / 改善 success / 不变 muted', () => {
  assert.equal(metricTone(142000, 159000), 'warning')
  assert.equal(metricTone(0.08, 0.06), 'success')
  assert.equal(metricTone(0.02, 0.02), 'muted')
  assert.equal(deltaText(142000, 159000), '+12%')
  assert.equal(deltaText(0.08, 0.06), '-25%')
  assert.equal(deltaText(2, 2), '±0%')
  assert.equal(deltaText(0, 5), '')
})

const SHADOW = {
  rounds: 12,
  metrics: {
    token: { from: 142000, to: 159000 },
    steps: { from: 3.2, to: 4.1 },
    tool_failure: { from: 0.08, to: 0.06 },
    approval_rate: { from: 0.02, to: 0.02 },
  },
  diff: { nodes_added: 3, nodes_removed: 0, edges_added: 2, edges_removed: 1, items: [{ op: 'add_node', path: 'agent.step' }] },
}

test('影子指标对照：只呈现、不否决；缺失指标跳过', () => {
  const rows = shadowRows(SHADOW)
  assert.deepEqual(rows.map((row) => row.key), ['token', 'steps', 'tool_failure', 'approval_rate'])
  assert.deepEqual(rows[0], {
    key: 'token',
    code: 'approval_shadow_token',
    fromText: '142k',
    toText: '159k',
    delta: '+12%',
    tone: 'warning',
  })
  assert.equal(rows[2].tone, 'success')
  assert.equal(rows[3].tone, 'muted')
  assert.deepEqual(shadowRows(null), [])
  assert.deepEqual(shadowRows({ metrics: { token: { from: 1 } } }), [])
})

test('影子回放与图 diff 计数', () => {
  assert.equal(shadowRounds(SHADOW), 12)
  assert.equal(shadowRounds(null), null)
  const diff = diffCounts(SHADOW)
  assert.equal(diff.nodesAdded, 3)
  assert.equal(diff.edgesRemoved, 1)
  assert.equal(diff.items.length, 1)
  assert.equal(diffCounts(null), null)
})

test('shadowBodyOf：内联 body 与 {def} 引用两路', () => {
  const refs = { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { rounds: 3 } }
  const hash = Object.keys(refs)[0]
  assert.deepEqual(shadowBodyOf({ shadow: { def: hash } }, refs), { rounds: 3 })
  assert.equal(shadowBodyOf({ shadow: { def: hash } }, {}), null)
  assert.deepEqual(shadowBodyOf({ shadow: { rounds: 5 } }, null), { rounds: 5 })
  assert.equal(shadowBodyOf({}, refs), null)
})

test('摘要视图：tool_call / orchestration_change / plugin_write', () => {
  const tool = { kind: 'tool_call', port: 'tool-shell', tier: 'severe', args_ref: { summary: 'rm -rf build' } }
  assert.deepEqual(toolCallView(tool), { tool: 'tool-shell', args: 'rm -rf build', tier: 'severe' })
  assert.equal(argsSummaryOf({ args_ref: { sha256: 'abcdef0123456789' } }), 'abcdef012345')
  assert.equal(argsSummaryOf({}), '')

  const orch = { kind: 'orchestration_change', port: 'orchestration-admin', args_ref: { summary: 'agent.step → composite（+3 节点）' }, shadow: SHADOW }
  const orchView = orchestrationView(orch, null)
  assert.equal(orchView.title, 'agent.step → composite（+3 节点）')
  assert.equal(orchView.rounds, 12)
  assert.equal(orchView.rows.length, 4)
  assert.equal(orchView.diff.nodesAdded, 3)

  const write = {
    kind: 'plugin_write',
    port: 'plugin-admin',
    plugin: 'tool-fs',
    files: [{ path: 'execute/main.ts' }, { path: 'plugin.json' }, { path: 'terms/x.json' }],
    validate: { ok: true },
  }
  const writeView = pluginWriteView(write)
  assert.equal(writeView.plugin, 'tool-fs')
  assert.equal(writeView.count, 3)
  assert.equal(writeView.validate, true)
  assert.equal(writeView.isolationRisk, true)
  assert.equal(pluginWriteView({ file_count: 2, validate: false }).count, 2)
  assert.equal(pluginWriteView({ validate: false }).validate, false)

  assert.equal(viewOf(tool, null).kind, KIND_TOOL_CALL)
  assert.equal(viewOf(orch, null).kind, KIND_ORCHESTRATION_CHANGE)
  assert.equal(viewOf(write, null).kind, KIND_PLUGIN_WRITE)
})

test('文案：共享表优先、本地骨架兜底、未知码不空白', () => {
  const table = sharedTable()
  assert.ok(table !== null, '共享文案表应可解析')
  assert.equal(lookupMessage(table, 'approval_pending').body, '有调用在等待你的裁决。在停靠带处理。')
  assert.equal(lookupMessage(null, 'approval_waiting').body, UI_TEXT.approval_waiting)
  assert.equal(lookupMessage(null, 'no_such_code').body.includes('no_such_code'), true)
  assert.equal(parseMessages('not json'), null)
})

test('忙碌键集合：每项独立加入 / 移除，互不清除；身份视图拆 body/active', () => {
  let busy = []
  busy = withBusy(busy, 'a')
  busy = withBusy(busy, 'b')
  assert.deepEqual(busy, ['a', 'b'])
  busy = withBusy(busy, 'a')
  assert.deepEqual(busy, ['a', 'b'], '重复加入幂等')
  busy = withoutBusy(busy, 'a')
  assert.deepEqual(busy, ['b'], '移除 a 不影响 b')
  assert.deepEqual(withoutBusy(busy, 'x'), ['b'], '移除不存在键不变')

  const hash = 'e'.repeat(64)
  const view = { active: hash, body: { slots: {} } }
  assert.deepEqual(identityBody(view), { slots: {} })
  assert.equal(identityActive(view), hash)
  assert.equal(identityActive({ slots: {} }), undefined)
  assert.equal(isCodeGenFallbackBody({ tree: 'x' }), true)
  assert.equal(isCodeGenFallbackBody({ slots: {} }), false)
})

// ── 身份过滤：无稳定 id 的条目不得共享身份 / 撞 key ─────────────────────────

test('identifiedItems：只留有非空字符串 id 的条目并按 id 去重', () => {
  const items = [
    { id: 'a', kind: 'tool_call' },
    { id: 'a', kind: 'tool_call' },
    { id: 7, kind: 'tool_call' },
    { id: '', kind: 'tool_call' },
    { kind: 'tool_call' },
    null,
    'x',
    { id: 'b', kind: 'tool_call' },
  ]
  assert.deepEqual(identifiedItems(items).map((item) => item.id), ['a', 'b'])
  assert.deepEqual(identifiedItems(null), [])
  assert.deepEqual(identifiedItems('nope'), [])
})

// ── 条目文案组装（组件只渲染纯模块产出） ───────────────────────────────────

/** 测试翻译器：带变量时把变量值拼进码后（断言可预期）。 */
function fakeT(code, vars) {
  if (vars === undefined) return code
  return `${code}(${Object.values(vars).join(',')})`
}

test('摘要组装：主标签 / 摘要行 / 图 diff / 插件写入', () => {
  const tool = toolCallView({ kind: 'tool_call', port: 'tool-shell', args_ref: { summary: 'rm -rf build' } })
  const toolView = viewOf({ kind: 'tool_call', port: 'tool-shell', args_ref: { summary: 'rm -rf build' } }, null)
  assert.equal(summaryLead(toolView, fakeT), 'tool-shell')
  assert.equal(summaryText(toolView, fakeT), 'rm -rf build')
  assert.equal(summaryLead(viewOf({ kind: 'tool_call' }, null), fakeT), 'approval_tool_call')
  assert.equal(summaryText(viewOf({ kind: 'tool_call' }, null), fakeT), 'approval_no_args')
  assert.equal(tool.tool, 'tool-shell')

  const diff = diffCounts(SHADOW)
  assert.equal(diffLabel(diff, fakeT), 'approval_nodes_edges(+3+0,+2+1)')
  assert.equal(diffLabel(null, fakeT), '')
  assert.equal(graphDiffText(diff, fakeT), 'approval_graph_diff：approval_nodes_edges(+3+0,+2+1)')
  assert.equal(graphDiffText(null, fakeT), '')

  const writeItem = {
    kind: 'plugin_write',
    plugin: 'tool-fs',
    files: [{ path: 'a' }],
    validate: { ok: true },
  }
  const writeView = pluginWriteView(writeItem)
  assert.equal(pluginWriteSummary(writeView, fakeT), 'tool-fs · approval_files_count(1) · approval_validate_ok')
  assert.equal(summaryLead(viewOf(writeItem, null), fakeT), 'approval_plugin_write')

  const orchView = viewOf({ kind: 'orchestration_change', args_ref: { summary: 'T' }, shadow: SHADOW }, null)
  assert.equal(summaryLead(orchView, fakeT), 'approval_orchestration_change')
  assert.equal(summaryText(orchView, fakeT), 'T')
})

test('itemPresentation：一次算好视图 + 两行文案', () => {
  const item = { id: 'x', kind: 'tool_call', port: 'tool-shell', args_ref: { summary: 'ls' } }
  const presentation = itemPresentation(item, null, fakeT)
  assert.equal(presentation.view.kind, KIND_TOOL_CALL)
  assert.equal(presentation.lead, 'tool-shell')
  assert.equal(presentation.summary, 'ls')
})

test('diff / 文件行文本与稳定 key：同形条目也能区分', () => {
  assert.equal(diffItemText({ summary: 's' }), 's')
  assert.equal(diffItemText({ op: 'add_node', path: 'a' }), 'add_node a')
  assert.equal(diffItemText({ other: 1 }), JSON.stringify({ other: 1 }))
  assert.equal(diffItemKey({ op: 'add_node', path: 'a' }, 0), 'add_node a#0')
  assert.notEqual(diffItemKey({ op: 'add_node', path: 'a' }, 0), diffItemKey({ op: 'add_node', path: 'a' }, 1))
  assert.equal(diffItemKey({}, 2), 'item#2')

  assert.equal(fileText({ path: 'execute/main.ts' }), 'execute/main.ts')
  assert.equal(fileText({ other: 1 }), JSON.stringify({ other: 1 }))
  assert.equal(fileKey({ path: 'plugin.json' }, 0), 'plugin.json#0')
  assert.notEqual(fileKey({ path: 'plugin.json' }, 0), fileKey({ path: 'plugin.json' }, 1))
  assert.equal(fileKey({}, 3), 'file#3')
})

// ── store：错误来源决定重试目标 ─────────────────────────────────────────────

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeApprovalCtx(handlers) {
  return {
    tokens: { messages: '/assets/messages.v1.json' },
    events: { connected: () => true, onAny: () => () => {} },
    command: async (name) => (Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : { ok: true, value: null }),
    submit: async () => ({ ok: true, status: 'done' }),
  }
}

test('store：列表失败记 load 源并清 lastBatch，重试重拉列表', async () => {
  const ctx = fakeApprovalCtx({ 'approval.list': { ok: false, code: 'boom' } })
  const store = createApprovalStore(ctx)
  try {
    store.load()
    await flush()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.error.kind, 'load')
    assert.equal(snapshot.error.code, 'boom')
    assert.equal(snapshot.lastBatch, null, '列表错误清 lastBatch')
  } finally {
    store.dispose()
  }
})

// ── 停靠带整体状态：loading / offline / failed / empty / ready 互不混淆 ────────

test('状态判定：慢读、断连、显式失败、空队列、有项各归各态', () => {
  const base = { loading: false, error: null, connected: true, itemCount: 0 }
  assert.equal(approvalStatus({ ...base, loading: true }), 'loading')
  assert.equal(approvalStatus({ ...base, connected: false }), 'offline')
  assert.equal(approvalStatus({ ...base, error: { kind: 'load', code: 'boom' } }), 'failed')
  assert.equal(approvalStatus(base), 'empty')
  assert.equal(approvalStatus({ ...base, itemCount: 2 }), 'ready')
  // 断连优先于在途：插件不可达时不显示「读取中…」。
  assert.equal(approvalStatus({ ...base, loading: true, connected: false }), 'offline')
  // 传输中断 / 不可达归 offline，不归显式失败。
  assert.equal(approvalStatus({ ...base, error: { kind: 'load', code: 'ui_unreachable' } }), 'offline')
  assert.equal(approvalStatus({ ...base, error: { kind: 'load', code: 'transport_failed' } }), 'offline')
  // 有项时错误不遮蔽列表（错误在列表内就地显示）。
  assert.equal(approvalStatus({ ...base, itemCount: 2, error: { kind: 'batch', code: 'boom' } }), 'ready')
  assert.equal(isUnreachableCode('transport_failed'), true)
  assert.equal(isUnreachableCode('boom'), false)
  assert.equal(LOADING_NOTE_MS, 8000)
})

test('状态标题码：各态取不同文案码，ready / empty 无标题', () => {
  assert.equal(approvalStatusTextCode('loading'), 'approval_loading')
  assert.equal(approvalStatusTextCode('offline'), 'approval_offline')
  assert.equal(approvalStatusTextCode('failed'), 'approval_load_failed')
  assert.equal(approvalStatusTextCode('ready'), null)
  assert.equal(approvalStatusTextCode('empty'), null)
  assert.equal(UI_TEXT.approval_loading_more, '仍在读取…')
  assert.equal(typeof UI_TEXT.approval_offline, 'string')
  assert.equal(lookupMessage(null, 'approval_offline').body, UI_TEXT.approval_offline)
})

test('store：断连快照归 offline，恢复连接后可重拉', async () => {
  const ctx = fakeApprovalCtx({})
  ctx.events.connected = () => false
  const store = createApprovalStore(ctx)
  try {
    store.load()
    await flush()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.connected, false)
    assert.equal(
      approvalStatus({ loading: snapshot.loading, error: snapshot.error, connected: snapshot.connected, itemCount: 0 }),
      'offline',
    )
  } finally {
    store.dispose()
  }
})

test('store：批裁决失败记 batch 源并保留 lastBatch 供重试', async () => {
  const ctx = fakeApprovalCtx({
    'approval.list': { ok: true, value: { ok: true, items: [], refs: {} } },
    'input.read': { ok: true, value: { active: 'a'.repeat(64), body: { slots: {} } } },
    'approval.decide_all': { ok: false, code: 'boom' },
  })
  const store = createApprovalStore(ctx)
  try {
    store.load()
    await flush()
    store.submitAll('approve')
    await flush()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.error.kind, 'batch')
    assert.equal(snapshot.lastBatch, 'approve')
  } finally {
    store.dispose()
  }
})

test('store：裁决命令业务失败（value.ok=false）记 itemErrors，不当成功', async () => {
  const item = { id: 'ap-1', thread: 't1', kind: 'tool_call', status: 'pending' }
  const ctx = fakeApprovalCtx({
    'approval.list': { ok: true, value: { ok: true, items: [item], refs: {} } },
    'input.read': { ok: true, value: { active: 'a'.repeat(64), body: { slots: {} } } },
    'approval.decide': { ok: true, status: 'done', value: { ok: false, error: { code: 'bad_slot' } } },
  })
  const store = createApprovalStore(ctx)
  try {
    store.submitItem(item, 'approve')
    await flush()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.itemErrors['ap-1'].code, 'bad_slot')
    assert.equal(snapshot.busy.length, 0, '失败后清忙碌键')
  } finally {
    store.dispose()
  }
})

test('store：裁决 run 被拒（status=refused）记 itemErrors，不当成功', async () => {
  const item = { id: 'ap-2', thread: 't1', kind: 'tool_call', status: 'pending' }
  const ctx = fakeApprovalCtx({
    'approval.list': { ok: true, value: { ok: true, items: [item], refs: {} } },
    'input.read': { ok: true, value: { active: 'a'.repeat(64), body: { slots: {} } } },
    'approval.decide': { ok: true, status: 'refused', value: null },
  })
  const store = createApprovalStore(ctx)
  try {
    store.submitItem(item, 'approve')
    await flush()
    assert.equal(store.getSnapshot().itemErrors['ap-2'].code, 'refused')
  } finally {
    store.dispose()
  }
})
