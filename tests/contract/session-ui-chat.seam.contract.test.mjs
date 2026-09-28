// 接缝契约 8：session ↔ ui-chat。
// 共享真源：chain-contract/fixtures/step-records.json（步记录 → 展示 parts）与 session-slices.json（消息 parts 形状）。
// 消费方向：真实 ui-chat 渲染模型（纯函数）消费真实 session 的展示投影（消息 parts / 回合结局）。
// 供给方向：真实 session 落盘 loop-policy 折叠出的 `view.display` parts（reasoning / tool）。
// 至少一侧为真实服务：session 侧为真实服务；ui-chat 是浏览器半边纯模块，无服务进程可起，属文档化限制。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stepRecords } from '../../chain-contract/fixtures/index.ts'
import { restoreFromSteps } from '../../plugins/loop-policy/execute/reconstruct.ts'
import { displayParts } from '../../plugins/loop-policy/execute/commit-parts.ts'
import { restoreMessages, messageId, messageText, conversationTurns } from '../../plugins/ui-chat/execute/web/history-model.ts'
import { toolCardViewModel } from '../../plugins/ui-chat/execute/web/tool-card.ts'
import { normalizeOutcome, resolveDisplayOutcome } from '../../plugins/ui-chat/execute/web/thread-store.ts'
import { startRealService, stopRealService, makeRouter, FIXED_ENV } from './_bridge.mjs'

let dirSeq = 0
function tempDataDir() {
  dirSeq += 1
  return mkdtempSync(join(tmpdir(), `seam-ui-chat-${process.pid}-${dirSeq}-`))
}

function startSession(dir) {
  return startRealService({
    name: 'session',
    env: { CHRONO_PLUGIN_DATA: dir, CHRONO_PLUGIN_STATE: dir },
    onPortCall: makeRouter({ 'input.clear': () => ({ ok: true }) }),
  })
}

async function value(service, port, method, args, env = FIXED_ENV) {
  const frame = await service.call(port, method, args, env)
  assert.equal(frame.kind, 'result', JSON.stringify(frame))
  return frame.value
}

/** loop-policy 真实折叠函数把夹具步记录还原成展示 parts（`view.display`）。 */
function displayPartsOfFixtureSteps() {
  const INTENT = stepRecords.find((record) => record.type === 'step.intent')
  const RESULT = stepRecords.find((record) => record.type === 'step.result')
  const CHECKPOINT = stepRecords.find((record) => record.type === 'checkpoint')
  const { rs } = restoreFromSteps([INTENT, RESULT, CHECKPOINT])
  return displayParts(rs.extraMessages, null, [])
}

test('消费向：真实 ui-chat 渲染模型消费真实 session 的展示投影（消息 parts + 回合结局）', async () => {
  const dir = tempDataDir()
  const session = startSession(dir)
  try {
    await session.hello()
    const parts = displayPartsOfFixtureSteps()
    // 展示 parts 须含工具卡（loop-policy 的 view.display 形状）。
    assert.ok(parts.some((part) => part.type === 'tool' && part.call_id === 'call-0'), JSON.stringify(parts))

    // 供给方向：真实 session 落盘这些 parts。
    const committed = await value(session, 'session', 'commit', {
      slot: { kind: 'chat.message', text: '看看 foo.ts 第 42 行' },
      user: { content: '看看 foo.ts 第 42 行' },
      assistant: { content: '', parts },
      new_conversation: { id: 'c-seam-8', workspace_id: 'w-1', title: 'seam8' },
      conversation: 'c-seam-8',
    })
    assert.equal(committed.ok, true, JSON.stringify(committed))

    // 消费方向：ui-chat 的展示还原读真实 session 的 history 投影。
    const history = await value(session, 'session', 'history', { conversation: 'c-seam-8' })
    const messages = restoreMessages(history, history.conversation === 'c-seam-8' ? { head: { def: history.messages[0].hash } } : null)
    const assistant = messages.find((entry) => entry.def?.role === 'assistant')
    assert.ok(assistant !== undefined, JSON.stringify(messages))
    assert.ok(Array.isArray(assistant.def.parts), '展示 parts 须随历史还原')
    // 渲染器按 part.render / status 画工具卡：ui-chat 纯函数能消费该 part。
    const toolPart = assistant.def.parts.find((part) => part.type === 'tool')
    const card = toolCardViewModel(toolPart)
    assert.equal(card.label, 'fs.read')
    assert.equal(card.status, 'ok')
    // 消息 id 兜底可用（渲染锚点 / key）。
    assert.ok(messageId(assistant).length > 0)
    assert.equal(typeof messageText(assistant.def), 'string')
  } finally {
    await stopRealService(session)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('消费向：取消形态（ui-chat 结局映射可消费）', async () => {
  const dir = tempDataDir()
  const session = startSession(dir)
  const CONV = 'c-seam-8c'
  try {
    await session.hello()
    const opened = await value(session, 'session', 'turn_open', {
      turn_id: 't-c8',
      user_message: { role: 'user', content: 'cancel me' },
      slot_ref: 'run-c8',
      thread_id: 't1',
      new_conversation: { id: CONV, workspace_id: 'w-1', title: 'seam8c' },
    })
    assert.equal(opened.status, 'created')
    assert.equal((await value(session, 'session', 'turn_cancel', { turn_id: 't-c8' })).ok, true)
    // 落定取消结局后读回。
    assert.equal((await value(session, 'session', 'turn_settle', { turn_id: 't-c8', outcome: { kind: 'cancelled', code: 'cancelled', attributableTo: 'owner', retryable: false, cause: null } })).ok, true)
    const turns = conversationTurns(await value(session, 'session', 'history', { conversation: CONV }))
    const cancelled = turns.find((item) => item.outcome?.kind === 'cancelled')
    assert.ok(cancelled !== undefined, JSON.stringify(turns))
    // ui-chat 的结局映射接受 session 的结局形状（按结局分支渲染，不静默当成功）。
    assert.equal(resolveDisplayOutcome(null, normalizeOutcome(cancelled.outcome)).kind, 'cancelled')
  } finally {
    await stopRealService(session)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('消费向：中断形态（启动收口，ui-chat 结局映射可消费）', async () => {
  const dir = tempDataDir()
  const CONV = 'c-seam-8i'
  const first = startSession(dir)
  try {
    await first.hello()
    const opened = await value(first, 'session', 'turn_open', {
      turn_id: 't-i8',
      user_message: { role: 'user', content: 'interrupt me' },
      slot_ref: 'run-i8',
      thread_id: 't1',
      new_conversation: { id: CONV, workspace_id: 'w-1', title: 'seam8i' },
    })
    assert.equal(opened.status, 'created')
  } finally {
    await stopRealService(first)
  }
  const second = startSession(dir)
  try {
    await second.hello()
    const turns = conversationTurns(await value(second, 'session', 'history', { conversation: CONV }))
    const interrupted = turns.find((item) => item.outcome?.kind === 'interrupted')
    assert.ok(interrupted !== undefined, JSON.stringify(turns))
    assert.equal(interrupted.outcome.retryable, true)
    assert.equal(resolveDisplayOutcome(null, normalizeOutcome(interrupted.outcome)).kind, 'interrupted')
  } finally {
    await stopRealService(second)
    rmSync(dir, { recursive: true, force: true })
  }
})
