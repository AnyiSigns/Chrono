// `approval` 服务协议级测试（node --test）：自实现最小协议驱动。
// 驱动 spawn `node execute/main.ts`，发 hello → 收 manifest，发 call → 收 result / error，收 event 帧，
// 覆盖 reload / drain / probe 与 stdin EOF 自退出。断言只针对「返回的计划 / 事件」——服务不落账、不读投影。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const AT = '2023-11-14T22:13:20.000Z'
const AT_LATE = '2023-11-14T22:25:00.000Z'
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

function hashOf(n) {
  return n.toString(16).padStart(64, '0')
}

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
      return request('hello', { impl: 'approval', gen: 'gen-1' }, 'manifest')
    },
    async call(method, args, env = FIXED_ENV) {
      const message = await request('call', { port: 'approval', method, args, env }, 'result')
      return message.value
    },
    async callRaw(method, args, env = FIXED_ENV) {
      return request('call', { port: 'approval', method, args, env }, ['result', 'error'])
    },
    close() {
      child.stdin.end()
    },
  }
}

/** 由 oldest→newest 的 item 列表构造 `{queue, refs, hashes}`（prev 成链）。 */
function chainOf(items) {
  const refs = {}
  const hashes = []
  let prev = null
  items.forEach((item, index) => {
    const defHash = hashOf(index + 1)
    refs[defHash] = { ...item, prev }
    hashes.push(defHash)
    prev = { def: defHash }
  })
  const tail = hashes.length === 0 ? null : { def: hashes[hashes.length - 1] }
  return { queue: { version: 1, tail, count: items.length }, refs, hashes }
}

function emptyQueue() {
  return { version: 1, tail: null, count: 0 }
}

function directivesOf(value) {
  return value.$directives
}

function opsOf(value) {
  const batch = directivesOf(value).find((item) => item.kind === 'write')
  assert.ok(batch, 'expected a write batch directive')
  assert.equal(batch.request.op, 'batch')
  return batch.request.args.ops
}

function externOf(value) {
  const extern = directivesOf(value).find((item) => item.kind === 'extern')
  assert.ok(extern, 'expected an extern directive')
  return extern.payload
}

function pendingItem(overrides = {}) {
  return {
    id: 'ap-r1-0',
    kind: 'tool_call',
    port: 'tool-shell',
    method: 'invoke',
    args_ref: { summary: 'rm -rf' },
    tier: 'severe',
    workspace_id: 'w1',
    run: 'r1',
    thread: 't1',
    at: AT,
    status: 'pending',
    decided_at: null,
    by: null,
    resume: { command: 'chat.resume', args: { cursor: { iter: 2 }, thread: 't1' } },
    shadow: null,
    ...overrides,
  }
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('hello 回 manifest，声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'approval')
    assert.deepEqual(manifest.implements, ['approval'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.deepEqual(manifest.methods.approval, ['enqueue', 'list', 'decide', 'decide_all', 'sweep'])
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

// ── enqueue ────────────────────────────────────────────────────────────────

test('enqueue：item 链 + resume 游标 + thread + 乐观 pending 事件', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const plan = await drv.call('enqueue', {
      queue: emptyQueue(),
      refs: {},
      kind: 'tool_call',
      port: 'tool-shell',
      method: 'invoke',
      args_ref: { sha256: H1 },
      tier: 'severe',
      workspace_id: 'w1',
      run: 'r1',
      thread: 't1',
      cursor: { iter: 2 },
      at: AT,
    })
    const ops = opsOf(plan)
    assert.equal(ops.length, 3)
    const item = ops[0].args.body
    assert.equal(item.id, 'ap-r1-0')
    assert.equal(item.kind, 'tool_call')
    assert.equal(item.port, 'tool-shell')
    assert.equal(item.method, 'invoke')
    assert.deepEqual(item.args_ref, { sha256: H1 })
    assert.equal(item.tier, 'severe')
    assert.equal(item.workspace_id, 'w1')
    assert.equal(item.run, 'r1')
    assert.equal(item.thread, 't1')
    assert.equal(item.at, AT)
    assert.equal(item.status, 'pending')
    assert.equal(item.decided_at, null)
    assert.equal(item.by, null)
    assert.deepEqual(item.resume, {
      command: 'chat.resume',
      args: { cursor: { iter: 2 }, thread: 't1' },
    })
    assert.equal(item.shadow, null)
    assert.equal(item.prev, null)
    assert.deepEqual(ops[1].args.body, { version: 1, tail: { def: { $n: 0 } }, count: 1 })
    assert.deepEqual(ops[2].args, { id: 'approval', payload: { $n: 1 }, sig: { $n: 1 }, pins: {} })
    const payload = externOf(plan)
    assert.equal(payload.ok, true)
    assert.equal(payload.id, 'ap-r1-0')
    assert.equal(payload.count, 1)
    const emitted = drv.events.slice(before)
    assert.deepEqual(emitted.map((e) => e.topic), ['approval.pending'])
    assert.equal(emitted[0].payload.kind, 'tool_call')
    assert.equal(emitted[0].payload.id, 'ap-r1-0')
    assert.equal(emitted[0].payload.thread, 't1')
    assert.equal(emitted[0].payload.at, AT)
  } finally {
    drv.close()
  }
})

test('enqueue：后续入队链到当前 tail，count 递增、id 取入队序', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs, hashes } = chainOf([pendingItem()])
    const plan = await drv.call('enqueue', {
      queue: { ...queue, count: 1 },
      refs,
      kind: 'tool_call',
      port: 'tool-fs',
      run: 'r2',
      thread: 't1',
      at: AT,
    })
    const ops = opsOf(plan)
    assert.equal(ops[0].args.body.id, 'ap-r2-1')
    assert.deepEqual(ops[0].args.body.prev, { def: hashes[0] })
    assert.equal(ops[1].args.body.count, 2)
  } finally {
    drv.close()
  }
})

