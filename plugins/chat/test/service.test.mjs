// chat service protocol-level tests: spawn `node execute/main.ts`, bridge loop-policy.interpret,
// session-title.generate and the runtime-record owners (session.read / input.read / session.history).
// Covers handshake/control/EOF, send bag assembly from owner services, empty-slot no-op, title segment,
// resume, history via owner service, structured failures, and readonly concurrency.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_INPUT_BODY,
  INTERPRET_PLAN,
  TITLE_VALUE,
  callArgs,
  defaultBridge,
  directivesOf,
  externOf,
  historyFixture,
  idsFixture,
  sessionSliceFixture,
  startService,
} from './driver.mjs'
import { CONTRACT_VERSION } from '../execute/contract/index.ts'

const BAG_KEYS = [
  'contract_version',
  'input',
  'config',
  'tier',
  'memories',
  'session',
  'graph',
  'persona',
  'skills',
  'workspace_root',
  'evidence',
  'todo',
  'guard_rules',
  'sandbox_tiers',
  'tools_bindings',
  'mcp_tools',
]

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('hello manifest; reload/probe/drain; EOF exits', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'chat')
    assert.deepEqual(manifest.implements, ['chat'])
    assert.deepEqual(manifest.methods.chat, ['send', 'history', 'resume', 'cancel', 'insert'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: reads owners, then title, then interpret; bag carries owner session/input', async () => {
  const drv = startService({
    bridge: defaultBridge({}, {
      session: sessionSliceFixture({
        conversations: [{ id: 'c-1', title: '新对话', count: 0, kind: 'main', workspace_id: 'w-1', agent: 'agent-a', head: { def: 'h3' } }],
      }),
    }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture({ agent: 'agent-a' }))
    assert.equal(result.kind, 'result')
    assert.deepEqual(
      drv.portCalls.map((frame) => `${frame.port}.${frame.method}`),
      [
        'session.read',
        'input.read',
        'short-memory.read',
        'todo.invoke',
        'config.read',
        'mcp.read',
        'workspace.read',
        'skill.read',
        'session-title.generate',
        'session.set_title',
        'session.turn_open',
        'loop-policy.interpret',
      ],
    )

    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    for (const key of BAG_KEYS) assert.ok(Object.hasOwn(bag, key), `interpret bag missing ${key}`)
    // input / session come from owner services (runtime records), not the projection.
    assert.equal(bag.input.content, '帮我写一个快速排序')
    assert.equal(bag.input_body.slots.t1.kind, 'chat.message')
    assert.equal(bag.session.head, 'h3')
    assert.equal(bag.session.refs.h3.id, 'm3')
    // generated title merged into the session body handed to interpret
    assert.equal(bag.session.conversations[0].title, TITLE_VALUE.title)
    // definition slices still come from the projection unchanged
    assert.equal(bag.config.model, 'deepseek-chat')
    assert.equal(bag.tier, 'review')
    assert.equal(bag.graph.contracts.tail.def.length, 64)
    assert.equal(bag.persona, '你是代码评审员。')
    assert.equal(bag.workspace_root, 'C:/ws/w-1')
    assert.equal(bag.todo.items[0].id, 't1')
    assert.equal(bag.thread, 't1')
    assert.equal(bag.contract_version, CONTRACT_VERSION)

    const titleArgs = callArgs(drv.portCalls, 'session-title', 'generate')
    assert.equal(titleArgs.conversation, 'c-1')
    assert.equal(titleArgs.first_message, '帮我写一个快速排序')
    assert.equal(titleArgs.title_default, '新对话')

    assert.deepEqual(directivesOf(result.value), INTERPRET_PLAN.$directives)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: forwards unread inbox into the interpret bag and acks the delivered seqs after interpret', async () => {
  const session = sessionSliceFixture({
    inbox_unread: [
      { seq: 1, kind: 'instruction', body: 'a', from: 'sub-1' },
      { seq: 2, kind: 'report', body: 'b', from: 'sub-2' },
    ],
  })
  const drv = startService({ bridge: defaultBridge({}, { session }) })
  try {
    await drv.hello()
    await drv.call('send', idsFixture())
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.deepEqual(bag.inbox_unread.map((item) => item.seq), [1, 2])
    const ack = callArgs(drv.portCalls, 'session', 'ack_inbox')
    assert.deepEqual(ack, { conversation: 'c-1', seq: 2 })
    // ack 在 interpret 之后（模型已消费）。
    const order = drv.portCalls.map((frame) => `${frame.port}.${frame.method}`)
    assert.ok(order.indexOf('loop-policy.interpret') < order.indexOf('session.ack_inbox'))
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: an interpret failure does not ack, so unread is preserved for retry', async () => {
  const session = sessionSliceFixture({
    inbox_unread: [{ seq: 1, kind: 'instruction', body: 'a', from: 'sub-1' }],
  })
  const drv = startService({
    bridge: defaultBridge(
      { 'loop-policy.interpret': () => ({ ok: false, error: { code: 'budget', message: 'gas' } }) },
      { session },
    ),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.equal(externOf(result.value).outcome.kind, 'refused')
    assert.equal(
      drv.portCalls.some((frame) => frame.port === 'session' && frame.method === 'ack_inbox'),
      false,
      'interpret 失败不得 ack（未读保留供重投）',
    )
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: a refused graph outcome does not ack (unread preserved), a committed one does', async () => {
  const session = sessionSliceFixture({
    inbox_unread: [{ seq: 1, kind: 'instruction', body: 'a', from: 'sub-1' }],
  })
  const refusedPlan = {
    $directives: [
      {
        kind: 'extern',
        payload: {
          ok: true,
          kind: 'interpret',
          ended: 'refused',
          turn_id: 't-run-slot-1',
          outcome: { kind: 'refused', code: 'downstream_refusal', attributableTo: 'graph', retryable: false, cause: null },
          settled: true,
        },
      },
    ],
  }
  const refused = startService({ bridge: defaultBridge({ 'loop-policy.interpret': () => refusedPlan }, { session }) })
  try {
    await refused.hello()
    const result = await refused.call('send', idsFixture())
    assert.equal(externOf(result.value).outcome.kind, 'refused')
    assert.equal(
      refused.portCalls.some((frame) => frame.port === 'session' && frame.method === 'ack_inbox'),
      false,
      '拒收口的回合不得 ack（未读保留供重投）',
    )
  } finally {
    refused.close()
  }
  assert.equal(await refused.exit, 0)

  const committed = startService({ bridge: defaultBridge({}, { session }) })
  try {
    await committed.hello()
    await committed.call('send', idsFixture())
    assert.deepEqual(callArgs(committed.portCalls, 'session', 'ack_inbox'), { conversation: 'c-1', seq: 1 })
  } finally {
    committed.close()
  }
  assert.equal(await committed.exit, 0)
})

test('send: an existing subagent thread reads its own slice for unread inbox', async () => {
  const mainConv = { id: 'c-1', title: '主', count: 0, kind: 'main', workspace_id: 'w-1', agent: null, head: null }
  const subConv = {
    id: 'c-sub',
    kind: 'subagent',
    workspace_id: 'w-1',
    parent: { def: 'c-1' },
    agent: null,
    title: '审查',
    count: 0,
    head: null,
    inbox: { tail: null, count: 1, last_seen: 0 },
  }
  const session = sessionSliceFixture({ current: 'c-1', conversations: [mainConv, subConv] })
  const submit = {
    kind: 'chat.message',
    text: '审查 a.ts',
    workspace_id: 'w-1',
    thread_kind: 'subagent',
    task_prompt: '审查 a.ts',
    conversation_id: 'c-sub',
  }
  const base = defaultBridge(
    {},
    {
      session,
      input: { slots: { t1: submit }, slot_ref: 'run-sub-1' },
      turnOpen: { ok: true, status: 'created', created: true, turn_id: 't-run-slot-1', conversation: 'c-sub' },
    },
  )
  const drv = startService({
    bridge: (port, method, args) => {
      if (port === 'session' && method === 'read' && args?.conversation === 'c-sub') {
        return Promise.resolve({
          value: {
            ...session,
            current: 'c-1',
            inbox_unread: [{ seq: 1, kind: 'instruction', body: 'go', from: 'parent' }],
          },
        })
      }
      return base(port, method, args)
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture({ slot: submit }), { run: 'run-sub-1', thread: 't1', now: 1_700_000_000_000 })
    assert.equal(result.kind, 'result')
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.equal(bag.thread_kind, 'subagent')
    assert.equal(bag.session_id, 'c-sub')
    assert.deepEqual(bag.inbox_unread.map((item) => item.seq), [1])
    assert.deepEqual(callArgs(drv.portCalls, 'session', 'ack_inbox'), { conversation: 'c-sub', seq: 1 })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: definition slices omitted when identity absent from projection', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const ids = idsFixture({ omit: ['guard', 'sandbox', 'tools', 'mcp', 'evolution', 'workspace', 'agents', 'skill'] })
    await drv.call('send', ids)
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    // 投影缺席且无 owner 供给的切片不落键；owner 供给的切片（mcp / workspace / skill）照常覆盖投影。
    for (const key of ['guard_rules', 'sandbox_tiers', 'tools_bindings', 'evidence', 'persona']) {
      assert.equal(Object.hasOwn(bag, key), false, `absent identity should not add ${key}`)
    }
    assert.ok(Object.hasOwn(bag, 'graph'), 'graph still present')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: non-first message skips the title segment', async () => {
  const drv = startService({ bridge: defaultBridge({}, { session: sessionSliceFixture({ conversations: [{ id: 'c-1', title: '新对话', count: 4, kind: 'main', workspace_id: 'w-1', agent: null, head: { def: 'h3' } }] }) }) })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.equal(drv.portCalls.some((frame) => frame.port === 'session-title'), false)
    assert.deepEqual(directivesOf(result.value), INTERPRET_PLAN.$directives)
    // 回合开始自报：客户端据此在首个 delta 前建在途回合（续跑嵌套 eval 无宿主 run 生命周期）。
    const turn = drv.events.find((frame) => frame.topic === 'chat.turn.started')
    assert.deepEqual(turn?.payload, { turn_id: 't-run-slot-1', run: 'run-1', thread: 't1', conversation: 'c-1', source: 'send' })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: chat.turn.settled carries graph progress / lifecycle / stop_reason from the interpret summary', async () => {
  const plan = {
    $directives: [
      {
        kind: 'extern',
        payload: {
          ok: true,
          kind: 'interpret',
          ended: 'done',
          turn_id: 't-run-slot-1',
          outcome: { kind: 'committed', code: null, attributableTo: null, retryable: false, cause: null, stop_reason: 'turn_iter' },
          lifecycle: 'settled',
          progress: { iter: 2, node_index: 1, contract_id: 'tool.dispatch' },
          settled: true,
        },
      },
    ],
  }
  const drv = startService({ bridge: defaultBridge({ 'loop-policy.interpret': () => plan }) })
  try {
    await drv.hello()
    await drv.call('send', idsFixture())
    const settled = drv.events.find((frame) => frame.topic === 'chat.turn.settled')
    assert.equal(settled?.payload.progress.contract_id, 'tool.dispatch')
    assert.equal(settled?.payload.progress.iter, 2)
    assert.equal(settled?.payload.progress.node_index, 1)
    assert.equal(settled?.payload.lifecycle, 'settled')
    assert.equal(settled?.payload.stop_reason, 'turn_iter')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: chat.turn.pending carries graph progress from the interpret summary', async () => {
  const plan = {
    $directives: [
      {
        kind: 'extern',
        payload: {
          ok: true,
          kind: 'interpret',
          ended: 'pending',
          turn_id: 't-run-slot-1',
          pending: 'approval',
          lifecycle: 'suspended',
          progress: { iter: 3, node_index: 2, contract_id: 'approval.wait' },
        },
      },
    ],
  }
  const drv = startService({ bridge: defaultBridge({ 'loop-policy.interpret': () => plan }) })
  try {
    await drv.hello()
    await drv.call('send', idsFixture())
    const pending = drv.events.find((frame) => frame.topic === 'chat.turn.pending')
    assert.equal(pending?.payload.pending, 'approval')
    assert.equal(pending?.payload.progress.contract_id, 'approval.wait')
    assert.equal(pending?.payload.progress.iter, 3)
    // 未收口：不发 settled。
    assert.equal(drv.events.some((frame) => frame.topic === 'chat.turn.settled'), false)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: chat.turn.settled omits progress keys when the summary carries none (no invented values)', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('send', idsFixture())
    const settled = drv.events.find((frame) => frame.topic === 'chat.turn.settled')
    assert.equal(Object.hasOwn(settled?.payload ?? {}, 'progress'), false)
    assert.equal(Object.hasOwn(settled?.payload ?? {}, 'lifecycle'), false)
    assert.equal(Object.hasOwn(settled?.payload ?? {}, 'stop_reason'), false)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: empty / idle / non-chat slot -> idempotent no-op, no downstream eff', async () => {
  for (const input of [{ slots: {} }, { slots: { t1: { kind: 'idle' } } }, { slots: { t1: { kind: 'session.new' } } }]) {
    const drv = startService({ bridge: defaultBridge({}, { input }) })
    try {
      await drv.hello()
      const result = await drv.call('send', idsFixture())
      assert.equal(result.kind, 'result')
      assert.deepEqual(externOf(result.value), { ok: true, noop: true })
      assert.equal(drv.portCalls.some((frame) => frame.port === 'loop-policy'), false)
    } finally {
      drv.close()
    }
    assert.equal(await drv.exit, 0)
  }
})

test('send: model_not_configured stops before interpret (no turn persisted)', async () => {
  const drv = startService({ bridge: defaultBridge({}, { configValue: { model: 'm', permission: 'review' } }) })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.deepEqual(externOf(result.value), {
      ok: false,
      error: { code: 'model_not_configured', message: 'config vendor/model/base_url missing' },
    })
    assert.equal(drv.portCalls.some((frame) => frame.port === 'loop-policy'), false)
    assert.equal(drv.portCalls.some((frame) => frame.method === 'turn_open'), false, '回合开始前拒绝不写回合头')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: config owner read failure -> owner_unavailable (not model_not_configured)', async () => {
  // config 读失败与「读到但未配模型」必须分码：否则把「config 服务挂了」误报成「你没配模型」。
  const drv = startService({
    bridge: (port, method, args) =>
      port === 'config' ? Promise.resolve({ error: 'not_loaded', message: 'no config' }) : defaultBridge()(port, method, args),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.deepEqual(externOf(result.value), {
      ok: false,
      error: { code: 'owner_unavailable', message: 'config owner read failed' },
    })
    assert.equal(drv.portCalls.some((frame) => frame.port === 'loop-policy'), false)
    assert.equal(drv.portCalls.some((frame) => frame.method === 'turn_open'), false)
    assert.equal(drv.portCalls.some((frame) => frame.port === 'model'), false, '不得调模型')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: session owner read failure -> owner_unavailable, no model call', async () => {
  const drv = startService({
    bridge: (port, method, args) =>
      port === 'session' ? Promise.resolve({ error: 'not_loaded', message: 'no session' }) : defaultBridge()(port, method, args),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.deepEqual(externOf(result.value), {
      ok: false,
      error: { code: 'owner_unavailable', message: 'session owner read failed' },
    })
    assert.equal(drv.portCalls.some((frame) => frame.method === 'turn_open'), false)
    assert.equal(drv.portCalls.some((frame) => frame.port === 'loop-policy'), false)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: no current conversation + workspace_id -> new_conversation passthrough', async () => {
  const drv = startService({
    bridge: defaultBridge({}, {
      session: sessionSliceFixture({ current: null, conversations: [], refs: {}, head: null }),
      input: { slots: { t1: { kind: 'chat.message', text: '第一条', workspace_id: 'w-1', conversation_id: 'c-9' } }, slot_ref: 'run-slot-1' },
    }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.equal(result.kind, 'result')
    // 建会话随回合头前移：new_conversation 随 session.turn_open 落盘，不再是 bag / 回合尾提交的副产品。
    const openArgs = callArgs(drv.portCalls, 'session', 'turn_open')
    assert.deepEqual(openArgs.new_conversation, { id: 'c-9', workspace_id: 'w-1', title: TITLE_VALUE.title })
    assert.equal(openArgs.slot_ref, 'run-slot-1')
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.equal(bag.session_id, 'c-9')
    assert.equal(bag.workspace_id, 'w-1')
    assert.equal(bag.turn_id, 't-run-slot-1')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: no current conversation and no workspace_id -> workspace_missing', async () => {
  const drv = startService({
    bridge: defaultBridge({}, {
      session: sessionSliceFixture({ current: null, conversations: [], refs: {}, head: null }),
      input: { slots: { t1: { kind: 'chat.message', text: '第一条' } } },
    }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.deepEqual(externOf(result.value), {
      ok: false,
      error: { code: 'workspace_missing', message: 'workspace_id required to start a conversation' },
    })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: duplicate slot (already_open, in flight) returns a duplicate receipt and never re-runs interpret', async () => {
  const drv = startService({
    bridge: defaultBridge({}, {
      turnOpen: { ok: true, status: 'already_open', created: false, state: 'open', turn_id: 't-run-slot-1', conversation: 'c-1' },
    }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    const receipt = externOf(result.value)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.duplicate, true)
    assert.equal(receipt.status, 'in_flight')
    assert.equal(receipt.turn_id, 't-run-slot-1')
    assert.equal(drv.portCalls.some((frame) => frame.port === 'loop-policy'), false, '重复回合不得再派发解释器')
    assert.equal(drv.portCalls.some((frame) => frame.method === 'turn_settle'), false, '在途回合不重复收口')
    assert.equal(drv.portCalls.some((frame) => frame.port === 'input' && frame.method === 'clear'), false, '槽保留')
    assert.equal(drv.events.some((frame) => frame.topic === 'chat.turn.started'), false)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: already_open for a settled turn returns its outcome without re-running interpret', async () => {
  const drv = startService({
    bridge: defaultBridge({}, {
      turnOpen: {
        ok: true, status: 'already_open', created: false, state: 'settled', turn_id: 't-run-slot-1', conversation: 'c-1',
        outcome: { kind: 'committed', code: null, attributableTo: null, retryable: false, cause: null },
      },
    }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    const receipt = externOf(result.value)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.duplicate, true)
    assert.equal(receipt.status, 'settled')
    assert.equal(receipt.outcome.kind, 'committed')
    assert.equal(drv.portCalls.some((frame) => frame.port === 'loop-policy'), false)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: turn_busy returns a retryable refused outcome, preserves the slot, and persists no turn', async () => {
  const drv = startService({
    bridge: defaultBridge({}, {
      turnOpen: {
        ok: false, status: 'turn_busy', reason: 'turn_busy', turn_id: 't-run-slot-1', conversation: 'c-1', busy_turn_id: 't-other',
      },
    }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    const receipt = externOf(result.value)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.outcome.kind, 'refused')
    assert.equal(receipt.outcome.code, 'turn_busy')
    assert.equal(receipt.outcome.attributableTo, 'owner')
    assert.equal(receipt.outcome.retryable, true)
    assert.equal(drv.portCalls.some((frame) => frame.port === 'loop-policy'), false)
    assert.equal(drv.portCalls.some((frame) => frame.method === 'turn_settle'), false, 'turn_busy 不是回合，不得落收口')
    assert.equal(drv.portCalls.some((frame) => frame.port === 'input' && frame.method === 'clear'), false, '槽保留')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('I3: each injected failure class yields a distinct, recorded outcome', async () => {
  // 每类失败各注入一次：结局（含 cause 的下游码）互不相同，且经 turn_settle 记入回合记录。
  const cases = [
    {
      name: 'transport',
      bridge: (port, method, args) =>
        port === 'loop-policy' ? Promise.resolve({ error: 'unresolved_cap', message: 'no loop' }) : defaultBridge()(port, method, args),
      expected: { code: 'loop_unavailable', attributableTo: 'transport', cause: 'unresolved_cap' },
    },
    {
      name: 'budget',
      bridge: defaultBridge({ 'loop-policy.interpret': () => ({ ok: false, error: { code: 'budget', message: 'gas' } }) }),
      expected: { code: 'downstream_refusal', attributableTo: 'graph', cause: 'budget' },
    },
    {
      name: 'graph',
      bridge: defaultBridge({ 'loop-policy.interpret': () => ({ ok: false, error: { code: 'capability_mismatch', message: 'bad tool' } }) }),
      expected: { code: 'downstream_refusal', attributableTo: 'graph', cause: 'capability_mismatch' },
    },
  ]
  const seen = new Set()
  for (const item of cases) {
    const drv = startService({ bridge: item.bridge })
    try {
      await drv.hello()
      const result = await drv.call('send', idsFixture())
      const receipt = externOf(result.value)
      assert.equal(receipt.outcome.kind, 'refused', item.name)
      assert.equal(receipt.outcome.code, item.expected.code, item.name)
      assert.equal(receipt.outcome.attributableTo, item.expected.attributableTo, item.name)
      assert.equal(receipt.outcome.cause.code, item.expected.cause, item.name)
      const settle = callArgs(drv.portCalls, 'session', 'turn_settle')
      assert.deepEqual(settle.outcome, receipt.outcome, `${item.name}: 记录与回执同值`)
      seen.add(`${receipt.outcome.code}:${receipt.outcome.cause.code}`)
    } finally {
      drv.close()
    }
    assert.equal(await drv.exit, 0)
  }
  assert.equal(seen.size, cases.length, '结局（含 cause）逐类唯一')
})

test('send: interpret transport failure -> refused{loop_unavailable} settled + receipt + event', async () => {
  const drv = startService({
    bridge: (port, method, args) =>
      port === 'loop-policy'
        ? Promise.resolve({ error: 'unresolved_cap', message: 'no loop-policy' })
        : defaultBridge()(port, method, args),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    const receipt = externOf(result.value)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.outcome.kind, 'refused')
    assert.equal(receipt.outcome.code, 'loop_unavailable')
    assert.equal(receipt.outcome.attributableTo, 'transport')
    assert.equal(receipt.outcome.cause.code, 'unresolved_cap', '下游码原样进 cause')
    // 命令回执之外还有服务端收口与全客户端事件。
    const settle = callArgs(drv.portCalls, 'session', 'turn_settle')
    assert.equal(settle.outcome.kind, 'refused')
    const settledEvent = drv.events.find((frame) => frame.topic === 'chat.turn.settled')
    assert.deepEqual(settledEvent?.payload.turn_id, 't-run-slot-1')
    assert.equal(settledEvent?.payload.outcome.code, 'loop_unavailable')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: interpret structured failure -> refused{downstream_refusal} wraps cause code', async () => {
  const drv = startService({
    bridge: defaultBridge({ 'loop-policy.interpret': () => ({ ok: false, error: { code: 'budget', message: 'gas' } }) }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    const receipt = externOf(result.value)
    assert.equal(receipt.outcome.kind, 'refused')
    assert.equal(receipt.outcome.code, 'downstream_refusal')
    assert.equal(receipt.outcome.attributableTo, 'graph')
    assert.deepEqual(receipt.outcome.cause, { from: 'loop-policy.interpret', code: 'budget', message: 'gas' })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('resume: assembles bag from owner services + passes bag.resume', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const cursor = { kind: 'approval', turn_id: 't-run-slot-1', iter: 1, node_index: 3, executed: [0, 1, 2] }
    const result = await drv.call('resume', {
      cursor,
      thread: 't1',
      payload: { verdict: 'approved' },
      ids: idsFixture(),
    })
    assert.equal(result.kind, 'result')
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.deepEqual(bag.resume, { cursor, thread: 't1', payload: { verdict: 'approved' } })
    assert.equal(bag.turn_id, 't-run-slot-1', '续跑继续同一回合，不重铸')
    assert.equal(bag.input.content, '帮我写一个快速排序')
    assert.equal(bag.session.head, 'h3')
    assert.deepEqual(directivesOf(result.value), INTERPRET_PLAN.$directives)
    assert.equal(drv.portCalls.some((frame) => frame.method === 'turn_open'), false, '续跑不重开回合头')
    const turn = drv.events.find((frame) => frame.topic === 'chat.turn.started')
    assert.deepEqual(turn?.payload, { turn_id: 't-run-slot-1', run: 'run-1', thread: 't1', conversation: 'c-1', source: 'resume' })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('resume: missing cursor -> bad_args', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('resume', { thread: 't1' })
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'bad_args')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: a subagent slot opens an isolated thread carrying task + parent checkpoint', async () => {
  const submit = {
    kind: 'chat.message',
    text: '审查 a.ts',
    workspace_id: 'w-1',
    thread_kind: 'subagent',
    task_prompt: '审查 a.ts',
    parent_checkpoint: { goal: '父目标', open_questions: ['q'] },
    conversation_id: 'c-sub',
  }
  const drv = startService({
    bridge: defaultBridge({}, { input: { slots: { t1: submit }, slot_ref: 'run-sub-1' } }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture({ slot: submit }))
    assert.equal(result.kind, 'result')

    const openArgs = callArgs(drv.portCalls, 'session', 'turn_open')
    assert.equal(openArgs.thread_kind, 'subagent')
    assert.equal(openArgs.task_prompt, '审查 a.ts')
    assert.deepEqual(openArgs.parent_checkpoint, { goal: '父目标', open_questions: ['q'] })
    assert.equal(openArgs.new_conversation.kind, 'subagent')
    assert.equal(openArgs.new_conversation.id, 'c-sub')
    assert.equal(openArgs.new_conversation.workspace_id, 'w-1')

    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.equal(bag.thread_kind, 'subagent')
    assert.equal(bag.task_prompt, '审查 a.ts')
    assert.deepEqual(bag.parent_checkpoint, { goal: '父目标', open_questions: ['q'] })
    assert.equal(bag.session_id, 'c-sub')
    assert.equal(bag.contract_version, CONTRACT_VERSION)
    // 子代理线程不跑标题段（标题取任务提示词）。
    assert.equal(drv.portCalls.some((frame) => frame.port === 'session-title'), false)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('resume: a subagent continuation restores task + parent checkpoint from the turn record', async () => {
  const mainConv = { id: 'c-1', title: '主', count: 0, kind: 'main', workspace_id: 'w-1', agent: null, head: null }
  const subConv = {
    id: 'c-sub',
    kind: 'subagent',
    workspace_id: 'w-1',
    parent: { def: 'c-1' },
    agent: null,
    title: '审查 a.ts',
    count: 1,
    head: { def: 'msg-c-sub-t-sub-user' },
  }
  const session = sessionSliceFixture({
    current: 'c-1',
    conversations: [mainConv, subConv],
    turns: [
      {
        turn_id: 't-sub',
        conv: 'c-sub',
        slot_ref: 'run-sub-1',
        at: '2023-11-14T22:13:20.000Z',
        state: 'open',
        thread_kind: 'subagent',
        task_prompt: '审查 a.ts',
        parent_checkpoint: { goal: '父目标' },
        steps: [],
      },
    ],
  })
  const drv = startService({ bridge: defaultBridge({}, { session }) })
  try {
    await drv.hello()
    const progress = { iter: 2, node_index: 1, contract_id: 'tool.dispatch' }
    const result = await drv.call('resume', { turn_id: 't-sub', thread: 't1', progress })
    assert.equal(result.kind, 'result')
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.equal(bag.thread_kind, 'subagent')
    assert.equal(bag.task_prompt, '审查 a.ts')
    assert.deepEqual(bag.parent_checkpoint, { goal: '父目标' })
    assert.equal(bag.session_id, 'c-sub')
    assert.equal(bag.resume.continuation, true)
    assert.equal(drv.portCalls.some((frame) => frame.method === 'turn_open'), false, '段续跑不重开回合头')
    // 段续跑随 args 带来的图内进度随 chat.turn.started 广播：UI 轮次实时前进（不臆造、不回落到 send）。
    const started = drv.events.find((frame) => frame.topic === 'chat.turn.started')
    assert.equal(started?.payload.source, 'resume')
    assert.deepEqual(started?.payload.progress, progress)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('history: delegates to the session owner service (no projection refs)', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('history', { conversation: 'c-1' })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.conversation, 'c-1')
    assert.deepEqual(result.value.messages.map((entry) => entry.def.id), ['m3', 'm2', 'm1'])
    assert.equal(result.value.next_before, null)
    assert.deepEqual(
      drv.portCalls.map((frame) => `${frame.port}.${frame.method}`),
      ['session.history'],
    )
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('history: owner unavailable -> session_unavailable error value', async () => {
  const drv = startService({
    bridge: (port) => (port === 'session' ? Promise.resolve({ error: 'not_loaded', message: 'no session' }) : defaultBridge()(port)),
  })
  try {
    await drv.hello()
    const result = await drv.call('history', { conversation: 'c-1' })
    assert.deepEqual(result.value, { ok: false, error: { code: 'session_unavailable', message: 'no session' } })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: non-object args -> bad_args, process survives', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('send', null)
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'bad_args')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
  } finally {
    drv.close()
  }
})

test('concurrency: readonly history completes while send is suspended on interpret', async () => {
  let releaseInterpret
  const gate = new Promise((resolve) => {
    releaseInterpret = resolve
  })
  const drv = startService({
    bridge: (port, method, args) => {
      if (port === 'loop-policy') return gate.then(() => ({ value: INTERPRET_PLAN }))
      if (port === 'session' && method === 'history') return Promise.resolve({ value: historyFixture() })
      return defaultBridge()(port, method, args)
    },
  })
  try {
    await drv.hello()
    const sendPending = drv.call('send', idsFixture())
    await waitFor(() => drv.portCalls.some((frame) => frame.port === 'loop-policy'))
    const historyResult = await drv.call('history', { conversation: 'c-1' })
    assert.equal(historyResult.kind, 'result')
    assert.equal(historyResult.value.conversation, 'c-1')
    releaseInterpret()
    const sendResult = await sendPending
    assert.equal(sendResult.kind, 'result')
  } finally {
    releaseInterpret()
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('concurrency: declared-concurrent sends run in parallel', async () => {
  // 审计结论：chat.send 无模块级可变状态（hydrator 缓存为每服务实例内的 Map），可跨会话并发。
  const releases = []
  const drv = startService({
    bridge: (port, method, args) => {
      if (port === 'loop-policy') {
        return new Promise((resolve) => {
          releases.push(() => resolve({ value: INTERPRET_PLAN }))
        })
      }
      return defaultBridge()(port, method, args)
    },
  })
  try {
    await drv.hello()
    const first = drv.call('send', idsFixture())
    const second = drv.call('send', idsFixture())
    await waitFor(() => releases.length === 2)
    for (const release of releases) release()
    await first
    await second
  } finally {
    for (const release of releases) release()
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

const COMMITTED = { kind: 'committed', code: null, attributableTo: null, retryable: false, cause: null }

test('cancel: open turn records intent, notifies loop/model, settles cancelled, broadcasts event, keeps slot', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('cancel', { turn_id: 't-run-slot-1', thread: 't1' })
    assert.equal(result.kind, 'result')
    const receipt = externOf(result.value)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.cancelled, true)
    assert.equal(receipt.turn_id, 't-run-slot-1')
    assert.equal(receipt.outcome.kind, 'cancelled')
    assert.deepEqual(
      drv.portCalls.map((frame) => `${frame.port}.${frame.method}`),
      ['session.turn_cancel', 'loop-policy.cancel', 'model.abort', 'session.turn_settle'],
    )
    assert.equal(callArgs(drv.portCalls, 'session', 'turn_settle').outcome.kind, 'cancelled')
    const event = drv.events.find((frame) => frame.topic === 'chat.turn.settled')
    assert.equal(event?.payload.turn_id, 't-run-slot-1')
    assert.equal(event?.payload.outcome.kind, 'cancelled')
    assert.equal(event?.payload.source, 'cancel')
    assert.equal(drv.portCalls.some((frame) => frame.port === 'input' && frame.method === 'clear'), false, '取消不清槽')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('cancel: a settled turn is a no-op that reports the existing outcome (no notify, no rewrite)', async () => {
  const drv = startService({
    bridge: defaultBridge({}, { turnCancel: { ok: true, turn_id: 't-run-slot-1', state: 'settled', conversation: 'c-1', outcome: COMMITTED } }),
  })
  try {
    await drv.hello()
    const receipt = externOf((await drv.call('cancel', { turn_id: 't-run-slot-1' })).value)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.cancelled, false)
    assert.equal(receipt.reason, 'already_settled')
    assert.equal(receipt.outcome.kind, 'committed')
    assert.deepEqual(drv.portCalls.map((frame) => `${frame.port}.${frame.method}`), ['session.turn_cancel'])
    assert.equal(drv.events.some((frame) => frame.topic === 'chat.turn.settled'), false)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('cancel: unknown turn is a no-op, not a protocol error', async () => {
  const drv = startService({ bridge: defaultBridge({}, { turnCancel: { ok: false, reason: 'unknown_turn' } }) })
  try {
    await drv.hello()
    const result = await drv.call('cancel', { turn_id: 'nope' })
    assert.equal(result.kind, 'result')
    const receipt = externOf(result.value)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.cancelled, false)
    assert.equal(receipt.reason, 'unknown_turn')
    assert.deepEqual(drv.portCalls.map((frame) => `${frame.port}.${frame.method}`), ['session.turn_cancel'])
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('cancel: missing turn_id -> bad_args, process survives', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('cancel', {})
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'bad_args')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
  } finally {
    drv.close()
  }
})

test('cancel: concurrent with an in-flight send (the reason for concurrent_methods)', async () => {
  let releaseInterpret
  const gate = new Promise((resolve) => {
    releaseInterpret = resolve
  })
  const drv = startService({
    bridge: (port, method, args) => {
      if (port === 'loop-policy' && method === 'interpret') return gate.then(() => ({ value: INTERPRET_PLAN }))
      return defaultBridge()(port, method, args)
    },
  })
  try {
    await drv.hello()
    const sendPending = drv.call('send', idsFixture())
    await waitFor(() => drv.portCalls.some((frame) => frame.port === 'loop-policy' && frame.method === 'interpret'))
    // 取消必须能在 send 在途时到达并完成：串行声明会让它排在解释器后面永远到不了。
    const cancelResult = await drv.call('cancel', { turn_id: 't-run-slot-1', thread: 't1' })
    assert.equal(cancelResult.kind, 'result')
    assert.equal(externOf(cancelResult.value).cancelled, true)
    releaseInterpret()
    assert.equal((await sendPending).kind, 'result')
  } finally {
    releaseInterpret()
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})
