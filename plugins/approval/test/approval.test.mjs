// `approval` 服务协议级测试（node --test）：自实现最小协议驱动。
// 驱动 spawn `node execute/main.ts`（注入临时 ④/③ 目录），发 hello → 收 manifest，发 call → 收 result / error，
// 收 event 帧，覆盖 reload / drain / probe 与 stdin EOF 自退出。
// 断言只针对「返回值 / 事件」——队列写自有存储，服务不产世界写 directive（无 write / add_gen）。

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
const AT_LATE = '2023-11-14T22:25:00.000Z'
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

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

function startService(rootOverride) {
  const root = rootOverride ?? mkdtempSync(join(tmpdir(), 'approval-svc-'))
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_PLUGIN_DATA: join(root, 'data'),
      CHRONO_PLUGIN_STATE: join(root, 'state'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
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
    root,
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
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function directivesOf(value) {
  return Array.isArray(value?.$directives) ? value.$directives : []
}

function externOf(value) {
  const extern = directivesOf(value).find((item) => item.kind === 'extern')
  assert.ok(extern, 'expected an extern directive')
  return extern.payload
}

/** 世界不新增世代的机械证据：返回值里不得出现任何 write / add_gen。 */
function assertNoWorldWrite(value) {
  for (const directive of directivesOf(value)) {
    assert.notEqual(directive.kind, 'write', `不应产世界写：${JSON.stringify(directive)}`)
    assert.equal(JSON.stringify(directive).includes('add_gen'), false, '不应出现 add_gen')
  }
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('hello 回 manifest，声明与 plugin.json 一致（durable）', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'approval')
    assert.deepEqual(manifest.implements, ['approval'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'durable')
    assert.deepEqual(manifest.methods.approval, ['enqueue', 'list', 'decide', 'decide_all', 'sweep'])
  } finally {
    drv.close()
    drv.cleanup()
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
    drv.cleanup()
  }
})

test('stdin EOF 即自退出（断连不占端点）', async () => {
  const drv = startService()
  await drv.hello()
  drv.close()
  const code = await drv.exit
  assert.equal(code, 0)
  drv.cleanup()
})

// ── enqueue ────────────────────────────────────────────────────────────────

test('enqueue：item 写自有存储 + resume 游标 + 乐观 pending 事件，无世界写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const value = await drv.call('enqueue', {
      kind: 'tool_call',
      port: 'tool-shell',
      method: 'invoke',
      args_ref: { sha256: H1 },
      tier: 'severe',
      workspace_id: 'w1',
      run: 'r1',
      thread: 't1',
      cursor: { node_index: 3 },
      at: AT,
    })
    assertNoWorldWrite(value)
    const payload = externOf(value)
    assert.equal(payload.ok, true)
    assert.equal(payload.id, 'ap-r1-0')
    assert.equal(payload.count, 1)
    assert.equal(payload.pending, 1)

    const listed = await drv.call('list', {})
    const item = externOf(listed).items[0]
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
      args: { cursor: { node_index: 3 }, thread: 't1' },
    })
    assert.equal(item.shadow, null)

    const emitted = drv.events.slice(before)
    assert.deepEqual(emitted.map((e) => e.topic), ['approval.pending'])
    assert.equal(emitted[0].payload.kind, 'tool_call')
    assert.equal(emitted[0].payload.id, 'ap-r1-0')
    assert.equal(emitted[0].payload.thread, 't1')
    assert.equal(emitted[0].payload.at, AT)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('enqueue：同回合同节点重复入队幂等收敛（不重复计数、不重复事件）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const args = {
      kind: 'tool_call',
      port: 'tool-shell',
      run: 'r1',
      thread: 't1',
      cursor: { node_index: 3 },
      at: AT,
    }
    const first = await drv.call('enqueue', args)
    const before = drv.events.length
    const second = await drv.call('enqueue', args)
    assert.equal(externOf(second).id, externOf(first).id, '重复入队收敛到同一条')
    assert.equal(externOf(second).count, 1)
    assert.equal(drv.events.length, before, '幂等重放不重复发事件')
    assert.equal(externOf(await drv.call('list', {})).count, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('enqueue：队列满 → 结构化拒，无写（不静默丢）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', at: AT, cursor: { node_index: 1 } })
    const value = await drv.call('enqueue', {
      kind: 'tool_call',
      capacity: 1,
      run: 'r2',
      thread: 't1',
      at: AT,
      cursor: { node_index: 1 },
    })
    assert.equal(directivesOf(value).length, 1)
    assert.equal(directivesOf(value)[0].kind, 'extern')
    const payload = externOf(value)
    assert.equal(payload.ok, false)
    assert.equal(payload.reason, 'queue_full')
    assert.equal(payload.capacity, 1)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── list ───────────────────────────────────────────────────────────────────