test('enqueue：队列满 → 结构化拒，无写（不静默丢）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs } = chainOf([pendingItem()])
    const plan = await drv.call('enqueue', {
      queue,
      refs,
      kind: 'tool_call',
      capacity: 1,
      run: 'r2',
      thread: 't1',
    })
    assert.equal(directivesOf(plan).length, 1)
    assert.equal(directivesOf(plan)[0].kind, 'extern')
    const payload = externOf(plan)
    assert.equal(payload.ok, false)
    assert.equal(payload.reason, 'queue_full')
    assert.equal(payload.capacity, 1)
  } finally {
    drv.close()
  }
})

// ── list ───────────────────────────────────────────────────────────────────

test('list：只读回队列（含 pending/expired），不产写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs } = chainOf([
      pendingItem({ id: 'ap-r1-0' }),
      pendingItem({ id: 'ap-r1-1', status: 'expired', at: AT }),
      pendingItem({ id: 'ap-r1-2', status: 'approved', decided_at: AT_LATE, by: 'user' }),
    ])
    const plan = await drv.call('list', { queue, refs })
    assert.equal(directivesOf(plan).length, 1)
    assert.equal(directivesOf(plan)[0].kind, 'extern')
    const payload = externOf(plan)
    assert.equal(payload.ok, true)
    assert.equal(payload.pending, 1)
    assert.equal(payload.expired, 1)
    assert.equal(payload.decided, 1)
    assert.deepEqual(payload.items.map((item) => item.id), ['ap-r1-0', 'ap-r1-1', 'ap-r1-2'])
  } finally {
    drv.close()
  }
})

// ── decide / decide_all ────────────────────────────────────────────────────

