// `session` 服务协议级测试（node --test）：自实现最小协议驱动。
// 驱动 spawn `node execute/main.ts`，发 hello → 收 manifest，发 call → 收 result / error，收 event 帧，
// 覆盖 reload / drain / probe 与 stdin EOF 自退出。断言只针对「返回的计划 / 事件」——服务不落账。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { assembleBody } from '../../../packages/kernel/patch.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const AT = '2023-11-14T22:13:20.000Z'
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const H3 = 'c'.repeat(64)

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

function startService() {
  const child = spawn(process.execPath, [ENTRY], { cwd: PKG_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = createDecoder()
  const pending = new Map()
  const events = []
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'event') {
        events.push(message)
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
    events,
    exit,
    request,
    async hello() {
      return request('hello', { impl: 'session', gen: 'gen-1' }, 'manifest')
    },
    async call(method, args, env = FIXED_ENV) {
      const message = await request('call', { port: 'session', method, args, env }, 'result')
      return message.value
    },
    async callRaw(method, args, env = FIXED_ENV) {
      return request('call', { port: 'session', method, args, env }, ['result', 'error'])
    },
    close() {
      child.stdin.end()
    },
  }
}

function baseConversation(overrides = {}) {
  return {
    id: 'c1',
    workspace_id: 'w1',
    title: '新对话',
    kind: 'main',
    parent: null,
    agent: null,
    participants: [],
    workflow: null,
    inbox: { tail: null, count: 0, last_seen: 0 },
    status: 'waiting',
    last_activity: null,
    pending: { approval: 0, question: 0 },
    head: null,
    count: 0,
    created: AT,
    deleted_at: null,
    ...overrides,
  }
}

function baseSession(overrides = {}) {
  return { version: 1, current: 'c1', conversations: [baseConversation()], ...overrides }
}

function batchOps(directives) {
  assert.equal(directives.length, 2)
  assert.equal(directives[0].kind, 'write')
  assert.equal(directives[0].request.op, 'batch')
  return directives[0].request.args.ops
}

function externPayload(directives) {
  assert.equal(directives[1].kind, 'extern')
  return directives[1].payload
}

function opsFor(plan) {
  return batchOps(plan.$directives)
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('hello 回 manifest，声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'session')
    assert.deepEqual(manifest.implements, ['session'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
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
    ])
  } finally {
    drv.close()
  }
})

test('reload → ack / drain → bye / probe → pong', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
})

test('stdin EOF 即自退出（断连不占端点）', async () => {
  const drv = startService()
  await drv.hello()
  drv.close()
  const code = await drv.exit
  assert.equal(code, 0)
})

// ── commit ─────────────────────────────────────────────────────────────────

test('commit 正常：两条消息 def + 新会话 body + 清槽 + add_gen，占位符正确', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const plan = await drv.call('commit', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' }, t2: { kind: 'idle' } } },
      conversation: 'c1',
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 6)
    assert.equal(ops[0].op, 'put')
    assert.equal(ops[0].args.body.role, 'user')
    assert.equal(ops[0].args.body.content, 'hi')
    assert.equal(ops[0].args.body.prev, null)
    assert.equal(ops[0].args.body.at, AT)
    assert.equal(ops[1].args.body.role, 'assistant')
    assert.deepEqual(ops[1].args.body.prev, { def: { $n: 0 } })
    assert.deepEqual(ops[2].args.body.conversations[0].head, { def: { $n: 1 } })
    assert.equal(ops[2].args.body.conversations[0].count, 2)
    assert.equal(ops[2].args.body.conversations[0].last_activity.summary, 'hello')
    assert.deepEqual(ops[3], {
      op: 'add_gen',
      args: { id: 'session', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} },
    })
    assert.deepEqual(ops[4].args.body.slots, { t1: { kind: 'idle' }, t2: { kind: 'idle' } })
    assert.deepEqual(ops[5], {
      op: 'add_gen',
      args: { id: 'input', payload: { $n: 4 }, sig: { $n: 4 }, pins: {} },
    })
    const payload = externPayload(plan.$directives)
    assert.equal(payload.ok, true)
    assert.equal(payload.reply.content, 'hello')
    assert.equal(payload.count, 2)
    const emitted = drv.events.slice(before)
    assert.deepEqual(emitted.map((e) => e.topic), ['thread.updated'])
    assert.equal(emitted[0].payload.conversation, 'c1')
    assert.equal(emitted[0].payload.run, 'run-1')
    // 数据变更类事件的 thread = 目标线程（不是发起 run 的 env.thread='t1'）
    assert.equal(emitted[0].payload.thread, 'c1')
  } finally {
    drv.close()
  }
})

