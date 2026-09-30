// session durable store unit tests: append-only replay, idempotency, turn markers (partial state),
// and the 3/4 split (derived index rebuild). Uses a temp CHRONO_PLUGIN_DATA / CHRONO_PLUGIN_STATE.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPEND_RETRY_DELAYS_MS, SessionStore, isSafeConversationId } from '../execute/store.ts'
import { createHandlers } from '../execute/methods.ts'

function envFor(root) {
  return { CHRONO_PLUGIN_DATA: join(root, 'data'), CHRONO_PLUGIN_STATE: join(root, 'state') }
}

const AT = '2026-01-01T00:00:00.000Z'
const COMMITTED = { kind: 'committed', code: null, attributableTo: null, retryable: false, cause: null }
const CANCELLED = { kind: 'cancelled', code: 'cancelled', attributableTo: 'owner', retryable: false, cause: null }

function turnOpenRecord(turnId, slotRef, extra = {}) {
  return {
    type: 'turn.open',
    turn_id: turnId,
    conv: 'c1',
    user_message: { content: 'hi' },
    slot_ref: slotRef,
    at: AT,
    ...extra,
  }
}

// 契约步记录形状的本地复刻（不复刻 validateStepRecord 的实现，只取同一形状约束）。
const STEP_SPECS = {
  'turn.open': {
    required: ['type', 'turn_id', 'conv', 'user_message', 'slot_ref', 'at'],
    types: { turn_id: 'string', conv: 'string', user_message: 'object', slot_ref: 'string', at: 'string' },
  },
  'step.intent': {
    required: ['type', 'turn_id', 'seq', 'kind', 'tool_calls'],
    types: { turn_id: 'string', kind: 'string', tool_calls: 'array' },
  },
  'step.result': {
    required: ['type', 'turn_id', 'seq'],
    types: { turn_id: 'string', assistant: 'object', tool_results: 'array', reasoning: 'object', usage: 'object' },
  },
  checkpoint: {
    required: ['type', 'turn_id', 'seq', 'summary', 'covered_upto'],
    types: { turn_id: 'string', summary: 'object' },
  },
  'turn.settle': {
    required: ['type', 'turn_id', 'outcome'],
    types: { turn_id: 'string' },
  },
}
const OUTCOME_KINDS = ['committed', 'refused', 'cancelled', 'interrupted']
const OUTCOME_CODES = [
  'budget_exceeded', 'budget_impossible', 'cancelled', 'capability_mismatch', 'contract_version_mismatch',
  'downstream_refusal', 'empty_slot', 'interrupted', 'invalid_contract', 'loop_unavailable', 'model_not_configured',
  'model_timeout', 'no_plan', 'owner_unavailable', 'too_many_rounds', 'transport_failed', 'turn_busy', 'workspace_missing',
]
const ATTRIBUTABLE_TO = ['model', 'tool', 'guard', 'approval', 'graph', 'owner', 'transport', 'budget']

function assertContractStepRecord(record) {
  const spec = STEP_SPECS[record.type]
  assert.ok(spec, `unknown step record type: ${record.type}`)
  for (const key of spec.required) assert.ok(Object.hasOwn(record, key), `${record.type}.${key} missing`)
  for (const [key, kind] of Object.entries(spec.types)) {
    const value = record[key]
    if (value === undefined || value === null) continue
    if (kind === 'object') assert.ok(typeof value === 'object' && !Array.isArray(value), `${record.type}.${key} must be object`)
    else if (kind === 'array') assert.ok(Array.isArray(value), `${record.type}.${key} must be array`)
    else assert.equal(typeof value, kind, `${record.type}.${key} must be ${kind}`)
  }
  if (record.seq !== undefined) assert.ok(Number.isInteger(record.seq), `${record.type}.seq must be integer`)
  if (record.type === 'checkpoint') {
    assert.ok(typeof record.covered_upto === 'string' || Number.isInteger(record.covered_upto), 'checkpoint.covered_upto')
  }
  if (record.type === 'turn.settle') {
    const outcome = record.outcome
    assert.ok(OUTCOME_KINDS.includes(outcome.kind), 'outcome.kind')
    if (outcome.kind === 'committed') {
      assert.ok(outcome.code === undefined || outcome.code === null, 'committed outcome.code must be null')
      assert.ok(outcome.attributableTo === undefined || outcome.attributableTo === null, 'committed attributableTo must be null')
    } else {
      assert.ok(OUTCOME_CODES.includes(outcome.code), 'outcome.code not in closed set')
      assert.ok(ATTRIBUTABLE_TO.includes(outcome.attributableTo), 'outcome.attributableTo not in closed set')
    }
  }
}