test('decide accept：状态迁移 approved + per-thread 清槽 + decided 事件，不产 chat.resume', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs, hashes } = chainOf([pendingItem()])
    const before = drv.events.length
    const plan = await drv.call('decide', {
      queue,
      refs,
      slots: {
        slots: {
          t1: { kind: 'approval.decide', id: 'ap-r1-0', verdict: 'accept' },
          t2: { kind: 'chat.message', text: 'other' },
        },
      },
      thread_id: 't1',
      id: 'ap-r1-0',
      verdict: 'accept',
      at: AT_LATE,
    })
    const ops = opsOf(plan)
    assert.equal(ops.length, 5)
    const updated = ops[0].args.body
    assert.equal(updated.id, 'ap-r1-0')
    assert.equal(updated.status, 'approved')
    assert.equal(updated.decided_at, AT_LATE)
    assert.equal(updated.by, 'user')
    assert.deepEqual(updated.prev, { def: hashes[0] })
    assert.deepEqual(ops[1].args.body, { version: 1, tail: { def: { $n: 0 } }, count: 1 })
    assert.deepEqual(ops[2].args, { id: 'approval', payload: { $n: 1 }, sig: { $n: 1 }, pins: {} })
    assert.deepEqual(ops[3].args.body.slots, {
      t1: { kind: 'idle' },
      t2: { kind: 'chat.message', text: 'other' },
    })
    assert.deepEqual(ops[4].args, { id: 'input', payload: { $n: 3 }, sig: { $n: 3 }, pins: {} })
    assert.equal(externOf(plan).status, 'approved')
    assert.equal(directivesOf(plan).some((item) => item.kind === 'eval'), false)
    const emitted = drv.events.slice(before)
    assert.deepEqual(emitted.map((e) => e.topic), ['approval.decided'])
    assert.equal(emitted[0].payload.status, 'approved')
    assert.equal(emitted[0].payload.verdict, 'accept')
    assert.equal(emitted[0].payload.kind, 'tool_call')
    assert.equal(emitted[0].payload.thread, 't1')
  } finally {
    drv.close()
  }
})

test('decide deny：状态迁移 denied；映射写死 accept/deny → approved/denied', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs } = chainOf([pendingItem()])
    const plan = await drv.call('decide', {
      queue,
      refs,
      slots: { slots: { t1: { kind: 'approval.decide', id: 'ap-r1-0', verdict: 'deny' } } },
      thread_id: 't1',
      id: 'ap-r1-0',
      verdict: 'deny',
      at: AT_LATE,
    })
    assert.equal(opsOf(plan)[0].args.body.status, 'denied')
    assert.equal(externOf(plan).status, 'denied')
  } finally {
    drv.close()
  }
})

test('decide：目标不存在 / 缺 id / 坏 verdict → 清槽 + 结构化拒，无部分写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs } = chainOf([pendingItem()])
    const slots = { slots: { t1: { kind: 'approval.decide', id: 'ap-r1-0', verdict: 'accept' } } }

    const missing = await drv.call('decide', {
      queue,
      refs,
      slots,
      thread_id: 't1',
      id: 'nope',
      verdict: 'accept',
      at: AT_LATE,
    })
    const missingOps = opsOf(missing)
    assert.equal(missingOps.length, 2)
    assert.deepEqual(missingOps[0].args.body.slots, { t1: { kind: 'idle' } })
    assert.deepEqual(missingOps[1].args, { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} })
    assert.equal(externOf(missing).ok, false)
    assert.equal(externOf(missing).reason, 'not_found')

    const badVerdict = await drv.call('decide', {
      queue,
      refs,
      slots,
      thread_id: 't1',
      id: 'ap-r1-0',
      verdict: 'maybe',
      at: AT_LATE,
    })
    assert.equal(externOf(badVerdict).reason, 'bad_verdict')

    const noSlots = await drv.call('decide', { queue, refs, id: 'nope', verdict: 'accept', at: AT_LATE })
    assert.equal(directivesOf(noSlots).length, 1)
    assert.equal(directivesOf(noSlots)[0].kind, 'extern')
    assert.equal(externOf(noSlots).reason, 'not_found')
  } finally {
    drv.close()
  }
})

