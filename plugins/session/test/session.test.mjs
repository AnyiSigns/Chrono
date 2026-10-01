// session service protocol-level tests (node --test): conversation runtime records go to the
// service-owned durable store (CHRONO_PLUGIN_DATA); the service returns plain values, never world
// write plans. The driver spawns `node execute/main.ts` with temp data/state dirs and answers the
// reverse `input.clear` call. Read-back round-trips go through `read`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const AT = '2023-11-14T22:13:20.000Z'
const COMMITTED = { kind: 'committed', code: null, attributableTo: null, retryable: false, cause: null }
const CANCELLED = { kind: 'cancelled', code: 'cancelled', attributableTo: 'owner', retryable: false, cause: null }

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'chrono-session-'))
}

function startService(options = {}) {
  const root = options.root ?? tempRoot()
  const env = {
    ...process.env,
    CHRONO_PLUGIN_DATA: join(root, 'data'),
    CHRONO_PLUGIN_STATE: join(root, 'state'),
  }
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const portCalls = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        portCalls.push(message)
        child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { ok: true } }))
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', () => {})

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, 5000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }

  return {
    child,
    root,
    events,
    portCalls,
    exit,
    request,
    hello: () => request('hello', { impl: 'session', gen: 'gen-1' }, 'manifest'),
    call: async (method, args, env = FIXED_ENV) => {
      const message = await request('call', { port: 'session', method, args, env }, 'result')
      return message.value
    },
    callRaw: (method, args, env = FIXED_ENV) =>
      request('call', { port: 'session', method, args, env }, ['result', 'error']),
    close: () => child.stdin.end(),
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // cleanup failure does not change the verdict
      }
    },
  }
}

function baseSession() {
  return {
    version: 1,
    current: 'c1',
    conversations: [
      { id: 'c1', workspace_id: 'w1', title: 'new chat', kind: 'main', status: 'waiting', inbox: { tail: null, count: 0, last_seen: 0 } },
    ],
  }
}

// Create a conversation through the slot-driven `new_conversation` method (the store write path).
function seedConversation(drv, id, extra = {}) {
  return drv.call('new_conversation', {
    thread_id: 't1',
    slots: { slots: { t1: { kind: 'session.new', workspace_id: 'w1' } } },
    conversation_id: id,
    workspace_id: 'w1',
    ...extra,
  })
}

function conversationById(read, id) {
  return (read.conversations ?? []).find((item) => item.id === id) ?? null
}

// refs 是消息 id → body 的映射；服务帧按规范序列化（键升序），故不能依赖键的插入序，
// 按 prev 链还原逻辑顺序。
function orderedBodies(refs) {
  const bodies = Object.values(refs)
  const byId = new Map(bodies.map((body) => [body.id, body]))
  const head = bodies.find((body) => !body.prev || !byId.has(body.prev.def))
  const out = []
  let current = head
  while (current) {
    out.push(current)
    current = bodies.find((body) => body.prev && body.prev.def === current.id)
  }
  return out
}

function commitEnv(run) {
  return { run, thread: 't1', now: 1_700_000_000_000 }
}

function turnEnv(run) {
  return { run, thread: 't1', now: 1_700_000_000_000 }
}

// -- handshake / control -----------------------------------------------------