test('list：只读回队列（含 pending/expired/decided），不产写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', at: AT, cursor: { node_index: 0 } })
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', at: AT, cursor: { node_index: 1 } })
    await drv.call('decide', { id: 'ap-r1-0', verdict: 'accept', at: AT_LATE })
    const value = await drv.call('list', {})
    assert.equal(directivesOf(value).length, 1)
    assert.equal(directivesOf(value)[0].kind, 'extern')
    const payload = externOf(value)
    assert.equal(payload.ok, true)
    assert.equal(payload.pending, 1)
    assert.equal(payload.decided, 1)
    assert.deepEqual(payload.items.map((item) => item.id), ['ap-r1-0', 'ap-r1-1'])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── decide / decide_all ────────────────────────────────────────────────────

test('decide accept：状态迁移 approved + decided 事件 + 回执带 resume，不产世界写 / chat.resume', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', {
      kind: 'tool_call',
      run: 'r1',
      thread: 't1',
      cursor: { node_index: 3 },
      at: AT,
    })
    const before = drv.events.length
    const value = await drv.call('decide', { id: 'ap-r1-0', verdict: 'accept', thread_id: 't1', at: AT_LATE })
    assertNoWorldWrite(value)
    const payload = externOf(value)
    assert.equal(payload.ok, true)
    assert.equal(payload.id, 'ap-r1-0')
    assert.equal(payload.status, 'approved')
    assert.equal(payload.verdict, 'accept')
    assert.equal(payload.thread, 't1')
    assert.deepEqual(payload.resume, {
      command: 'chat.resume',
      args: { cursor: { node_index: 3 }, thread: 't1' },
    })
    assert.equal(directivesOf(value).some((item) => item.kind === 'eval'), false)

    const item = externOf(await drv.call('list', {})).items[0]
    assert.equal(item.status, 'approved')
    assert.equal(item.decided_at, AT_LATE)
    assert.equal(item.by, 'user')

    const emitted = drv.events.slice(before)
    assert.deepEqual(emitted.map((e) => e.topic), ['approval.decided'])
    assert.equal(emitted[0].payload.status, 'approved')
    assert.equal(emitted[0].payload.verdict, 'accept')
    assert.equal(emitted[0].payload.kind, 'tool_call')
    assert.equal(emitted[0].payload.thread, 't1')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('decide deny：状态迁移 denied；映射写死 accept/deny → approved/denied', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', cursor: { node_index: 3 }, at: AT })
    const value = await drv.call('decide', { id: 'ap-r1-0', verdict: 'deny', at: AT_LATE })
    assert.equal(externOf(value).status, 'denied')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('decide：目标不存在 / 缺 id / 坏 verdict → 结构化拒，无部分写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', cursor: { node_index: 3 }, at: AT })

    const missing = externOf(await drv.call('decide', { id: 'nope', verdict: 'accept', at: AT_LATE }))
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'not_found')

    const badVerdict = externOf(await drv.call('decide', { id: 'ap-r1-0', verdict: 'maybe', at: AT_LATE }))
    assert.equal(badVerdict.reason, 'bad_verdict')

    const missingId = externOf(await drv.call('decide', { verdict: 'accept', at: AT_LATE }))
    assert.equal(missingId.reason, 'missing_id')

    // 未裁决项仍是 pending。
    assert.equal(externOf(await drv.call('list', {})).items[0].status, 'pending')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('decide_all：对当前 pending 批量同 verdict，逐项 decided 事件 + 回执带 resumes', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', cursor: { node_index: 0 }, at: AT })
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't2', cursor: { node_index: 1 }, at: AT })
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't3', cursor: { node_index: 2 }, at: AT })
    await drv.call('decide', { id: 'ap-r1-0', verdict: 'accept', at: AT_LATE })

    const before = drv.events.length
    const value = await drv.call('decide_all', { verdict: 'deny', thread_id: '_main', at: AT_LATE })
    assertNoWorldWrite(value)
    const payload = externOf(value)
    assert.deepEqual(payload.ids, ['ap-r1-1', 'ap-r1-2'])
    assert.equal(payload.status, 'denied')
    assert.equal(payload.resumes.length, 2)
    assert.deepEqual(payload.resumes.map((entry) => entry.thread), ['t2', 't3'])

    const emitted = drv.events.slice(before)
    assert.deepEqual(emitted.map((e) => e.topic), ['approval.decided', 'approval.decided'])
    assert.deepEqual(emitted.map((e) => e.payload.id), ['ap-r1-1', 'ap-r1-2'])
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('decide_all：无 pending → 结构化拒', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('decide_all', { verdict: 'deny', thread_id: '_main' })
    assert.equal(externOf(value).ok, false)
    assert.equal(externOf(value).reason, 'no_pending')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── sweep ──────────────────────────────────────────────────────────────────

test('sweep：超时只标 expired、不自动裁决、不发终局事件', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', cursor: { node_index: 3 }, at: AT })
    const before = drv.events.length
    const value = await drv.call('sweep', {}, { run: null, thread: null, now: Date.parse(AT) + 11 * 60 * 1000 })
    const payload = externOf(value)
    assert.equal(payload.expired, 1)
    assert.equal(payload.archived, 0)
    const item = externOf(await drv.call('list', {})).items[0]
    assert.equal(item.status, 'expired')
    assert.equal(item.decided_at, null)
    assert.equal(item.by, null)
    assert.equal(drv.events.length, before)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('sweep：未超时 / 无归档 → 无写（只回结果）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', cursor: { node_index: 3 }, at: AT })
    const value = await drv.call('sweep', {}, { run: null, thread: null, now: Date.parse(AT) + 1000 })
    assert.equal(directivesOf(value).length, 1)
    assert.equal(externOf(value).changed, false)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('sweep：终局/过期项按容量归档，不删 pending', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't1', cursor: { node_index: 0 }, at: AT })
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't2', cursor: { node_index: 1 }, at: AT })
    await drv.call('enqueue', { kind: 'tool_call', run: 'r1', thread: 't3', cursor: { node_index: 2 }, at: AT })
    await drv.call('decide', { id: 'ap-r1-0', verdict: 'accept', at: AT_LATE })
    await drv.call('decide', { id: 'ap-r1-1', verdict: 'accept', at: AT_LATE })

    const value = await drv.call('sweep', { archive_keep: 1 }, { run: null, thread: null, now: Date.parse(AT) + 1000 })
    const payload = externOf(value)
    assert.equal(payload.archived, 1)
    assert.equal(payload.retained, 2)
    const items = externOf(await drv.call('list', {})).items
    assert.deepEqual(items.map((item) => item.id), ['ap-r1-1', 'ap-r1-2'])
    assert.equal(items[1].status, 'pending', 'pending 未被归档')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── 三种 kind ──────────────────────────────────────────────────────────────