test('decide_all：对当前 pending 批量同 verdict，逐项 decided 事件 + 清槽', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs, hashes } = chainOf([
      pendingItem({ id: 'ap-r1-0', thread: 't1' }),
      pendingItem({ id: 'ap-r1-1', thread: 't2' }),
      pendingItem({ id: 'ap-r1-2', status: 'approved', decided_at: AT_LATE, by: 'user' }),
    ])
    const before = drv.events.length
    const plan = await drv.call('decide_all', {
      queue,
      refs,
      slots: { slots: { _main: { kind: 'approval.decide', verdict: 'deny' } } },
      thread_id: '_main',
      verdict: 'deny',
      at: AT_LATE,
    })
    const ops = opsOf(plan)
    assert.equal(ops.length, 6)
    assert.equal(ops[0].args.body.id, 'ap-r1-0')
    assert.equal(ops[0].args.body.status, 'denied')
    assert.deepEqual(ops[0].args.body.prev, { def: hashes[2] })
    assert.equal(ops[1].args.body.id, 'ap-r1-1')
    assert.equal(ops[1].args.body.status, 'denied')
    assert.deepEqual(ops[1].args.body.prev, { def: { $n: 0 } })
    assert.deepEqual(ops[2].args.body.tail, { def: { $n: 1 } })
    assert.deepEqual(ops[3].args, { id: 'approval', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} })
    assert.deepEqual(ops[4].args.body.slots, { _main: { kind: 'idle' } })
    assert.deepEqual(ops[5].args, { id: 'input', payload: { $n: 4 }, sig: { $n: 4 }, pins: {} })
    assert.deepEqual(externOf(plan).ids, ['ap-r1-0', 'ap-r1-1'])
    const emitted = drv.events.slice(before)
    assert.deepEqual(emitted.map((e) => e.topic), ['approval.decided', 'approval.decided'])
    assert.deepEqual(emitted.map((e) => e.payload.id), ['ap-r1-0', 'ap-r1-1'])
  } finally {
    drv.close()
  }
})

test('decide_all：无 pending → 清槽 + 结构化拒', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs } = chainOf([
      pendingItem({ id: 'ap-r1-0', status: 'approved', decided_at: AT_LATE, by: 'user' }),
    ])
    const plan = await drv.call('decide_all', {
      queue,
      refs,
      slots: { slots: { _main: { kind: 'approval.decide', verdict: 'deny' } } },
      thread_id: '_main',
      verdict: 'deny',
    })
    assert.equal(externOf(plan).ok, false)
    assert.equal(externOf(plan).reason, 'no_pending')
  } finally {
    drv.close()
  }
})

// ── sweep ──────────────────────────────────────────────────────────────────

test('sweep：超时只标 expired、不自动裁决、不发终局事件', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs } = chainOf([pendingItem()])
    const before = drv.events.length
    const plan = await drv.call('sweep', { queue, refs }, {
      run: null,
      thread: null,
      now: Date.parse(AT) + 11 * 60 * 1000,
    })
    const ops = opsOf(plan)
    assert.equal(ops.length, 3)
    const expired = ops[0].args.body
    assert.equal(expired.status, 'expired')
    assert.equal(expired.decided_at, null)
    assert.equal(expired.by, null)
    assert.deepEqual(ops[1].args.body, { version: 1, tail: { def: { $n: 0 } }, count: 1 })
    assert.deepEqual(ops[2].args, { id: 'approval', payload: { $n: 1 }, sig: { $n: 1 }, pins: {} })
    const payload = externOf(plan)
    assert.equal(payload.expired, 1)
    assert.equal(payload.archived, 0)
    assert.equal(drv.events.length, before)
  } finally {
    drv.close()
  }
})

test('sweep：未超时 / 无归档 → 无写（只回结果）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs } = chainOf([pendingItem()])
    const plan = await drv.call('sweep', { queue, refs }, {
      run: null,
      thread: null,
      now: Date.parse(AT) + 1000,
    })
    assert.equal(directivesOf(plan).length, 1)
    assert.equal(directivesOf(plan)[0].kind, 'extern')
    assert.equal(externOf(plan).changed, false)
  } finally {
    drv.close()
  }
})