test('hello returns manifest: durable state and full method list', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'session')
    assert.deepEqual(manifest.implements, ['session'])
    assert.equal(manifest.state, 'durable')
    assert.deepEqual(manifest.methods.session, [
      'commit',
      'new_conversation',
      'select',
      'rename',
      'set_title',
      'delete',
      'restore',
      'branch',
      'deliver',
      'ack_inbox',
      'turn_open',
      'turn_insert',
      'turn_note_input',
      'turn_has_pending_input',
      'turn_promote_input',
      'step_append',
      'turn_settle',
      'turn_cancel',
      'read',
      'list',
      'history',
    ])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('reload -> ack / drain -> bye / probe -> pong', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('stdin EOF exits (no orphan endpoint)', async () => {
  const drv = startService()
  await drv.hello()
  drv.close()
  assert.equal(await drv.exit, 0)
  drv.cleanup()
})

// -- commit: store write + read-back -----------------------------------------

test('commit writes own store: read round-trips chain and returns no world plan', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1', { title: 'new chat' })
    const before = drv.events.length
    const value = await drv.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' }, t2: { kind: 'idle' } } },
      conversation: 'c1',
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    })
    assert.equal('$directives' in value, false)
    assert.equal(JSON.stringify(value).includes('add_gen'), false)
    assert.equal(value.ok, true)
    assert.equal(value.conversation, 'c1')
    assert.equal(value.count, 2)
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.current, 'c1')
    assert.equal(conversationById(read, 'c1').count, 2)
    const chain = read.refs
    assert.equal(Object.keys(chain).length, 2)
    const [user, assistant] = orderedBodies(chain)
    assert.equal(user.role, 'user')
    assert.equal(user.content, 'hi')
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.content, 'hello')
    assert.deepEqual(assistant.prev, { def: user.id })
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.updated'])
    assert.ok(drv.portCalls.some((frame) => frame.port === 'input' && frame.method === 'clear'))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('commit appends as it runs: record readable before any close', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('commit', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'chat.message', text: 'a' } } },
      conversation: 'c1',
      user: { content: 'a' },
      assistant: { content: 'b' },
    })
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(conversationById(read, 'c1').count, 2)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('commit is idempotent for the same turn id', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    const args = {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      conversation: 'c1',
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    }
    await drv.call('commit', args, commitEnv('run-x'))
    await drv.call('commit', args, commitEnv('run-x'))
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(conversationById(read, 'c1').count, 2)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('commit failure path: user message + separate system message', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    const value = await drv.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      conversation: 'c1',
      error: 'model failed',
    })
    assert.equal(value.ok, false)
    assert.equal(value.error, 'model failed')
    const read = await drv.call('read', { conversation: 'c1' })
    const bodies = orderedBodies(read.refs)
    assert.equal(bodies[0].role, 'user')
    assert.equal(bodies[1].role, 'system')
    assert.equal(bodies[1].content, 'model failed')
    assert.deepEqual(bodies[1].meta, { error: 'model failed' })
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('commit append: only appends assistant, head follows current chain head', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      conversation: 'c1',
      user: { content: 'hi' },
      assistant: { content: 'first' },
    }, commitEnv('run-1'))
    const value = await drv.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      conversation: 'c1',
      user: { content: 'hi' },
      assistant: { content: 'approved done' },
      append: true,
    }, commitEnv('run-2'))
    assert.equal(value.count, 3)
    const read = await drv.call('read', { conversation: 'c1' })
    const bodies = orderedBodies(read.refs)
    assert.deepEqual(bodies.map((b) => b.role), ['user', 'assistant', 'assistant'])
    assert.equal(bodies[2].content, 'approved done')
    assert.deepEqual(bodies[2].prev, { def: bodies[1].id })
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('commit bad slot kind: failure value, no message written', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'idle' } } },
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    })
    assert.equal(value.ok, false)
    assert.equal(value.reason, 'bad_slot_kind')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('commit auto-creates conversation when current is absent', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const value = await drv.call('commit', {
      thread_id: 't1',
      session: { version: 1, current: null, conversations: [] },
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      user: { content: 'hi' },
      assistant: { content: 'hello' },
      new_conversation: { id: 'c9', workspace_id: 'w1', title: 'generated' },
    })
    assert.equal(value.ok, true)
    assert.equal(value.conversation, 'c9')
    const read = await drv.call('read', { conversation: 'c9' })
    assert.equal(read.current, 'c9')
    assert.equal(conversationById(read, 'c9').title, 'generated')
    assert.equal(conversationById(read, 'c9').count, 2)
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.opened', 'thread.updated'])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('commit without current and without new_conversation -> no_conversation', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('commit', {
      thread_id: 't1',
      session: { version: 1, current: null, conversations: [] },
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    })
    assert.equal(value.ok, false)
    assert.equal(value.reason, 'no_conversation')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// -- new_conversation / select / rename / set_title / delete / restore -------

