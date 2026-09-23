// 浏览器视图层纯函数测试（node --test）：模板选择、摘要视图、影子指标、计时格式、
// 二次确认状态机、expired 弱化、verdict 映射、文案兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
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
  elapsedMs,
  formatCount,
  formatMetric,
  formatWait,
  isExpired,
  isPending,
  itemTone,
  KIND_ORCHESTRATION_CHANGE,
  KIND_PLUGIN_WRITE,
  KIND_TOOL_CALL,
  metricTone,
  oldestPending,
  orchestrationView,
  pendingCount,
  pluginWriteView,
  selectTemplate,
  shadowBodyOf,
  shadowRounds,
  shadowRows,
  statusLabelCode,
  toolCallView,
  verdictOf,
  verdictStatus,
  viewOf,
  waitWarning,
} from '../execute/web/model.ts'
import { lookupMessage, parseMessages, UI_TEXT } from '../execute/web/messages.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHARED_MESSAGES = resolve(HERE, '..', '..', 'ui-shell', 'execute', 'web', 'messages.v1.json')

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