test('sweep：终局/过期项按容量归档（写新索引），不删 pending', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { queue, refs } = chainOf([
      pendingItem({ id: 'ap-r1-0', status: 'approved', decided_at: AT_LATE, by: 'user' }),
      pendingItem({ id: 'ap-r1-1', status: 'approved', decided_at: AT_LATE, by: 'user' }),
      pendingItem({ id: 'ap-r1-2' }),
    ])
    const plan = await drv.call('sweep', { queue, refs, archive_keep: 1 }, {
      run: null,
      thread: null,
      now: Date.parse(AT) + 1000,
    })
    const ops = opsOf(plan)
    assert.equal(ops.length, 4)
    const kept = ops.slice(0, 2).map((op) => op.args.body)
    assert.deepEqual(kept.map((item) => item.id), ['ap-r1-1', 'ap-r1-2'])
    assert.equal(kept[0].prev, null)
    assert.deepEqual(kept[1].prev, { def: { $n: 0 } })
    assert.deepEqual(ops[2].args.body, { version: 1, tail: { def: { $n: 1 } }, count: 3 })
    assert.deepEqual(ops[3].args, { id: 'approval', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} })
    const payload = externOf(plan)
    assert.equal(payload.archived, 1)
    assert.equal(payload.retained, 2)
    // pending 未被归档、未被裁决
    assert.equal(kept[1].status, 'pending')
  } finally {
    drv.close()
  }
})

// ── 三种 kind ──────────────────────────────────────────────────────────────

test('三种 kind：port 默认与 shadow 只挂 orchestration_change', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const orchestration = await drv.call('enqueue', {
      queue: emptyQueue(),
      refs: {},
      kind: 'orchestration_change',
      shadow: { def: H2 },
      run: 'r1',
      thread: 't1',
      at: AT,
    })
    const orchestrationItem = opsOf(orchestration)[0].args.body
    assert.equal(orchestrationItem.port, 'orchestration-admin')
    assert.deepEqual(orchestrationItem.shadow, { def: H2 })

    const pluginWrite = await drv.call('enqueue', {
      queue: emptyQueue(),
      refs: {},
      kind: 'plugin_write',
      args_ref: { summary: 'tool-fs 3 files' },
      run: 'r2',
      thread: 't1',
      at: AT,
    })
    const pluginItem = opsOf(pluginWrite)[0].args.body
    assert.equal(pluginItem.port, 'plugin-admin')
    assert.equal(pluginItem.shadow, null)
    assert.deepEqual(pluginItem.args_ref, { summary: 'tool-fs 3 files' })

    const toolCall = await drv.call('enqueue', {
      queue: emptyQueue(),
      refs: {},
      kind: 'tool_call',
      port: 'tool-fs',
      run: 'r3',
      thread: 't1',
      at: AT,
    })
    assert.equal(opsOf(toolCall)[0].args.body.port, 'tool-fs')
  } finally {
    drv.close()
  }
})

test('enqueue：明文 args 不被内联（只留摘要 / 资产引用）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const plan = await drv.call('enqueue', {
      queue: emptyQueue(),
      refs: {},
      kind: 'tool_call',
      port: 'tool-shell',
      args: { command: 'rm -rf /', secret: 'sk-live' },
      args_ref: { summary: 'rm -rf /' },
      run: 'r1',
      thread: 't1',
      at: AT,
    })
    const item = opsOf(plan)[0].args.body
    assert.equal('args' in item, false)
    assert.equal(JSON.stringify(item).includes('sk-live'), false)
    assert.deepEqual(item.args_ref, { summary: 'rm -rf /' })
  } finally {
    drv.close()
  }
})

// ── 结构化错误 ─────────────────────────────────────────────────────────────

test('非对象 / 缺字段 args → bad_args，不崩进程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const nullArgs = await drv.callRaw('enqueue', null)
    assert.equal(nullArgs.kind, 'error')
    assert.equal(nullArgs.code, 'bad_args')

    const missingKind = await drv.callRaw('enqueue', { queue: emptyQueue(), refs: {} })
    assert.equal(missingKind.kind, 'error')
    assert.equal(missingKind.code, 'bad_args')

    const unknown = await drv.callRaw('nope', {})
    assert.equal(unknown.kind, 'error')
    assert.equal(unknown.code, 'unknown_method')

    // 进程仍可服务：后续正常调用成功
    const plan = await drv.call('list', { queue: emptyQueue(), refs: {} })
    assert.equal(externOf(plan).ok, true)
  } finally {
    drv.close()
  }
})