test('new_conversation / select / rename / set_title write own store', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const created = await drv.call('new_conversation', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'session.new', workspace_id: 'w1' } } },
      workspace_id: 'w1',
      title: 'second',
      conversation_id: 'c2',
    })
    assert.equal(created.ok, true)
    assert.equal(created.conversation, 'c2')
    assert.equal((await drv.call('read', {})).current, 'c2')

    const selected = await drv.call('select', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'session.select', conversation: 'c1' } } },
      conversation: 'c1',
    })
    assert.equal(selected.ok, true)
    assert.equal((await drv.call('read', {})).current, 'c1')

    await drv.call('rename', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'session.rename' } } },
      conversation: 'c2',
      title: 'renamed',
    })
    assert.equal(conversationById(await drv.call('read', { conversation: 'c2' }), 'c2').title, 'renamed')

    await drv.call('set_title', { conversation: 'c2', title: 'auto title' })
    assert.equal(conversationById(await drv.call('read', { conversation: 'c2' }), 'c2').title, 'auto title')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('select missing target -> not_found', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('select', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'session.select', conversation: 'nope' } } },
      conversation: 'nope',
    })
    assert.equal(value.ok, false)
    assert.equal(value.reason, 'not_found')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('delete soft-deletes and falls back current; restore clears deleted_at', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await seedConversation(drv, 'c2')
    const before = drv.events.length
    const value = await drv.call('delete', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'session.delete', conversation: 'c2' } } },
      conversation: 'c2',
    })
    assert.equal(value.ok, true)
    assert.equal(value.current, 'c1')
    const read = await drv.call('read', { conversation: 'c2' })
    assert.equal(conversationById(read, 'c2').deleted_at, AT)
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.closed', 'thread.updated'])
    await drv.call('restore', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'session.restore', conversation: 'c2' } } },
      conversation: 'c2',
    })
    assert.equal(conversationById(await drv.call('read', { conversation: 'c2' }), 'c2').deleted_at, null)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// -- branch ------------------------------------------------------------------

test('branch copies the window up to the target message into a new conversation', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'a' } } },
      conversation: 'c1',
      user: { content: 'a' },
      assistant: { content: 'b' },
    }, commitEnv('run-1'))
    await drv.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'c' } } },
      conversation: 'c1',
      user: { content: 'c' },
      assistant: { content: 'd' },
    }, commitEnv('run-2'))
    const read = await drv.call('read', { conversation: 'c1' })
    const ids = orderedBodies(read.refs).map((body) => body.id)
    assert.equal(ids.length, 4)
    const value = await drv.call('branch', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'session.branch', conversation: 'c1', message: ids[1] } } },
      conversation: 'c1',
      message: ids[1],
      conversation_id: 'c-branch',
    })
    assert.equal(value.ok, true)
    assert.equal(value.conversation, 'c-branch')
    assert.equal(value.count, 2)
    const branched = await drv.call('read', { conversation: 'c-branch' })
    assert.equal(conversationById(branched, 'c-branch').count, 2)
    assert.equal(conversationById(branched, 'c-branch').source_message, ids[1])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// -- deliver -----------------------------------------------------------------

test('deliver writes inbox + status; terminal status emits thread.closed', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'sub1', { title: 'child' })
    const before = drv.events.length
    const value = await drv.call('deliver', {
      to: 'sub1',
      kind: 'report',
      body: 'done',
      status: 'done',
    })
    assert.equal(value.ok, true)
    assert.equal(value.seq, 1)
    const read = await drv.call('read', { conversation: 'sub1' })
    assert.equal(conversationById(read, 'sub1').status, 'done')
    assert.equal(conversationById(read, 'sub1').inbox.tail.def, 'inbox-sub1-1')
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.updated', 'thread.closed'])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// -- inbox unread / ack ------------------------------------------------------