test('三种 kind：port 默认与 shadow 只挂 orchestration_change', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', {
      kind: 'orchestration_change',
      shadow: { def: H2 },
      run: 'r1',
      thread: 't1',
      cursor: { node_index: 0 },
      at: AT,
    })
    await drv.call('enqueue', {
      kind: 'plugin_write',
      args_ref: { summary: 'tool-fs 3 files' },
      run: 'r1',
      thread: 't1',
      cursor: { node_index: 1 },
      at: AT,
    })
    await drv.call('enqueue', { kind: 'tool_call', port: 'tool-fs', run: 'r1', thread: 't1', cursor: { node_index: 2 }, at: AT })

    const items = externOf(await drv.call('list', {})).items
    assert.equal(items[0].port, 'orchestration-admin')
    assert.deepEqual(items[0].shadow, { def: H2 })
    assert.equal(items[1].port, 'plugin-admin')
    assert.equal(items[1].shadow, null)
    assert.deepEqual(items[1].args_ref, { summary: 'tool-fs 3 files' })
    assert.equal(items[2].port, 'tool-fs')
  } finally {
    drv.close()
    drv.cleanup()
  }
})

test('enqueue：明文 args 不被内联（只留摘要 / 资产引用）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('enqueue', {
      kind: 'tool_call',
      port: 'tool-shell',
      args: { command: 'rm -rf /', secret: 'sk-live' },
      args_ref: { summary: 'rm -rf /' },
      run: 'r1',
      thread: 't1',
      cursor: { node_index: 0 },
      at: AT,
    })
    const item = externOf(await drv.call('list', {})).items[0]
    assert.equal('args' in item, false)
    assert.equal(JSON.stringify(item).includes('sk-live'), false)
    assert.deepEqual(item.args_ref, { summary: 'rm -rf /' })
  } finally {
    drv.close()
    drv.cleanup()
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

    const missingKind = await drv.callRaw('enqueue', {})
    assert.equal(missingKind.kind, 'error')
    assert.equal(missingKind.code, 'bad_args')

    const unknown = await drv.callRaw('nope', {})
    assert.equal(unknown.kind, 'error')
    assert.equal(unknown.code, 'unknown_method')

    // 进程仍可服务：后续正常调用成功
    const value = await drv.call('list', {})
    assert.equal(externOf(value).ok, true)
  } finally {
    drv.close()
    drv.cleanup()
  }
})

// ── 跨宿主重启续跑（持久化游标） ────────────────────────────────────────────

test('跨重启续跑：重启后从持久化游标仍可裁决续跑（与挂起收口一致）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'approval-restart-'))
  const first = startService(root)
  try {
    await first.hello()
    await first.call('enqueue', {
      kind: 'tool_call',
      port: 'tool-shell',
      run: 'r1',
      thread: 't1',
      cursor: { node_index: 3 },
      at: AT,
    })
    first.close()
    await first.exit
  } finally {
    // 首个进程已退出；root 留给第二个进程重放。
  }

  const second = startService(root)
  try {
    await second.hello()
    const item = externOf(await second.call('list', {})).items[0]
    assert.equal(item.id, 'ap-r1-0', '重启后重放仍见原队列项')
    assert.deepEqual(item.resume, {
      command: 'chat.resume',
      args: { cursor: { node_index: 3 }, thread: 't1' },
    }, '持久化游标跨重启可取回')

    const decided = await second.call('decide', { id: 'ap-r1-0', verdict: 'accept', thread_id: 't1', at: AT_LATE })
    const payload = externOf(decided)
    assert.equal(payload.status, 'approved')
    assert.deepEqual(payload.resume.args.cursor, { node_index: 3 }, '重启后仍可据游标裁决续跑')
  } finally {
    second.close()
    second.cleanup()
  }
})
