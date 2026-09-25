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

const BAG_KEYS = [
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
    assert.deepEqual(manifest.methods.chat, ['send', 'history', 'resume'])
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
      ['session.read', 'input.read', 'short-memory.read', 'todo.invoke', 'session-title.generate', 'session.set_title', 'loop-policy.interpret'],
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

test('send: definition slices omitted when identity absent from projection', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const ids = idsFixture({ omit: ['guard', 'sandbox', 'tools', 'mcp', 'evolution', 'workspace', 'agents', 'skill'] })
    await drv.call('send', ids)
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    for (const key of ['guard_rules', 'sandbox_tiers', 'tools_bindings', 'mcp_tools', 'evidence', 'workspace_root', 'persona', 'skills']) {
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

test('send: model_not_configured stops before interpret', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture({ configBody: { model: 'm', permission: 'review' } }))
    assert.deepEqual(externOf(result.value), {
      ok: false,
      error: { code: 'model_not_configured', message: 'config vendor/model/base_url missing' },
    })
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
      input: { slots: { t1: { kind: 'chat.message', text: '第一条', workspace_id: 'w-1', conversation_id: 'c-9' } } },
    }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.equal(result.kind, 'result')
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.equal(bag.session_id, 'c-9')
    assert.equal(bag.workspace_id, 'w-1')
    assert.deepEqual(bag.new_conversation, { id: 'c-9', workspace_id: 'w-1', title: TITLE_VALUE.title })
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

test('send: interpret transport failure -> loop_unavailable extern', async () => {
  const drv = startService({
    bridge: (port, method, args) =>
      port === 'loop-policy'
        ? Promise.resolve({ error: 'unresolved_cap', message: 'no loop-policy' })
        : defaultBridge()(port, method, args),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.deepEqual(externOf(result.value), {
      ok: false,
      error: { code: 'loop_unavailable', message: 'no loop-policy' },
    })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send: interpret structured failure -> extern passthrough', async () => {
  const drv = startService({
    bridge: defaultBridge({ 'loop-policy.interpret': () => ({ ok: false, error: { code: 'budget', message: 'gas' } }) }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.deepEqual(externOf(result.value), { ok: false, error: { code: 'budget', message: 'gas' } })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('resume: assembles bag from owner services + passes bag.resume', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const cursor = { kind: 'approval', iter: 1, node_index: 3, executed: [0, 1, 2] }
    const result = await drv.call('resume', {
      cursor,
      thread: 't1',
      payload: { verdict: 'approved' },
      ids: idsFixture(),
    })
    assert.equal(result.kind, 'result')
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.deepEqual(bag.resume, { cursor, thread: 't1', payload: { verdict: 'approved' } })
    assert.equal(bag.input.content, '帮我写一个快速排序')
    assert.equal(bag.session.head, 'h3')
    assert.deepEqual(directivesOf(result.value), INTERPRET_PLAN.$directives)
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
    bridge: (port, method) => {
      if (port === 'loop-policy') return gate.then(() => ({ value: INTERPRET_PLAN }))
      if (port === 'session-title') return Promise.resolve({ value: TITLE_VALUE })
      if (port === 'session' && method === 'history') return Promise.resolve({ value: historyFixture() })
      if (port === 'session') return Promise.resolve({ value: sessionSliceFixture() })
      if (port === 'input') return Promise.resolve({ value: DEFAULT_INPUT_BODY })
      return Promise.resolve({ value: null })
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

test('concurrency: non-readonly calls are serialized', async () => {
  const releases = []
  const drv = startService({
    bridge: (port) => {
      if (port === 'session') return Promise.resolve({ value: sessionSliceFixture() })
      if (port === 'input') return Promise.resolve({ value: DEFAULT_INPUT_BODY })
      if (port !== 'loop-policy') return Promise.resolve({ value: null })
      return new Promise((resolve) => {
        releases.push(() => resolve({ value: INTERPRET_PLAN }))
      })
    },
  })
  try {
    await drv.hello()
    const first = drv.call('send', idsFixture())
    await waitFor(() => releases.length === 1)
    const second = drv.call('send', idsFixture())
    await delay(120)
    assert.equal(releases.length, 1, 'second non-readonly call must not start before the first finishes')
    releases[0]()
    await first
    await waitFor(() => releases.length === 2)
    releases[1]()
    await second
  } finally {
    for (const release of releases) release()
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})