test('inbox unread projection + monotonic ack (append-only, never backwards)', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'sub1', { title: 'child' })
    await drv.call('deliver', { to: 'sub1', kind: 'instruction', body: 'do a', from: 'parent' })
    await drv.call('deliver', { to: 'sub1', kind: 'instruction', body: 'do b', from: 'parent' })

    const read = await drv.call('read', { conversation: 'sub1' })
    assert.deepEqual(
      read.inbox_unread.map((item) => [item.seq, item.kind, item.from, item.body]),
      [
        [1, 'instruction', 'parent', 'do a'],
        [2, 'instruction', 'parent', 'do b'],
      ],
    )

    // ack 到 1：只消掉第一条，水位 = 1。
    const first = await drv.call('ack_inbox', { conversation: 'sub1', seq: 1 })
    assert.equal(first.ok, true)
    assert.equal(first.advanced, true)
    assert.equal(first.last_seen, 1)
    assert.deepEqual((await drv.call('read', { conversation: 'sub1' })).inbox_unread.map((item) => item.seq), [2])

    // ack 到 2：清空。
    await drv.call('ack_inbox', { conversation: 'sub1', seq: 2 })
    assert.deepEqual((await drv.call('read', { conversation: 'sub1' })).inbox_unread, [])

    // 已读 seq 再 ack = no-op；ack 更小的 seq 也不倒退（单调）。
    const again = await drv.call('ack_inbox', { conversation: 'sub1', seq: 1 })
    assert.equal(again.advanced, false)
    assert.equal(again.last_seen, 2)
    const smaller = await drv.call('ack_inbox', { conversation: 'sub1', seq: 0 })
    assert.equal(smaller.last_seen, 2)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('inbox ack is append-only and survives restart replay; last_seen never decreases', async () => {
  const root = tempRoot()
  const first = startService({ root })
  try {
    await first.hello()
    await seedConversation(first, 'sub1')
    await first.call('deliver', { to: 'sub1', kind: 'instruction', body: 'x' })
    await first.call('ack_inbox', { conversation: 'sub1', seq: 1 })
  } finally {
    first.close()
    await first.exit
  }
  const second = startService({ root })
  try {
    await second.hello()
    const read = await second.call('read', { conversation: 'sub1' })
    assert.equal(conversationById(read, 'sub1').inbox.last_seen, 1)
    assert.deepEqual(read.inbox_unread, [])
    // 重启后 ack 旧 seq 仍不倒退。
    const stale = await second.call('ack_inbox', { conversation: 'sub1', seq: 1 })
    assert.equal(stale.advanced, false)
    assert.equal(stale.last_seen, 1)
  } finally {
    second.close()
    await second.exit
    second.cleanup()
  }
})

test('ack_inbox on an unknown conversation -> not_found', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('ack_inbox', { conversation: 'nope', seq: 1 })
    assert.equal(value.ok, false)
    assert.equal(value.reason, 'not_found')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// -- history -----------------------------------------------------------------
test('history reads own store: window newest-first + before / limit by turn', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    // 展示投影以回合步日志为真源：两个回合各一条助手 step.result。
    await drv.call('turn_open', { turn_id: 't1', user_message: { content: 'a' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    await drv.call('step_append', { type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: 'b' } }, turnEnv('run-1'))
    await drv.call('turn_settle', { turn_id: 't1', outcome: COMMITTED }, turnEnv('run-1'))
    await drv.call('turn_open', { turn_id: 't2', user_message: { content: 'c' }, slot_ref: 'run-2' }, turnEnv('run-2'))
    await drv.call('step_append', { type: 'step.result', turn_id: 't2', seq: 1, assistant: { content: 'd' } }, turnEnv('run-2'))
    await drv.call('turn_settle', { turn_id: 't2', outcome: COMMITTED }, turnEnv('run-2'))

    const full = await drv.call('history', { conversation: 'c1' })
    assert.equal(full.conversation, 'c1')
    assert.deepEqual(full.messages.map((e) => e.def.content), ['d', 'c', 'b', 'a'])
    assert.equal(full.messages[0].def.content, 'd')
    // limit 现在是回合数：最近 1 个回合 = t2 的用户 / 助手两条。
    const limited = await drv.call('history', { conversation: 'c1', limit: 1 })
    assert.deepEqual(limited.messages.map((e) => e.def.content), ['d', 'c'])
    // before 命中的消息所属回合不含，取更旧回合。
    const before = await drv.call('history', { conversation: 'c1', before: full.messages[1].hash })
    assert.deepEqual(before.messages.map((e) => e.def.content), ['b', 'a'])
    assert.equal(full.next_before, null)
    // 展示面不再背展示时间线（无消费者），步记录也不在默认返值里。
    assert.equal(Object.hasOwn(full, 'display'), false)
    assert.equal(Object.hasOwn(full.turns[0], 'steps'), false)
    // refs 随窗口收敛：limit 1 只带本窗口消息。
    assert.deepEqual(Object.keys(limited.refs).sort(), limited.messages.map((e) => e.hash).sort())
    // 导出面显式全量：refs 收全量、turns 带步记录。
    const exported = await drv.call('history', { conversation: 'c1', full: true })
    assert.equal(Object.keys(exported.refs).length, 4)
    assert.ok(Array.isArray(exported.turns[0].steps))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// -- 3 / 4 split + restart replay -------------------------------------------

test('3/4 split: deleting CHRONO_PLUGIN_STATE still replays from the durable store', async () => {
  const root = tempRoot()
  const first = startService({ root })
  try {
    await first.hello()
    await seedConversation(first, 'c1')
    await first.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'persisted' } } },
      conversation: 'c1',
      user: { content: 'persisted' },
      assistant: { content: 'ok' },
    })
  } finally {
    first.close()
    await first.exit
  }
  rmSync(join(root, 'state'), { recursive: true, force: true })
  const second = startService({ root })
  try {
    await second.hello()
    const read = await second.call('read', { conversation: 'c1' })
    assert.equal(conversationById(read, 'c1').count, 2)
    assert.equal(orderedBodies(read.refs)[0].content, 'persisted')
  } finally {
    second.close()
    await second.exit
    second.cleanup()
  }
})