test('commit 缺省 status 不写入 null（保留原值 / 缺键）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const plan = await drv.call('commit', {
      thread_id: 't1',
      session: baseSession({ conversations: [baseConversation({ status: undefined })] }),
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      conversation: 'c1',
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    })
    const next = opsFor(plan)[2].args.body.conversations[0]
    assert.equal('status' in next, false, 'status 不得写入 null')
  } finally {
    drv.close()
  }
})

test('commit group 会话 → group.message 带消息 id 与目标线程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    await drv.call('commit', {
      thread_id: 't1',
      session: baseSession({ conversations: [baseConversation({ kind: 'group' })] }),
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      conversation: 'c1',
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    })
    const groupMessage = drv.events.slice(before).find((e) => e.topic === 'group.message')
    assert.equal(groupMessage.payload.id, 'msg-c1-0')
    assert.equal(groupMessage.payload.thread, 'c1')
    assert.equal(groupMessage.payload.from, 'user')
  } finally {
    drv.close()
  }
})

test('commit 保留其它线程键（per-thread 只清本键）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const plan = await drv.call('commit', {
      thread_id: 't2',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'chat.message', text: 'other' }, t2: { kind: 'chat.message', text: 'mine' } } },
      user: { content: 'mine' },
      assistant: { content: 'ok' },
    })
    const ops = opsFor(plan)
    assert.deepEqual(ops[4].args.body.slots, {
      t1: { kind: 'chat.message', text: 'other' },
      t2: { kind: 'idle' },
    })
  } finally {
    drv.close()
  }
})

test('commit 失败路径：用户消息 + 独立 system 消息 def（meta.error）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const plan = await drv.call('commit', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      error: 'model failed',
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 6)
    assert.equal(ops[0].args.body.role, 'user')
    assert.equal(ops[0].args.body.content, 'hi')
    assert.equal(ops[1].args.body.role, 'system')
    assert.equal(ops[1].args.body.content, 'model failed')
    assert.deepEqual(ops[1].args.body.meta, { error: 'model failed' })
    assert.deepEqual(ops[1].args.body.prev, { def: { $n: 0 } })
    assert.deepEqual(ops[2].args.body.conversations[0].head, { def: { $n: 1 } })
    assert.equal(ops[2].args.body.conversations[0].count, 2)
    assert.deepEqual(ops[3].args, { id: 'session', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} })
    assert.deepEqual(ops[4].args.body.slots, { t1: { kind: 'idle' } })
    assert.deepEqual(ops[5].args, { id: 'input', payload: { $n: 4 }, sig: { $n: 4 }, pins: {} })
    assert.equal(externPayload(plan.$directives).ok, false)
    assert.equal(externPayload(plan.$directives).error, 'model failed')
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.updated'])
  } finally {
    drv.close()
  }
})

test('commit 非法槽 kind：无部分写（只清槽 + 返回失败值）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const plan = await drv.call('commit', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'idle' } } },
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 2)
    assert.equal(ops[0].op, 'put')
    assert.deepEqual(ops[0].args.body.slots, { t1: { kind: 'idle' } })
    assert.deepEqual(ops[1].args, { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} })
    const payload = externPayload(plan.$directives)
    assert.equal(payload.ok, false)
    assert.equal(payload.reason, 'bad_slot_kind')
  } finally {
    drv.close()
  }
})

// ── new_conversation / select / rename / set_title ─────────────────────────