test('append then replay: conversation and messages round-trip', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1', workspace_id: 'w1', title: 't' })
    store.setCurrent('r1', 'c1')
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'hi', prev: null, at: 'now' })
    store.appendMessage('r1', 'c1', { id: 'm2', role: 'assistant', content: 'yo', prev: { def: 'm1' }, at: 'now' })
    const reopened = SessionStore.open(env)
    assert.equal(reopened.currentId(), 'c1')
    assert.equal(reopened.messagesOf('c1').length, 2)
    const conversation = reopened.conversation('c1')
    assert.equal(conversation.head.def, 'm2')
    assert.equal(conversation.count, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('message append is idempotent by id; slot overwrite is last-wins', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'a', prev: null, at: 'now' })
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'a', prev: null, at: 'now' })
    assert.equal(store.messagesOf('c1').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn markers: an open turn without close is identifiable after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1' })
    // Simulate an interrupted turn: open + one message written, no close.
    store.turnOpen('run-interrupted', 'c1')
    store.appendMessage('run-interrupted', 'c1', { id: 'm1', role: 'user', content: 'half', prev: null, at: 'now' })
    assert.deepEqual(store.pendingTurns(), ['run-interrupted'])
    const reopened = SessionStore.open(env)
    assert.deepEqual(reopened.pendingTurns(), ['run-interrupted'])
    // Closing the turn clears the residue.
    reopened.turnClose('run-interrupted')
    assert.deepEqual(reopened.pendingTurns(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('derived index deletion does not affect replay from the durable log', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1' })
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'x', prev: null, at: 'now' })
    rmSync(join(root, 'state'), { recursive: true, force: true })
    const reopened = SessionStore.open(env)
    assert.equal(reopened.messagesOf('c1').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('torn trailing line is skipped (fail-open)', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1' })
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'x', prev: null, at: 'now' })
    // Append a torn line (no trailing newline) to simulate an interrupted write.
    writeFileSync(join(root, 'data', 'conversations', 'c1', 'log.jsonl'), '{"t":"msg","conv":"c1","msg":{"id":"m2"', { flag: 'a' })
    const reopened = SessionStore.open(env)
    assert.equal(reopened.messagesOf('c1').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('selection: no current (or current soft-deleted) resolves to empty, not the first conversation', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1', title: 'a' })
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'hi', prev: null, at: 'now' })
    store.upsertConversation('r1', { id: 'c2', title: 'b' })
    // No current: history(null) must not fall back to the first conversation.
    assert.equal(store.history(null, null, null).conversation, null)
    assert.deepEqual(store.history(null, null, null).messages, [])
    assert.equal(store.slice(null).head, null)
    // Explicit id still resolves (even a soft-deleted one).
    assert.equal(store.history('c1', null, null).conversation, 'c1')
    // current pointing at a soft-deleted conversation resolves to empty.
    store.setCurrent('r1', 'c1')
    store.softDelete('r1', 'c1', '2026-01-01')
    assert.equal(store.history(null, null, null).conversation, null)
    assert.equal(store.slice(null).head, null)
    assert.equal(store.history('c1', null, null).conversation, 'c1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// -- turn event log ----------------------------------------------------------

test('turn log: openTurn is idempotent by slot_ref; appendStep dedupes by (turn_id, type, seq)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.upsertConversation(null, { id: 'c1' })
    const first = await store.openTurn(turnOpenRecord('t1', 'run-1'))
    assert.equal(first.status, 'created')
    // A second open with a different turn id but the same slot returns the first turn.
    const second = await store.openTurn(turnOpenRecord('t2', 'run-1'))
    assert.equal(second.status, 'already_open')
    assert.equal(second.state, 'open')
    assert.equal(second.turn_id, 't1')
    assert.deepEqual(store.openTurnIds(), ['t1'])
    // The user message is keyed by turn id (not run).
    assert.equal(store.messagesOf('c1').length, 1)
    assert.equal(store.messagesOf('c1')[0].id, 'msg-c1-t1-user')

    const intent = { type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step', tool_calls: [] }
    assert.equal(await store.appendStep(intent), 'appended')
    assert.equal(await store.appendStep(intent), 'exists')
    assert.equal(store.turn('t1').steps.length, 1)
    // A step for an unknown turn is not recorded.
    assert.equal(await store.appendStep({ ...intent, turn_id: 'nope' }), 'not_found')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn log: step.result upserts one assistant message per turn_id (resume updates, not appends)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.upsertConversation(null, { id: 'c1' })
    await store.openTurn(turnOpenRecord('t1', 'run-1'))
    await store.appendStep({
      type: 'step.result',
      turn_id: 't1',
      seq: 0,
      assistant: { content: 'working', parts: [{ type: 'tool', call_id: 'call-1', status: null }] },
    })
    await store.appendStep({
      type: 'step.result',
      turn_id: 't1',
      seq: 1,
      assistant: { content: 'done', parts: [{ type: 'tool', call_id: 'call-1', status: 'ok' }] },
    })
    const messages = store.messagesOf('c1')
    const assistants = messages.filter((message) => message.role === 'assistant')
    assert.equal(assistants.length, 1)
    assert.equal(assistants[0].id, 'msg-c1-t1-assistant')
    assert.equal(assistants[0].content, 'done')
    assert.equal(assistants[0].parts[0].status, 'ok')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn log: settle is CAS-guarded — exactly one winner; late settles are recorded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.upsertConversation(null, { id: 'c1' })
    await store.openTurn(turnOpenRecord('t1', 'run-1'))

    const [winner, loser] = await Promise.all([
      store.settle('t1', COMMITTED),
      store.settle('t1', CANCELLED),
    ])
    assert.equal(winner.status, 'settled')
    assert.equal(loser.status, 'late')
    const view = store.turn('t1')
    assert.equal(view.state, 'settled')
    assert.equal(view.outcome.kind, 'committed')
    assert.equal(view.late_settles.length, 1)
    assert.equal(view.late_settles[0].kind, 'cancelled')
    assert.deepEqual(store.openTurnIds(), [])

    // Settling after a terminal outcome is rejected and recorded, not dropped.
    const after = await store.settle('t1', CANCELLED)
    assert.equal(after.status, 'late')
    assert.equal(store.turn('t1').outcome.kind, 'committed')
    assert.equal(store.turn('t1').late_settles.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn log: startup settles open turns as interrupted{retryable:true}; a late real settle overwrites it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation(null, { id: 'c1' })
    await store.openTurn(turnOpenRecord('t1', 'run-1'))

    const reopened = SessionStore.open(env)
    const view = reopened.turn('t1')
    assert.equal(view.state, 'settled')
    assert.equal(view.outcome.kind, 'interrupted')
    assert.equal(view.outcome.retryable, true)
    assert.deepEqual(reopened.openTurnIds(), [])

    const late = await reopened.settle('t1', COMMITTED)
    assert.equal(late.status, 'settled')
    assert.equal(reopened.turn('t1').outcome.kind, 'committed')
    assert.equal(reopened.turn('t1').late_settles.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn log: persistent records are append-only and validate against the step-record shape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    await store.openTurn(turnOpenRecord('t1', 'run-1', { new_conversation: { id: 'c1' } }))
    await store.appendStep({ type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step', tool_calls: [{ id: 'a', name: 'fs.read', arguments: {} }] })
    await store.appendStep({ type: 'step.result', turn_id: 't1', seq: 0, assistant: { content: 'ok' }, usage: { prompt_tokens: 1 } })
    await store.appendStep({ type: 'checkpoint', turn_id: 't1', seq: 1, summary: { goal: 'g' }, covered_upto: 0 })
    await store.settle('t1', COMMITTED)

    const lines = readFileSync(join(root, 'data', 'conversations', 'c1', 'log.jsonl'), 'utf8').split('\n').filter((line) => line.length > 0)
    const records = lines.map((line) => JSON.parse(line))
    const stepRecords = records.filter((record) => typeof record.type === 'string')
    assert.equal(stepRecords.length, 5)
    for (const record of stepRecords) assertContractStepRecord(record)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn log: concurrent opens in one conversation — exactly one created, the other turn_busy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.upsertConversation(null, { id: 'c1' })
    const [a, b] = await Promise.all([
      store.openTurn(turnOpenRecord('t-a', 'run-a')),
      store.openTurn(turnOpenRecord('t-b', 'run-b')),
    ])
    assert.deepEqual([a.status, b.status].sort(), ['created', 'turn_busy'])
    // 会话内互斥：只留一个开态回合，败者不追加第二条回合头。
    assert.deepEqual(store.openTurnIds(), [a.status === 'created' ? 't-a' : 't-b'])
    const busy = a.status === 'turn_busy' ? a : b
    const winner = a.status === 'created' ? a : b
    assert.equal(busy.busy_turn_id, winner.turn_id)
    assert.equal(store.messagesOf('c1').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn log: a settled turn for the same slot replays as already_open with its outcome, no new turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.upsertConversation(null, { id: 'c1' })
    await store.openTurn(turnOpenRecord('t1', 'run-1'))
    await store.appendStep({ type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step', tool_calls: [] })
    await store.settle('t1', COMMITTED)

    // 重发同一回合身份（同 turn_id）与同一槽（不同 turn_id 但同 slot_ref）都只回既有回合。
    const byId = await store.openTurn(turnOpenRecord('t1', 'run-1'))
    assert.equal(byId.status, 'already_open')
    assert.equal(byId.state, 'settled')
    assert.equal(byId.outcome.kind, 'committed')
    const bySlot = await store.openTurn(turnOpenRecord('t2', 'run-1'))
    assert.equal(bySlot.status, 'already_open')
    assert.equal(bySlot.turn_id, 't1')
    assert.equal(bySlot.state, 'settled')
    assert.deepEqual(store.openTurnIds(), [])
    // 不重跑：回合只有一条，步记录未被重复追加。
    assert.equal(store.messagesOf('c1').length, 1)
    assert.equal(store.turn('t1').steps.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn log: append failure is not recorded and the fail-closed path settles refused{owner_unavailable}', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const fault = { failing: false, attempts: 0 }
    const append = () => {
      if (fault.failing) {
        fault.attempts += 1
        throw new Error('append failed')
      }
    }
    const store = SessionStore.open(envFor(root), { append, sleep: async () => {} })
    const port = { call: async () => ({ ok: true, value: { ok: true } }) }
    const handlers = createHandlers({ port, store })
    const env = { run: 'run-1', thread: 't1', now: Date.parse(AT), emitter: 'test' }

    const opened = await handlers['turn_open'](
      { turn_id: 't1', user_message: { content: 'hi' }, slot_ref: 'run-1', new_conversation: { id: 'c1', workspace_id: 'w1' }, thread_id: 't1' },
      env,
    )
    assert.equal(opened.value.ok, true)

    fault.failing = true
    const result = await handlers['step_append'](
      { type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step', tool_calls: [] },
      env,
    )
    assert.equal(result.value.ok, false)
    assert.equal(result.value.outcome.kind, 'refused')
    assert.equal(result.value.outcome.code, 'owner_unavailable')
    assert.equal(result.value.outcome.attributableTo, 'owner')
    // The step is not treated as executed, and the turn stops as refused.
    assert.equal(store.turn('t1').steps.length, 0)
    assert.equal(store.turn('t1').state, 'settled')
    assert.equal(store.turn('t1').outcome.code, 'owner_unavailable')
    assert.ok(fault.attempts >= APPEND_RETRY_DELAYS_MS.length, 'append was retried a bounded number of times')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turn log: a subagent turn persists task/checkpoint across replay and keeps current', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r0', { id: 'c1', workspace_id: 'w1', title: 'main', kind: 'main' })
    store.setCurrent('r0', 'c1')
    const opened = await store.openTurn({
      type: 'turn.open',
      turn_id: 't-sub',
      conv: 'c-sub',
      user_message: { content: '审查 a.ts' },
      slot_ref: 'run-sub',
      at: AT,
      thread_kind: 'subagent',
      task_prompt: '审查 a.ts',
      parent_checkpoint: { goal: '父目标' },
      new_conversation: {
        id: 'c-sub',
        workspace_id: 'w1',
        title: '审查 a.ts',
        kind: 'subagent',
        parent: { def: 'c1' },
        agent: null,
        participants: [],
        inbox: { tail: null, count: 0, last_seen: 0 },
        status: 'waiting',
        last_activity: null,
        pending: { approval: 0, question: 0 },
        created: AT,
        deleted_at: null,
      },
    })
    assert.equal(opened.status, 'created')
    // 子代理会话不抢占 current。
    assert.equal(store.currentId(), 'c1')
    assert.equal(store.conversation('c-sub').kind, 'subagent')

    const reopened = SessionStore.open(env)
    assert.equal(reopened.currentId(), 'c1')
    const turn = reopened.turn('t-sub')
    assert.equal(turn.conv, 'c-sub')
    assert.equal(turn.thread_kind, 'subagent')
    assert.equal(turn.task_prompt, '审查 a.ts')
    assert.deepEqual(turn.parent_checkpoint, { goal: '父目标' })
    assert.equal(reopened.conversation('c-sub').kind, 'subagent')
    // 按子代理会话取切片可还原该回合（续跑据此定位）。
    assert.ok(reopened.slice('c-sub').turns.some((item) => item.turn_id === 't-sub'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// -- flat event stream (single source) ---------------------------------------

test('扁平事件流：eventsFor 按追加序；turns[].steps 为其按 turn_id 的派生视图', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.upsertConversation(null, { id: 'c1' })
    await store.openTurn(turnOpenRecord('t1', 'run-1'))
    await store.appendStep({ type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step', tool_calls: [] })
    await store.appendStep({ type: 'step.result', turn_id: 't1', seq: 0, assistant: { content: 'ok' } })
    await store.appendStep({ type: 'step.user', turn_id: 't1', seq: 1, insert_id: 'i1', user_message: { content: 'more' } })
    await store.settle('t1', COMMITTED)

    // 单一扁平事件流：回合头 / 步 / 收口同级，按 append 序；跨重放稳定。
    const events = store.eventsFor('c1')
    assert.deepEqual(events.map((record) => record.type), ['turn.open', 'step.intent', 'step.result', 'step.user', 'turn.settle'])
    // turns[].steps 是派生视图：只取非终态步记录，保持 append 序。
    assert.deepEqual(store.turn('t1').steps.map((record) => record.type), ['step.intent', 'step.result', 'step.user'])

    const reopened = SessionStore.open(envFor(root))
    assert.deepEqual(reopened.eventsFor('c1').map((record) => record.type), ['turn.open', 'step.intent', 'step.result', 'step.user', 'turn.settle'])
    assert.deepEqual(reopened.turn('t1').steps.map((record) => record.type), ['step.intent', 'step.result', 'step.user'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('插入：insertUserMessage 只按真发送落盘，追加在本段输出之后且按 insert_id 幂等', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    store.upsertConversation(null, { id: 'c1' })
    await store.openTurn(turnOpenRecord('t1', 'run-1'))
    await store.appendStep({ type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: '本段输出' } })

    const inserted = await store.insertUserMessage('t1', 'i1', { content: '插一句' })
    assert.equal(inserted.status, 'inserted')
    const users = store.turn('t1').steps.filter((step) => step.type === 'step.user')
    assert.equal(users.length, 1)
    assert.equal(users[0].insert_id, 'i1')
    assert.ok(users[0].seq > 1)
    // 幂等：同 insert_id 再插不重复。
    assert.equal((await store.insertUserMessage('t1', 'i1', { content: '插一句' })).status, 'exists')

    // 重放后仍在（append-only 单一真源）。
    const reopened = SessionStore.open(envFor(root))
    assert.equal(reopened.turn('t1').steps.filter((step) => step.type === 'step.user').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// -- partition: small index + per-conversation log ---------------------------

test('partition: startup replays only the index; a conversation log loads on first access', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const env = envFor(root)
    const store = SessionStore.open(env)
    store.upsertConversation('r1', { id: 'c1' })
    store.upsertConversation('r1', { id: 'c2' })
    store.appendMessage('r1', 'c1', { id: 'm1', role: 'user', content: 'a', prev: null, at: 'now' })
    store.appendMessage('r1', 'c2', { id: 'm2', role: 'user', content: 'b', prev: null, at: 'now' })
    assert.ok(existsSync(join(root, 'data', 'index.jsonl')))
    assert.ok(existsSync(join(root, 'data', 'conversations', 'c1', 'log.jsonl')))
    assert.ok(existsSync(join(root, 'data', 'conversations', 'c2', 'log.jsonl')))

    const reopened = SessionStore.open(env)
    // 启动只重放索引：没有会话日志被读进内存，清单结构（id / title / 最近已知 head / count）已可从索引回答。
    assert.deepEqual(reopened.loadedConversationIds(), [])
    assert.deepEqual(
      reopened.body().conversations.map((item) => item.id).sort(),
      ['c1', 'c2'],
    )
    assert.deepEqual(reopened.loadedConversationIds(), [])
    // 首次访问某会话才读它的日志，且只读它一个；读后才据消息列表现算 head / count。
    assert.equal(reopened.messagesOf('c1').length, 1)
    assert.deepEqual(reopened.loadedConversationIds(), ['c1'])
    assert.deepEqual(reopened.messagesOf('c1'), [{ id: 'm1', role: 'user', content: 'a', prev: null, at: 'now' }])
    const loaded = reopened.body().conversations.find((item) => item.id === 'c1')
    assert.equal(loaded.count, 1)
    assert.equal(loaded.head.def, 'm1')
    assert.equal(reopened.loadedConversationIds().includes('c2'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// -- per-conversation compaction: snapshot + tail ≡ full replay --------------

async function exerciseConversation(store) {
  store.upsertConversation('r0', {
    id: 'c1',
    workspace_id: 'w1',
    title: 't',
    kind: 'main',
    inbox: { tail: null, count: 0, last_seen: 0 },
  })
  store.setCurrent('r0', 'c1')
  store.appendMessage('r0', 'c1', { id: 'm1', role: 'user', content: 'a', prev: null, at: AT })
  store.turnOpen('r0', 'c1')
  store.appendMessage('r0', 'c1', { id: 'm2', role: 'assistant', content: 'b', prev: { def: 'm1' }, at: AT })
  store.turnClose('r0')
  await store.openTurn(turnOpenRecord('t1', 'run-1'))
  await store.appendStep({ type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step', tool_calls: [] })
  await store.appendStep({
    type: 'step.result',
    turn_id: 't1',
    seq: 0,
    assistant: { content: 'yo', parts: [{ type: 'tool', call_id: 'x' }] },
  })
  await store.appendStep({ type: 'step.user', turn_id: 't1', seq: 1, insert_id: 'i1', user_message: { content: 'more' } })
  await store.appendStep({ type: 'checkpoint', turn_id: 't1', seq: 2, summary: { goal: 'g' }, covered_upto: 0 })
  await store.settle('t1', COMMITTED)
  await store.openTurn(turnOpenRecord('t2', 'run-2'))
  await store.cancelTurn('t2')
  await store.settle('t2', CANCELLED)
  await store.settle('t2', COMMITTED)
  store.appendMessage('r0', 'c1#inbox', { id: 'inbox-c1-1', from: 'u', kind: 'k', body: 'x', seq: 1, at: AT, prev: null })
  await store.ackInbox('r0', 'c1', 1)
  // 尾段继续追加，压实后形成「快照 + 尾段」。
  for (let i = 0; i < 8; i += 1) {
    store.appendMessage('r0', 'c1', { id: `extra-${i}`, role: 'user', content: `e${i}`, prev: null, at: AT })
  }
}

function dumpConversationState(store) {
  return {
    current: store.currentId(),
    body: store.body(),
    pending: store.pendingTurns(),
    open: store.openTurnSummaries(),
    messages: store.messagesOf('c1'),
    inbox: store.unreadInbox('c1'),
    slice: store.slice('c1'),
    history: store.history('c1', null, null),
    historyFull: store.history('c1', null, null, true),
    turnsFor: store.turnsFor('c1'),
    t1: store.turn('t1'),
    t2: store.turn('t2'),
  }
}

test('compaction: "snapshot + tail" replays deep-equal to a full replay', async () => {
  const rootSlow = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  const rootFast = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const slow = SessionStore.open(envFor(rootSlow))
    await exerciseConversation(slow)
    const fast = SessionStore.open(envFor(rootFast), { compactRecords: 4 })
    await exerciseConversation(fast)

    // 快压实目录确实落了快照（否则等价性无意义）。
    const fastLines = readFileSync(join(rootFast, 'data', 'conversations', 'c1', 'log.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
    assert.ok(fastLines.some((record) => record.t === 'snapshot'), 'compaction wrote a snapshot record')
    assert.ok(fastLines.length < 20, 'compaction bounded the conversation log')

    const slowReplay = SessionStore.open(envFor(rootSlow))
    const fastReplay = SessionStore.open(envFor(rootFast))
    assert.deepEqual(dumpConversationState(fastReplay), dumpConversationState(slowReplay))
  } finally {
    rmSync(rootSlow, { recursive: true, force: true })
    rmSync(rootFast, { recursive: true, force: true })
  }
})

// -- idempotent, non-destructive migration -----------------------------------

test('migration: legacy session.jsonl → index + per-conversation logs, kept and idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const dataDir = join(root, 'data')
    const env = envFor(root)
    mkdirSync(dataDir, { recursive: true })
    const legacy = [
      { t: 'conv', run: 'r0', entry: { id: 'c1', workspace_id: 'w1', title: 't' } },
      { t: 'current', run: 'r0', id: 'c1' },
      { t: 'msg', run: 'r0', conv: 'c1', msg: { id: 'm1', role: 'user', content: 'a', prev: null, at: AT } },
      { t: 'msg', run: 'r0', conv: 'c1', msg: { id: 'm2', role: 'assistant', content: 'b', prev: { def: 'm1' }, at: AT } },
      // 旧文件里仍开着的回合：迁移即启动收口为 interrupted。
      { type: 'turn.open', turn_id: 't1', conv: 'c1', user_message: { content: 'hi' }, slot_ref: 'run-1', at: AT },
      { type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step', tool_calls: [] },
    ]
    const legacyPath = join(dataDir, 'session.jsonl')
    const legacyBytes = `${legacy.map((record) => JSON.stringify(record)).join('\n')}\n`
    writeFileSync(legacyPath, legacyBytes, 'utf8')

    const first = SessionStore.open(env)
    assert.equal(first.currentId(), 'c1')
    assert.equal(first.messagesOf('c1').length, 3)
    assert.equal(first.turn('t1').state, 'settled')
    assert.equal(first.turn('t1').outcome.kind, 'interrupted')
    assert.ok(existsSync(join(dataDir, 'index.jsonl')))
    assert.ok(existsSync(join(dataDir, 'conversations', 'c1', 'log.jsonl')))
    assert.ok(existsSync(join(dataDir, 'migrated')))
    // 旧文件保留不删、字节不变。
    assert.equal(readFileSync(legacyPath, 'utf8'), legacyBytes)

    const indexBytes = readFileSync(join(dataDir, 'index.jsonl'), 'utf8')
    const logBytes = readFileSync(join(dataDir, 'conversations', 'c1', 'log.jsonl'), 'utf8')
    // 二次启动：迁移完成标记在，重做是 no-op（新布局字节不变）。
    const second = SessionStore.open(env)
    assert.equal(second.messagesOf('c1').length, 3)
    assert.equal(second.turn('t1').outcome.kind, 'interrupted')
    assert.equal(readFileSync(join(dataDir, 'index.jsonl'), 'utf8'), indexBytes)
    assert.equal(readFileSync(join(dataDir, 'conversations', 'c1', 'log.jsonl'), 'utf8'), logBytes)
    assert.equal(readFileSync(legacyPath, 'utf8'), legacyBytes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// -- conversation id safety --------------------------------------------------

test('safe conversation ids: reject traversal / illegal / reserved / prototype keys', () => {
  const bad = [
    '.', '..', '', 'a/b', 'a\\b', 'C:', 'c:x', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b',
    'con', 'CON', 'nul', 'com1', 'lpt9', 'a.', 'a ', '__proto__', 'constructor', 'prototype',
    'a\u0000b', '\u0001', 'a\u007fb',
  ]
  for (const id of bad) assert.equal(isSafeConversationId(id), false, `expected unsafe: ${JSON.stringify(id)}`)
  for (const id of ['c1', 'c-1700000000000-0', 'sub1', 'c1#inbox', 'a.b', '中文', '_x']) {
    assert.equal(isSafeConversationId(id), true, `expected safe: ${id}`)
  }
  // 写路径 fail-closed：不安全 id 直接抛，绝不路径穿越。
  const root = mkdtempSync(join(tmpdir(), 'chrono-store-'))
  try {
    const store = SessionStore.open(envFor(root))
    assert.throws(
      () => store.appendMessage('r1', '../evil', { id: 'm', role: 'user', content: 'x', prev: null, at: 'now' }),
      /unsafe_conversation_id/,
    )
    assert.equal(existsSync(join(root, 'evil')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