test('restart replay: same durable dir yields full history', async () => {
  const root = tempRoot()
  const first = startService({ root })
  try {
    await first.hello()
    await seedConversation(first, 'c1')
    await first.call('commit', {
      thread_id: 't1',
      slots: { slots: { t1: { kind: 'chat.message', text: 'x' } } },
      conversation: 'c1',
      user: { content: 'x' },
      assistant: { content: 'y' },
    })
  } finally {
    first.close()
    await first.exit
  }
  const second = startService({ root })
  try {
    await second.hello()
    assert.equal(conversationById(await second.call('read', { conversation: 'c1' }), 'c1').count, 2)
  } finally {
    second.close()
    await second.exit
    second.cleanup()
  }
})

// -- structured errors -------------------------------------------------------

test('non-object / missing args -> bad_args, process survives', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const nullArgs = await drv.callRaw('commit', null)
    assert.equal(nullArgs.kind, 'error')
    assert.equal(nullArgs.code, 'bad_args')
    const unknown = await drv.callRaw('nope', {})
    assert.equal(unknown.kind, 'error')
    assert.equal(unknown.code, 'unknown_method')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// -- turn event log: turn_open / step_append / turn_settle -------------------

test('turn_open creates the conversation in the same append when new_conversation is given', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const value = await drv.call('turn_open', {
      turn_id: 't-new',
      user_message: { content: 'hi' },
      slot_ref: 'run-1',
      new_conversation: { id: 'c9', workspace_id: 'w1', title: 'generated' },
    }, turnEnv('run-1'))
    assert.equal(value.ok, true)
    assert.equal(value.created, true)
    assert.equal(value.conversation, 'c9')
    const read = await drv.call('read', { conversation: 'c9' })
    assert.equal(read.current, 'c9')
    assert.equal(conversationById(read, 'c9').title, 'generated')
    assert.deepEqual(orderedBodies(read.refs).map((body) => body.role), ['user'])
    assert.equal(read.turns.length, 1)
    assert.equal(read.turns[0].turn_id, 't-new')
    assert.equal(read.turns[0].state, 'open')
    assert.deepEqual(drv.events.slice(before).map((event) => event.topic), ['thread.opened', 'thread.updated'])
    assert.ok(drv.portCalls.some((frame) => frame.port === 'input' && frame.method === 'clear'))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('turn_open: a subagent thread persists task + parent checkpoint without hijacking current', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    const value = await drv.call('turn_open', {
      turn_id: 't-sub',
      user_message: { content: '审查 a.ts' },
      slot_ref: 'run-sub',
      thread_id: 't1',
      thread_kind: 'subagent',
      task_prompt: '审查 a.ts',
      parent_checkpoint: { goal: '父目标' },
      new_conversation: { id: 'c-sub', workspace_id: 'w1', kind: 'subagent', parent: { def: 'c1' }, title: '审查 a.ts' },
    }, turnEnv('run-sub'))
    assert.equal(value.ok, true)
    assert.equal(value.created, true)
    assert.equal(value.conversation, 'c-sub')
    const opened = drv.events.find((event) => event.topic === 'thread.opened' && event.payload.conversation === 'c-sub')
    assert.equal(opened.payload.kind, 'subagent')

    const read = await drv.call('read', { conversation: 'c-sub' })
    const sub = conversationById(read, 'c-sub')
    assert.equal(sub.kind, 'subagent')
    assert.equal(sub.parent.def, 'c1')
    const turn = read.turns.find((item) => item.turn_id === 't-sub')
    assert.equal(turn.thread_kind, 'subagent')
    assert.equal(turn.task_prompt, '审查 a.ts')
    assert.deepEqual(turn.parent_checkpoint, { goal: '父目标' })

    // 子代理会话是旁路线程，不抢占 current。
    assert.equal((await drv.call('read', {})).current, 'c1')
    // 按 turn_id 取切片：解析到子代理会话（current 仍是主会话）。
    const byTurn = await drv.call('read', { turn_id: 't-sub' })
    assert.equal(conversationById(byTurn, 'c-sub') !== null, true)
    assert.ok(byTurn.turns.some((item) => item.turn_id === 't-sub'))
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('turn_open is idempotent by slot_ref: a re-send opens no second turn', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    const first = await drv.call('turn_open', {
      turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1',
    }, turnEnv('run-1'))
    const again = await drv.call('turn_open', {
      turn_id: 't2', user_message: { content: 'x' }, slot_ref: 'run-1',
    }, turnEnv('run-2'))
    assert.equal(first.created, true)
    assert.equal(again.created, false)
    assert.equal(again.turn_id, 't1')
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns.length, 1)
    assert.equal(orderedBodies(read.refs).filter((body) => body.role === 'user').length, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('turn_open: a duplicate slot_ref returns already_open and does not clear the slot again', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', {
      turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1', thread_id: 't1',
    }, turnEnv('run-1'))
    const clearsAfterFirst = drv.portCalls.filter((frame) => frame.port === 'input' && frame.method === 'clear').length
    const again = await drv.call('turn_open', {
      turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1', thread_id: 't1',
    }, turnEnv('run-2'))
    assert.equal(again.ok, true)
    assert.equal(again.status, 'already_open')
    assert.equal(again.created, false)
    assert.equal(again.state, 'open')
    assert.equal(again.turn_id, 't1')
    const clearsAfterSecond = drv.portCalls.filter((frame) => frame.port === 'input' && frame.method === 'clear').length
    assert.equal(clearsAfterSecond, clearsAfterFirst, '重复开回合不得再清槽')
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns.length, 1)
    assert.equal(orderedBodies(read.refs).filter((body) => body.role === 'user').length, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('turn_open: two concurrent opens in one conversation — exactly one wins, the other is turn_busy', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    const [a, b] = await Promise.all([
      drv.call('turn_open', { turn_id: 't-a', user_message: { content: 'a' }, slot_ref: 'run-a', thread_id: 't1' }, turnEnv('run-a')),
      drv.call('turn_open', { turn_id: 't-b', user_message: { content: 'b' }, slot_ref: 'run-b', thread_id: 't1' }, turnEnv('run-b')),
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, ['created', 'turn_busy'])
    const busy = a.status === 'turn_busy' ? a : b
    const winner = a.status === 'created' ? a : b
    assert.equal(busy.ok, false)
    assert.equal(busy.reason, 'turn_busy')
    assert.equal(busy.busy_turn_id, winner.turn_id)
    // 会话内互斥：只留一个开态回合，败者不落回合头。
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns.length, 1)
    assert.equal(read.open_turns.length, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('turn_open: a settled turn for the same slot replays as already_open with its outcome', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', {
      turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1', thread_id: 't1',
    }, turnEnv('run-1'))
    await drv.call('turn_settle', { turn_id: 't1', outcome: COMMITTED }, turnEnv('run-1'))
    const replay = await drv.call('turn_open', {
      turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1', thread_id: 't1',
    }, turnEnv('run-2'))
    assert.equal(replay.ok, true)
    assert.equal(replay.status, 'already_open')
    assert.equal(replay.created, false)
    assert.equal(replay.state, 'settled')
    assert.equal(replay.outcome.kind, 'committed')
    assert.deepEqual((await drv.call('read', { conversation: 'c1' })).open_turns, [])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('turn_open without a current conversation and without a spec -> no_conversation', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('turn_open', {
      turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1',
    }, turnEnv('run-1'))
    assert.equal(value.ok, false)
    assert.equal(value.reason, 'no_conversation')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('I1: a resumed turn keeps one assistant message and updates its tool-card status', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', { turn_id: 't1', user_message: { content: 'do it' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    await drv.call('step_append', {
      type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step',
      tool_calls: [{ id: 'call-1', name: 'fs.read', arguments: { path: 'a' } }],
    }, turnEnv('run-1'))
    await drv.call('step_append', {
      type: 'step.result', turn_id: 't1', seq: 0,
      assistant: { content: 'working', parts: [{ type: 'tool', call_id: 'call-1', status: null }] },
    }, turnEnv('run-1'))
    // Segment-terminal awaiting: suspend without settling. The resume continues the SAME turn_id.
    await drv.call('step_append', {
      type: 'step.result', turn_id: 't1', seq: 1,
      assistant: { content: 'done', parts: [{ type: 'tool', call_id: 'call-1', status: 'ok' }] },
      tool_results: [{ call_id: 'call-1', ok: true }],
    }, turnEnv('run-2'))
    await drv.call('turn_settle', { turn_id: 't1', outcome: COMMITTED }, turnEnv('run-2'))

    const read = await drv.call('read', { conversation: 'c1' })
    const assistants = orderedBodies(read.refs).filter((body) => body.role === 'assistant')
    assert.equal(assistants.length, 1)
    assert.equal(assistants[0].id, 'msg-c1-t1-assistant')
    assert.equal(assistants[0].parts[0].status, 'ok')
    assert.equal(read.turns[0].state, 'settled')
    assert.equal(read.turns[0].outcome.kind, 'committed')
    assert.equal(read.turns[0].steps.length, 3)
    assert.deepEqual(read.open_turns, [])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('turn_settle is CAS-guarded: a duplicate settle is recorded as a late log entry', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', { turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    const first = await drv.call('turn_settle', { turn_id: 't1', outcome: COMMITTED }, turnEnv('run-1'))
    assert.equal(first.ok, true)
    const late = await drv.call('turn_settle', { turn_id: 't1', outcome: CANCELLED }, turnEnv('run-1'))
    assert.equal(late.ok, false)
    assert.equal(late.rejected, true)
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].outcome.kind, 'committed')
    assert.equal(read.turns[0].late_settles.length, 1)
    assert.equal(read.turns[0].late_settles[0].kind, 'cancelled')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('concurrent turn_settle yields exactly one winner', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', { turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    const results = await Promise.all([
      drv.call('turn_settle', { turn_id: 't1', outcome: COMMITTED }, turnEnv('run-1')),
      drv.call('turn_settle', { turn_id: 't1', outcome: CANCELLED }, turnEnv('run-2')),
    ])
    assert.equal(results.filter((result) => result.ok === true).length, 1)
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].state, 'settled')
    assert.equal(read.turns[0].late_settles.length, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('turn_settle rejects the segment-terminal awaiting state (structured, not a protocol error)', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', { turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    const raw = await drv.callRaw('turn_settle', { turn_id: 't1', outcome: { kind: 'awaiting', retryable: false } })
    assert.equal(raw.kind, 'result')
    assert.equal(raw.value.ok, false)
    assert.equal(raw.value.reason, 'invalid_contract')
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].state, 'open')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('startup settle: an open turn restarts as interrupted{retryable:true}, and a late real settle overwrites it', async () => {
  const root = tempRoot()
  const first = startService({ root })
  try {
    await first.hello()
    await seedConversation(first, 'c1')
    await first.call('turn_open', { turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1' }, turnEnv('run-1'))
  } finally {
    first.close()
    await first.exit
  }
  const second = startService({ root })
  try {
    await second.hello()
    const read = await second.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].state, 'settled')
    assert.equal(read.turns[0].outcome.kind, 'interrupted')
    assert.equal(read.turns[0].outcome.retryable, true)
    assert.deepEqual(read.open_turns, [])
    const late = await second.call('turn_settle', { turn_id: 't1', outcome: COMMITTED }, turnEnv('run-2'))
    assert.equal(late.ok, true)
    const after = await second.call('read', { conversation: 'c1' })
    assert.equal(after.turns[0].outcome.kind, 'committed')
    assert.equal(after.turns[0].late_settles.length, 0)
  } finally {
    second.close()
    await second.exit
    second.cleanup()
  }
})

