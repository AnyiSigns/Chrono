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

function commitEnv(run) {
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
      'read',
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
    const ids = Object.keys(chain)
    assert.equal(ids.length, 2)
    const user = chain[ids[0]]
    const assistant = chain[ids[1]]
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
    const bodies = Object.values(read.refs)
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
    const bodies = Object.values(read.refs)
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
    const ids = Object.keys(read.refs)
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

// -- history -----------------------------------------------------------------

test('history reads own store: window newest-first + before / limit', async () => {
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
    const full = await drv.call('history', { conversation: 'c1' })
    assert.equal(full.conversation, 'c1')
    assert.equal(full.messages.length, 4)
    assert.equal(full.messages[0].def.content, 'd')
    const limited = await drv.call('history', { conversation: 'c1', limit: 2 })
    assert.deepEqual(limited.messages.map((e) => e.def.content), ['d', 'c'])
    const before = await drv.call('history', { conversation: 'c1', before: full.messages[1].hash })
    assert.deepEqual(before.messages.map((e) => e.def.content), ['b', 'a'])
    assert.equal(full.next_before, null)
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
    assert.equal(Object.values(read.refs)[0].content, 'persisted')
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