test('new_conversation：新条目 + current 指向 + opened 事件', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const plan = await drv.call('new_conversation', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'session.new', workspace_id: 'w1' } } },
      workspace_id: 'w1',
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 4)
    const body = ops[0].args.body
    assert.equal(body.current, body.conversations[1].id)
    assert.equal(body.conversations[1].workspace_id, 'w1')
    assert.equal(body.conversations[1].title, '新对话')
    assert.equal(body.conversations[1].count, 0)
    assert.deepEqual(ops[1].args, { id: 'session', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} })
    assert.deepEqual(ops[2].args.body.slots, { t1: { kind: 'idle' } })
    assert.deepEqual(ops[3].args, { id: 'input', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} })
    assert.equal(externPayload(plan.$directives).ok, true)
    assert.deepEqual(
      drv.events.slice(before).map((e) => e.topic),
      ['thread.opened', 'thread.updated'],
    )
  } finally {
    drv.close()
  }
})

test('数据 body 归一：投影回落代码 body（含 tree/meta）不污染会话数据世代', async () => {
  const drv = startService()
  try {
    await drv.hello()
    // 无数据世代时投影 body 回落代码 commit body：含字符串 tree / meta / refs
    const polluted = {
      meta: { name: 'session', version: '0.0.0' },
      tree: 'a'.repeat(64),
      refs: { x: { id: 'm' } },
      current: null,
      conversations: [],
    }
    const plan = await drv.call('new_conversation', {
      thread_id: 't1',
      session: polluted,
      slots: { slots: { t1: { kind: 'session.new' } } },
    })
    const body = opsFor(plan)[0].args.body
    // 关键：数据体不得含字符串 tree（否则 isCodeGen 会把数据世代误判为代码世代）
    assert.equal('tree' in body, false, '不得把代码体 tree 带进会话数据体')
    assert.equal('meta' in body, false, '不得把代码体 meta 带进会话数据体')
    assert.equal('refs' in body, false, '不得把代码体 refs 带进会话数据体')
    assert.equal(body.version, 1)
    assert.equal(body.conversations.length, 1)
  } finally {
    drv.close()
  }
})

test('select：切 current；目标不存在 → 只清槽 + extern ok:false', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = baseSession({
      conversations: [baseConversation(), baseConversation({ id: 'c2' })],
    })
    const before = drv.events.length
    const plan = await drv.call('select', {
      thread_id: 't1',
      session,
      slots: { slots: { t1: { kind: 'session.select', conversation: 'c2' } } },
      conversation: 'c2',
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 4)
    assert.equal(ops[0].args.body.current, 'c2')
    assert.equal(externPayload(plan.$directives).ok, true)
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.updated'])

    const missing = await drv.call('select', {
      thread_id: 't1',
      session,
      slots: { slots: { t1: { kind: 'session.select', conversation: 'nope' } } },
      conversation: 'nope',
    })
    const missingOps = opsFor(missing)
    assert.equal(missingOps.length, 2)
    assert.equal(externPayload(missing.$directives).ok, false)
    assert.equal(externPayload(missing.$directives).reason, 'not_found')
  } finally {
    drv.close()
  }
})

test('rename：改标题 + updated 事件；缺 title → 只清槽失败值', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const plan = await drv.call('rename', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'session.rename', title: '新名字' } } },
      conversation: 'c1',
      title: '新名字',
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 4)
    assert.equal(ops[0].args.body.conversations[0].title, '新名字')
    assert.equal(externPayload(plan.$directives).title, '新名字')
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.updated'])

    const bad = await drv.call('rename', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'session.rename' } } },
      conversation: 'c1',
    })
    assert.equal(opsFor(bad).length, 2)
    assert.equal(externPayload(bad.$directives).reason, 'missing_title')
  } finally {
    drv.close()
  }
})

test('set_title：args 驱动、不清槽、无条件写入', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const plan = await drv.call('set_title', {
      session: baseSession(),
      conversation: 'c1',
      title: '自动标题',
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 2)
    assert.equal(ops[0].args.body.conversations[0].title, '自动标题')
    assert.deepEqual(ops[1].args, { id: 'session', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} })
    assert.equal(externPayload(plan.$directives).ok, true)
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.updated'])

    const missing = await drv.call('set_title', { session: baseSession(), conversation: 'nope', title: 'x' })
    assert.equal(missing.$directives.length, 1)
    assert.equal(missing.$directives[0].kind, 'extern')
    assert.equal(missing.$directives[0].payload.ok, false)
  } finally {
    drv.close()
  }
})