test('read exposes full turn slice with steps; history omits steps; open_turns lists in-flight turns', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', { turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    await drv.call('step_append', { type: 'step.intent', turn_id: 't1', seq: 0, kind: 'model.step', tool_calls: [] }, turnEnv('run-1'))
    await drv.call('step_append', { type: 'step.result', turn_id: 't1', seq: 0, assistant: { content: 'ok' } }, turnEnv('run-1'))
    // 引擎切片（read）保持全量：含步记录与 slot_ref。
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].turn_id, 't1')
    assert.equal(read.turns[0].state, 'open')
    assert.equal(read.turns[0].steps.length, 2)
    assert.equal(read.turns[0].slot_ref, 'run-1')
    assert.deepEqual(read.open_turns, [{ turn_id: 't1', conv: 'c1' }])
    // 清单面（list）不背切片：只有 body 与开着的回合摘要。
    const list = await drv.call('list', {})
    assert.equal(list.current, 'c1')
    assert.deepEqual(list.open_turns, [{ turn_id: 't1', conv: 'c1' }])
    assert.equal(Object.hasOwn(list, 'turns'), false)
    assert.equal(Object.hasOwn(list, 'refs'), false)
    // 展示面（history）默认不带步记录；full 才带。
    const history = await drv.call('history', { conversation: 'c1' })
    assert.equal(history.turns[0].turn_id, 't1')
    assert.equal(Object.hasOwn(history.turns[0], 'steps'), false)
    const full = await drv.call('history', { conversation: 'c1', full: true })
    assert.equal(full.turns[0].steps.length, 2)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('step_append / turn_settle on an unknown turn are structured failures', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const step = await drv.call('step_append', { type: 'step.intent', turn_id: 'nope', seq: 0, kind: 'k', tool_calls: [] })
    assert.equal(step.ok, false)
    assert.equal(step.reason, 'unknown_turn')
    const settle = await drv.call('turn_settle', { turn_id: 'nope', outcome: COMMITTED })
    assert.equal(settle.ok, false)
    assert.equal(settle.reason, 'unknown_turn')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// -- turn_cancel / cancelled settle -----------------------------------------

test('turn_cancel records the cancel intent; a restart settles that open turn as cancelled', async () => {
  const root = tempRoot()
  const first = startService({ root })
  try {
    await first.hello()
    await seedConversation(first, 'c1')
    await first.call('turn_open', { turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    const cancelled = await first.call('turn_cancel', { turn_id: 't1' }, turnEnv('run-1'))
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.state, 'open')
    assert.equal(cancelled.conversation, 'c1')
    const read = await first.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].cancel_requested, true)
    assert.equal(read.turns[0].state, 'open')
    assert.equal(read.open_turns.length, 1)
    // 取消意图幂等：再次记录不改变状态、不追加第二条。
    const again = await first.call('turn_cancel', { turn_id: 't1' }, turnEnv('run-1'))
    assert.equal(again.ok, true)
    assert.equal(again.state, 'open')
  } finally {
    first.close()
    await first.exit
  }
  const second = startService({ root })
  try {
    await second.hello()
    const read = await second.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].state, 'settled')
    assert.equal(read.turns[0].outcome.kind, 'cancelled')
    assert.equal(read.turns[0].cancel_requested, true)
    assert.deepEqual(read.open_turns, [])
  } finally {
    second.close()
    await second.exit
    second.cleanup()
  }
})

