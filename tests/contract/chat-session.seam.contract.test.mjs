// 接缝契约 2：chat ↔ session。
// 共享真源：chain-contract/fixtures/step-records.json（turn.open 等真实形状）。
// 消费方向：真实 session 服务消费 turn_open / step_append / turn_settle（含 CAS 拒绝、already_open、turn_busy）。
// 供给方向：真实 chat 服务消费真实 session 服务回帧（turn_busy、already_open 已收口）。
// 至少一侧为真实服务：两个方向都起真实 session 服务；供给方向另起真实 chat 服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stepRecords } from '../../chain-contract/fixtures/index.ts'
import { validateStepRecord } from '../../chain-contract/src/runtime.ts'
import { startRealService, makeRouter, relayFrame, FIXED_ENV } from './_bridge.mjs'

let dirSeq = 0
function tempDataDir() {
  dirSeq += 1
  return mkdtempSync(join(tmpdir(), `seam-session-${process.pid}-${dirSeq}-`))
}

function startSession(dataDir, extra = {}) {
  return startRealService({
    name: 'session',
    env: { CHRONO_PLUGIN_DATA: dataDir, CHRONO_PLUGIN_STATE: dataDir },
    onPortCall: makeRouter({ 'input.clear': () => ({ ok: true }), ...extra }),
  })
}

const OPEN = stepRecords.find((record) => record.type === 'turn.open')
const INTENT = stepRecords.find((record) => record.type === 'step.intent')
const RESULT = stepRecords.find((record) => record.type === 'step.result')
const CHECKPOINT = stepRecords.find((record) => record.type === 'checkpoint')
const SETTLE = stepRecords.find((record) => record.type === 'turn.settle')

const TURN_ID = OPEN.turn_id
const CONV = OPEN.conv

function openArgs(overrides = {}) {
  return {
    turn_id: TURN_ID,
    user_message: OPEN.user_message,
    slot_ref: OPEN.slot_ref,
    thread_id: 't1',
    new_conversation: { id: CONV, workspace_id: 'w-1', title: 'seam' },
    ...overrides,
  }
}

async function value(service, port, method, args, env = FIXED_ENV) {
  const frame = await service.call(port, method, args, env)
  assert.equal(frame.kind, 'result', JSON.stringify(frame))
  return frame.value
}

test('夹具步记录先过共享契约校验（唯一夹具源）', () => {
  for (const record of [OPEN, INTENT, RESULT, CHECKPOINT, SETTLE]) {
    const checked = validateStepRecord(record)
    assert.equal(checked.ok, true, `${record.type}: ${JSON.stringify(checked.outcome)}`)
  }
})