// ── delete / restore ───────────────────────────────────────────────────────

test('delete：软删 + current 回退同工作区最近未删 + closed 事件', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = baseSession({
      current: 'c2',
      conversations: [baseConversation(), baseConversation({ id: 'c2' })],
    })
    const before = drv.events.length
    const plan = await drv.call('delete', {
      thread_id: 't1',
      session,
      slots: { slots: { t1: { kind: 'session.delete', conversation: 'c2' } } },
      conversation: 'c2',
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 4)
    const deleted = ops[0].args.body.conversations[1]
    assert.equal(deleted.id, 'c2')
    assert.equal(deleted.deleted_at, AT)
    assert.equal(ops[0].args.body.current, 'c1')
    assert.equal(externPayload(plan.$directives).current, 'c1')
    assert.deepEqual(
      drv.events.slice(before).map((e) => e.topic),
      ['thread.closed', 'thread.updated'],
    )
  } finally {
    drv.close()
  }
})

test('delete 唯一会话 → current 回退 null', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const plan = await drv.call('delete', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'session.delete', conversation: 'c1' } } },
      conversation: 'c1',
    })
    assert.equal(opsFor(plan)[0].args.body.current, null)
    assert.equal(externPayload(plan.$directives).current, null)
  } finally {
    drv.close()
  }
})

test('restore：清 deleted_at + updated 事件', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = baseSession({
      conversations: [baseConversation({ deleted_at: AT })],
    })
    const before = drv.events.length
    const plan = await drv.call('restore', {
      thread_id: 't1',
      session,
      slots: { slots: { t1: { kind: 'session.restore', conversation: 'c1' } } },
      conversation: 'c1',
    })
    assert.equal(opsFor(plan)[0].args.body.conversations[0].deleted_at, null)
    assert.equal(externPayload(plan.$directives).ok, true)
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.updated'])
  } finally {
    drv.close()
  }
})

// ── branch ─────────────────────────────────────────────────────────────────

test('branch：以源消息为父链拷贝消息 def（prev 重建）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const refs = {
      [H1]: { id: 'm1', role: 'user', content: 'a', at: AT, prev: null },
      [H2]: { id: 'm2', role: 'assistant', content: 'b', at: AT, prev: { def: H1 } },
      [H3]: { id: 'm3', role: 'user', content: 'c', at: AT, prev: { def: H2 } },
    }
    const session = baseSession({
      conversations: [baseConversation({ head: { def: H3 }, count: 3 })],
    })
    const before = drv.events.length
    const plan = await drv.call('branch', {
      thread_id: 't1',
      session,
      slots: { slots: { t1: { kind: 'session.branch', conversation: 'c1', message: 'm2' } } },
      conversation: 'c1',
      message: 'm2',
      refs,
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 6)
    assert.deepEqual(ops[0].args.body.prev, null)
    assert.equal(ops[0].args.body.content, 'a')
    assert.deepEqual(ops[1].args.body.prev, { def: { $n: 0 } })
    assert.equal(ops[1].args.body.content, 'b')
    const body = ops[2].args.body
    const entry = body.conversations[1]
    assert.equal(entry.count, 2)
    assert.deepEqual(entry.head, { def: { $n: 1 } })
    assert.equal(entry.parent.def, 'c1')
    assert.equal(entry.source_message, 'm2')
    assert.equal(body.current, entry.id)
    assert.deepEqual(ops[3].args, { id: 'session', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} })
    assert.deepEqual(ops[5].args, { id: 'input', payload: { $n: 4 }, sig: { $n: 4 }, pins: {} })
    assert.equal(externPayload(plan.$directives).count, 2)
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.opened', 'thread.updated'])
    assert.equal(drv.events.slice(before)[0].payload.thread, entry.id)
  } finally {
    drv.close()
  }
})

// ── deliver ────────────────────────────────────────────────────────────────