test('turn_cancel: settled turn is a no-op with its outcome; unknown turn is structured', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', { turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    await drv.call('turn_settle', { turn_id: 't1', outcome: COMMITTED }, turnEnv('run-1'))
    const cancelled = await drv.call('turn_cancel', { turn_id: 't1' }, turnEnv('run-1'))
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.state, 'settled')
    assert.equal(cancelled.outcome.kind, 'committed')
    // 已收口回合不被打上取消意图（不回溯成功回合）。
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].cancel_requested, false)
    const unknown = await drv.call('turn_cancel', { turn_id: 'nope' }, turnEnv('run-1'))
    assert.equal(unknown.ok, false)
    assert.equal(unknown.reason, 'unknown_turn')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('zombie settle: after a cancelled settle, a late real settle is rejected and recorded', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seedConversation(drv, 'c1')
    await drv.call('turn_open', { turn_id: 't1', user_message: { content: 'x' }, slot_ref: 'run-1' }, turnEnv('run-1'))
    await drv.call('turn_cancel', { turn_id: 't1' }, turnEnv('run-1'))
    const cancelled = await drv.call('turn_settle', { turn_id: 't1', outcome: CANCELLED }, turnEnv('run-1'))
    assert.equal(cancelled.ok, true)
    const zombie = await drv.call('turn_settle', { turn_id: 't1', outcome: COMMITTED }, turnEnv('run-2'))
    assert.equal(zombie.ok, false)
    assert.equal(zombie.rejected, true)
    const read = await drv.call('read', { conversation: 'c1' })
    assert.equal(read.turns[0].outcome.kind, 'cancelled', '僵尸收口不得改写结局')
    assert.equal(read.turns[0].late_settles.length, 1)
    assert.equal(read.turns[0].late_settles[0].kind, 'committed')
  } finally {
    drv.close()
    drv.cleanup()
  }
})