test('消费向：真实 session 消费 turn_open / step_append / turn_settle 全路径', async () => {
  const dir = tempDataDir()
  const session = startSession(dir)
  try {
    await session.hello()
    const opened = await value(session, 'session', 'turn_open', openArgs())
    assert.equal(opened.ok, true, JSON.stringify(opened))
    assert.equal(opened.status, 'created')

    // 同 turn_id 再开：already_open（不新开、不重跑）。
    const again = await value(session, 'session', 'turn_open', openArgs())
    assert.equal(again.status, 'already_open')
    assert.equal(again.state, 'open')

    // 同会话不同槽：turn_busy（服务端互斥兜底）。
    const busy = await value(session, 'session', 'turn_open', openArgs({ turn_id: 't-other', slot_ref: 'run-other' }))
    assert.equal(busy.ok, false)
    assert.equal(busy.status, 'turn_busy')
    assert.equal(busy.reason, 'turn_busy')
    assert.equal(busy.busy_turn_id, TURN_ID)

    // 步记录逐条消费（intent / result / checkpoint 共用 seq，按 (turn_id,type,seq) 去重）。
    for (const record of [INTENT, RESULT, CHECKPOINT]) {
      const appended = await value(session, 'session', 'step_append', record)
      assert.equal(appended.ok, true, `${record.type}: ${JSON.stringify(appended)}`)
      assert.equal(appended.deduped, false)
    }
    const dup = await value(session, 'session', 'step_append', INTENT)
    assert.equal(dup.ok, true)
    assert.equal(dup.deduped, true, '同 (turn_id,type,seq) 须去重')

    // CAS 收口：首次生效，迟到被拒。
    const settled = await value(session, 'session', 'turn_settle', { turn_id: TURN_ID, outcome: SETTLE.outcome })
    assert.equal(settled.ok, true)
    const late = await value(session, 'session', 'turn_settle', {
      turn_id: TURN_ID,
      outcome: { kind: 'cancelled', code: 'cancelled', attributableTo: 'owner', retryable: false, cause: null },
    })
    assert.equal(late.ok, false)
    assert.equal(late.reason, 'already_settled')
    assert.equal(late.rejected, true)

    // 收口后不可再追加步记录。
    const notOpen = await value(session, 'session', 'step_append', INTENT)
    assert.equal(notOpen.ok, false)
    assert.equal(notOpen.reason, 'not_open')

    // 读回：回合视图含结局与步记录。
    const read = await value(session, 'session', 'read', {})
    const turn = read.turns.find((item) => item.turn_id === TURN_ID)
    assert.ok(turn !== undefined)
    assert.equal(turn.state, 'settled')
    assert.equal(turn.outcome.kind, 'committed')
    assert.equal(turn.steps.length, 3)
  } finally {
    session.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('消费向：真实 session 启动收口 open 回合为 interrupted', async () => {
  const dir = tempDataDir()
  const first = startSession(dir)
  try {
    await first.hello()
    await value(first, 'session', 'turn_open', openArgs({ turn_id: 't-open', slot_ref: 'run-open' }))
  } finally {
    first.close()
  }
  const second = startSession(dir)
  try {
    await second.hello()
    const read = await value(second, 'session', 'read', { conversation: CONV })
    const open = read.turns.find((item) => item.turn_id === 't-open')
    assert.equal(open.state, 'settled')
    assert.equal(open.outcome.kind, 'interrupted')
    assert.equal(open.outcome.retryable, true)
  } finally {
    second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('消费向：真实 session 启动收口已落取消意图的回合为 cancelled', async () => {
  const dir = tempDataDir()
  const first = startSession(dir)
  try {
    await first.hello()
    const opened = await value(first, 'session', 'turn_open', openArgs({ turn_id: 't-cancel', slot_ref: 'run-cancel' }))
    assert.equal(opened.status, 'created')
    const cancelled = await value(first, 'session', 'turn_cancel', { turn_id: 't-cancel' })
    assert.equal(cancelled.ok, true)
  } finally {
    first.close()
  }
  const second = startSession(dir)
  try {
    await second.hello()
    const read = await value(second, 'session', 'read', { conversation: CONV })
    const turn = read.turns.find((item) => item.turn_id === 't-cancel')
    assert.equal(turn.state, 'settled')
    assert.equal(turn.outcome.kind, 'cancelled')
  } finally {
    second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('供给向：真实 chat 消费真实 session 回帧（turn_busy / already_open 已收口）', async () => {
  const dir = tempDataDir()
  const session = startSession(dir)
  const configBody = {
    vendor: 'anthropic',
    model: 'claude-sonnet-4-6',
    base_url: 'http://127.0.0.1:1',
    params: { max_tokens: 64 },
    providers: {
      anthropic: {
        name: 'anthropic',
        protocol: 'anthropic-messages',
        base_url: 'http://127.0.0.1:1',
        models: { 'claude-sonnet-4-6': { name: 'claude-sonnet-4-6', context_window: 100000, max_output: 64 } },
      },
    },
  }
  const slot = { kind: 'chat.message', text: 'hi', workspace_id: 'w-1', conversation_id: CONV }
  const routes = {
    'session.read': (args, message) => session.call('session', 'read', args, message.env).then(relayFrame),
    'session.turn_open': (args, message) => session.call('session', 'turn_open', args, message.env).then(relayFrame),
    'session.turn_settle': (args, message) => session.call('session', 'turn_settle', args, message.env).then(relayFrame),
    'input.read': () => ({ slots: { t1: slot }, slot_ref: 'run-seam' }),
    'short-memory.read': () => ({ version: 1, sessions: {}, workspaces: {} }),
    'todo.invoke': () => ({ ok: true, result: { items: [] } }),
    'config.read': () => ({ body: configBody }),
    'mcp.read': () => ({ tools: [] }),
    'workspace.read': () => ({ workspaces: [{ id: 'w-1', path: '/repo' }] }),
    'skill.read': () => ({ skills: [] }),
  }
  const chat = startRealService({ name: 'chat', onPortCall: makeRouter(routes) })
  try {
    await chat.hello()
    // 预置一个占用会话的开态回合（不同槽）。
    const pre = await value(session, 'session', 'turn_open', openArgs({ turn_id: 't-busy', slot_ref: 'run-busy' }))
    assert.equal(pre.status, 'created')

    const busyFrame = await chat.call('chat', 'send', { ids: {} }, FIXED_ENV)
    assert.equal(busyFrame.kind, 'result', JSON.stringify(busyFrame))
    const busy = busyFrame.value.$directives[0].payload
    assert.equal(busy.ok, false)
    assert.equal(busy.outcome.code, 'turn_busy')
    assert.equal(busy.outcome.retryable, true, 'turn_busy 可重试（槽保留）')

    // 收口 busy 回合并换成 chat 自己的槽（slot_ref `run-seam` → turn_id `t-run-seam`）：
    // 再开即 already_open(settled)，chat 回执已有结局、不重跑。
    await value(session, 'session', 'turn_settle', { turn_id: 't-busy', outcome: SETTLE.outcome })
    const before = await value(session, 'session', 'turn_open', openArgs({ turn_id: 't-run-seam', slot_ref: 'run-seam' }))
    assert.equal(before.status, 'created')
    await value(session, 'session', 'turn_settle', { turn_id: 't-run-seam', outcome: SETTLE.outcome })

    const dupFrame = await chat.call('chat', 'send', { ids: {} }, FIXED_ENV)
    assert.equal(dupFrame.kind, 'result', JSON.stringify(dupFrame))
    const dup = dupFrame.value.$directives[0].payload
    assert.equal(dup.duplicate, true)
    assert.equal(dup.status, 'settled')
    assert.equal(dup.outcome.kind, 'committed')
    assert.equal(dup.turn_id, 't-run-seam')
  } finally {
    chat.close()
    session.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