test('deliver：写 inbox + status/last_activity/pending + opened 事件（新子线程）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const plan = await drv.call('deliver', {
      session: baseSession(),
      to: 'sub1',
      kind: 'instruction',
      body: 'do it',
      thread_kind: 'subagent',
      parent: { def: 'c1' },
      status: 'running',
      pending: { approval: 1, question: 0 },
    })
    const ops = opsFor(plan)
    assert.equal(ops.length, 3)
    const inboxMessage = ops[0].args.body
    assert.equal(inboxMessage.to, 'sub1')
    assert.equal(inboxMessage.seq, 1)
    assert.equal(inboxMessage.body, 'do it')
    assert.equal(inboxMessage.prev, null)
    assert.equal(inboxMessage.at, AT)
    const thread = ops[1].args.body.conversations[1]
    assert.deepEqual(thread.inbox, { tail: { def: { $n: 0 } }, count: 1, last_seen: 0 })
    assert.equal(thread.status, 'running')
    assert.deepEqual(thread.pending, { approval: 1, question: 0 })
    assert.deepEqual(ops[2].args, { id: 'session', payload: { $n: 1 }, sig: { $n: 1 }, pins: {} })
    assert.equal(externPayload(plan.$directives).seq, 1)
    assert.deepEqual(drv.events.slice(before).map((e) => e.topic), ['thread.opened', 'thread.updated'])
  } finally {
    drv.close()
  }
})

test('deliver：report 到已有子线程 → 追加 inbox + status done → updated/closed', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = baseSession({
      conversations: [
        baseConversation(),
        baseConversation({
          id: 'sub1',
          kind: 'subagent',
          status: 'running',
          inbox: { tail: { def: H1 }, count: 1, last_seen: 0 },
        }),
      ],
    })
    const before = drv.events.length
    const plan = await drv.call('deliver', {
      session,
      to: 'sub1',
      kind: 'report',
      body: 'done',
      status: 'done',
      last_seen: 1,
    })
    const ops = opsFor(plan)
    const inboxMessage = ops[0].args.body
    assert.equal(inboxMessage.seq, 2)
    assert.deepEqual(inboxMessage.prev, { def: H1 })
    const thread = ops[1].args.body.conversations[1]
    assert.deepEqual(thread.inbox, { tail: { def: { $n: 0 } }, count: 2, last_seen: 1 })
    assert.equal(thread.status, 'done')
    assert.deepEqual(
      drv.events.slice(before).map((e) => e.topic),
      ['thread.updated', 'thread.closed'],
    )
    assert.deepEqual(drv.events.slice(before)[0].payload.changed, ['inbox', 'status'])
  } finally {
    drv.close()
  }
})

test('deliver：group 追加 → group.message；workflow 位置推进 → workflow.step', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = baseSession({
      conversations: [
        baseConversation(),
        baseConversation({ id: 'g1', kind: 'group' }),
        baseConversation({
          id: 'wf1',
          kind: 'workflow',
          workflow: { graph: { def: 'g' }, node_index: 0, iter: 0 },
        }),
      ],
    })
    const before = drv.events.length
    await drv.call('deliver', { session, to: 'g1', kind: 'report', body: 'hi' })
    await drv.call('deliver', {
      session,
      to: 'wf1',
      kind: 'report',
      body: 'step',
      workflow: { graph: { def: 'g' }, node_index: 1, iter: 0 },
    })
    assert.deepEqual(
      drv.events.slice(before).map((e) => e.topic),
      ['thread.updated', 'group.message', 'thread.updated', 'workflow.step'],
    )
    const groupMessage = drv.events.slice(before).find((e) => e.topic === 'group.message')
    assert.equal(groupMessage.payload.id, 'inbox-g1-1')
    assert.equal(groupMessage.payload.thread, 'g1')
    assert.equal(groupMessage.payload.conversation, 'g1')
    const workflowStep = drv.events.slice(before).find((e) => e.topic === 'workflow.step')
    assert.equal(workflowStep.payload.thread, 'wf1')
    assert.equal(workflowStep.payload.node_index, 1)
  } finally {
    drv.close()
  }
})

// ── 补丁世代（data_gen 存在时写补丁 + base，组装结果与整份写入等价） ────────────

/** 跑同一次会话调用两次：一次整份写入、一次补丁写入，返回两者的会话 body / 补丁。 */
async function patchEquivalence(drv, method, args, fullBodyIndex, patchDefIndex) {
  const full = opsFor(await drv.call(method, args))
  const fullBody = full[fullBodyIndex].args.body
  const patched = opsFor(await drv.call(method, { ...args, session: { ...args.session, data_gen: { seq: 7, payload: H1 } } }))
  const patchDef = patched[patchDefIndex].args.body
  const addGen = patched[patchDefIndex + 1]
  assert.equal(addGen.op, 'add_gen')
  assert.equal(addGen.args.id, 'session')
  assert.equal(addGen.args.base, 7)
  assert.ok(Array.isArray(patchDef.ops) && patchDef.ops.length > 0)
  return { fullBody, assembled: assembleBody(args.session, patchDef.ops), patched }
}

test('补丁世代：commit 组装结果 == 整份写入结果', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const args = {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'chat.message', text: 'hi' } } },
      conversation: 'c1',
      user: { content: 'hi' },
      assistant: { content: 'hello' },
    }
    const { fullBody, assembled, patched } = await patchEquivalence(drv, 'commit', args, 2, 2)
    assert.deepEqual(assembled, fullBody)
    // 补丁只动变更的会话条目，不重写整个 conversations 列表
    assert.deepEqual(patched[2].args.body.ops, [
      { op: 'replace', path: ['conversations', 0], value: fullBody.conversations[0] },
    ])
  } finally {
    drv.close()
  }
})

test('补丁世代：rename / new_conversation 组装结果 == 整份写入结果', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const renamed = await patchEquivalence(
      drv,
      'rename',
      {
        thread_id: 't1',
        session: baseSession(),
        slots: { slots: { t1: { kind: 'session.rename' } } },
        conversation: 'c1',
        title: '改名',
      },
      0,
      0,
    )
    assert.deepEqual(renamed.assembled, renamed.fullBody)

    const created = await patchEquivalence(
      drv,
      'new_conversation',
      {
        thread_id: 't1',
        session: baseSession(),
        slots: { slots: { t1: { kind: 'session.new' } } },
        title: '新会话',
        conversation_id: 'c2',
      },
      0,
      0,
    )
    assert.deepEqual(created.assembled, created.fullBody)
    assert.deepEqual(
      created.patched[0].args.body.ops.map((op) => op.op).sort(),
      ['append', 'replace'],
    )
  } finally {
    drv.close()
  }
})

test('补丁世代：无变更会话写回落整份（空补丁非法）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const plan = await drv.call('select', {
      thread_id: 't1',
      session: { ...baseSession(), data_gen: { seq: 2, payload: H1 } },
      slots: { slots: { t1: { kind: 'session.select' } } },
      conversation: 'c1',
    })
    const ops = opsFor(plan)
    assert.equal(ops[0].op, 'put')
    assert.equal(Array.isArray(ops[0].args.body.ops), false)
    assert.deepEqual(ops[1].args, { id: 'session', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} })
  } finally {
    drv.close()
  }
})

// ── 结构化错误 ─────────────────────────────────────────────────────────────

test('非对象 / 缺字段 args → bad_args，不崩进程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const nullArgs = await drv.callRaw('commit', null)
    assert.equal(nullArgs.kind, 'error')
    assert.equal(nullArgs.code, 'bad_args')

    const missing = await drv.callRaw('deliver', { session: baseSession() })
    assert.equal(missing.kind, 'error')
    assert.equal(missing.code, 'bad_args')

    const unknown = await drv.callRaw('nope', {})
    assert.equal(unknown.kind, 'error')
    assert.equal(unknown.code, 'unknown_method')

    // 进程仍可服务：后续正常调用成功
    const plan = await drv.call('commit', {
      thread_id: 't1',
      session: baseSession(),
      slots: { slots: { t1: { kind: 'chat.message', text: 'x' } } },
      user: { content: 'x' },
      assistant: { content: 'y' },
    })
    assert.equal(externPayload(plan.$directives).ok, true)
  } finally {
    drv.close()
  }
})
