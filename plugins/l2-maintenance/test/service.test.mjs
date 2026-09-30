// `l2-maintenance` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假 owner / 假后端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const NOW = Date.parse('2023-11-14T00:00:00.000Z')
const AT = new Date(NOW).toISOString()
const FIXED_ENV = { run: 'run-1', thread: 't1', now: NOW }
const DIM = 8

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (const ch of text) {
    hash ^= ch.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function vec(weights, dim = 4) {
  const vector = new Array(dim).fill(0)
  for (const [index, weight] of Object.entries(weights)) vector[Number(index)] = weight
  return vector
}

function vectorFor(text, vectors) {
  if (vectors && Object.hasOwn(vectors, text)) return vectors[text]
  const vector = new Array(DIM).fill(0)
  vector[fnv1a(text) % DIM] = 1
  return vector
}

function shortMemoryFixture() {
  return {
    version: 1,
    sessions: {
      'c-1': {
        summary: { goal: 'G1', decisions: [], facts: ['f1', 'f2'], open_questions: [], files: [] },
        covered_upto: 'm1',
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
      },
      'c-2': {
        summary: { goal: 'G2', decisions: [], facts: ['f2', 'f3'], open_questions: [], files: [] },
        covered_upto: 'm2',
        at: '2020-01-02T00:00:00.000Z',
        expires_at: '2020-01-03T00:00:00.000Z',
      },
    },
    workspaces: {
      'w-1': {
        summary: { goal: 'WG', decisions: [], facts: ['old'], open_questions: [], files: [] },
        sources: ['c-0'],
        at: '2020-01-01T00:00:00.000Z',
      },
    },
  }
}

function sessionFixture() {
  return {
    current: 'c-1',
    conversations: [
      { id: 'c-1', workspace_id: 'w-1' },
      { id: 'c-2', workspace_id: 'w-1' },
    ],
  }
}

function fakeShortMemory(initial) {
  const memory = structuredClone(initial)
  return {
    memory,
    read: () => structuredClone(memory),
    apply: (args) => {
      for (const [id, record] of Object.entries(args?.set_sessions ?? {}))
        memory.sessions[id] = record
      for (const id of args?.del_sessions ?? []) delete memory.sessions[id]
      for (const [id, record] of Object.entries(args?.set_workspaces ?? {}))
        memory.workspaces[id] = record
      for (const id of args?.del_workspaces ?? []) delete memory.workspaces[id]
      return { ok: true, changed: 1 }
    },
  }
}

function drive(options = {}) {
  const shortMemory = options.shortMemory ?? fakeShortMemory(options.memory ?? shortMemoryFixture())
  const session = options.session ?? sessionFixture()
  const vectors = options.vectors ?? undefined
  const drv = startService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    onPortCall: (message) => {
      if (options.bridge) {
        const outcome = options.bridge(message)
        if (outcome !== undefined) return outcome
      }
      if (message.port === 'short-memory' && message.method === 'read')
        return { ok: true, value: shortMemory.read() }
      if (message.port === 'short-memory' && message.method === 'apply')
        return { ok: true, value: shortMemory.apply(message.args ?? {}) }
      if (message.port === 'session' && message.method === 'read')
        return { ok: true, value: structuredClone(session) }
      if (message.port === 'embedding' && message.method === 'embed') {
        const texts = Array.isArray(message.args?.texts) ? message.args.texts : []
        return {
          ok: true,
          value: {
            model: 'granite-97m',
            dim: DIM,
            vectors: texts.map((text) => vectorFor(text, vectors)),
          },
        }
      }
      if (message.port === 'compress' && message.method === 'summarize') {
        return {
          ok: true,
          value: {
            ok: true,
            kind: 'summarize',
            summary: options.summary ?? { goal: 'merged-goal', facts: [] },
          },
        }
      }
      return { ok: false, code: 'not_ready', message: 'no resolver' }
    },
  })
  return {
    ...drv,
    shortMemory,
    hello: () => drv.hello('l2-maintenance'),
    call: (method, args, env = FIXED_ENV) => drv.call('l2-maintenance', method, args, env),
  }
}

const MERGE_VECTORS = {
  f1: vec({ 0: 1 }),
  f2: vec({ 1: 1 }),
  f3: vec({ 2: 1 }),
  old: vec({ 3: 1 }),
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'l2-maintenance')
    assert.deepEqual(manifest.implements, ['l2-maintenance'])
    assert.deepEqual(manifest.methods['l2-maintenance'], ['merge', 'trim', 'view', 'edit'])
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('merge：L1 合并进 L2、sources 最新在前、向量去重；写 owner 服务', async () => {
  const drv = drive({ vectors: MERGE_VECTORS })
  try {
    await drv.hello()
    const result = await drv.call('merge', {})
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, true)
    assert.deepEqual(result.value.workspaces, ['w-1'])
    const memory = drv.shortMemory.memory
    assert.deepEqual(memory.workspaces['w-1'].sources, ['c-2', 'c-1', 'c-0'])
    assert.deepEqual(memory.workspaces['w-1'].summary.facts, ['old', 'f1', 'f3', 'f2'])
    assert.equal(memory.workspaces['w-1'].at, AT)
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'embed'))
    assert.ok(drv.portCalls.some((call) => call.port === 'short-memory' && call.method === 'apply'))
  } finally {
    drv.close()
  }
})

test('merge：向量模型随调用方传入；缺省不带 model，交由 embedding 门面按提供方元数据解析', async () => {
  const embeddingCalls = (drv) =>
    drv.portCalls.filter((call) => call.port === 'embedding' && call.method === 'embed')

  const omitted = drive({ vectors: MERGE_VECTORS })
  try {
    await omitted.hello()
    await omitted.call('merge', {})
    const calls = embeddingCalls(omitted)
    assert.ok(calls.length > 0)
    assert.equal(Object.hasOwn(calls[0].args ?? {}, 'model'), false)
  } finally {
    omitted.close()
  }

  const explicit = drive({ vectors: MERGE_VECTORS })
  try {
    await explicit.hello()
    await explicit.call('merge', { embedding_model: 'custom-model' })
    const calls = embeddingCalls(explicit)
    assert.ok(calls.length > 0)
    assert.equal(calls[0].args.model, 'custom-model')
  } finally {
    explicit.close()
  }
})

test('merge：空会话集 no_input，不调后端、不写', async () => {
  const drv = drive({ memory: { version: 1, sessions: {}, workspaces: {} } })
  try {
    await drv.hello()
    const result = await drv.call('merge', {})
    assert.equal(result.value.no_input, true)
    assert.equal(
      drv.portCalls.some((call) => call.port === 'embedding'),
      false,
    )
  } finally {
    drv.close()
  }
})

test('merge：需要摘要时调 compress.summarize（persist:false，goal 来自摘要）', async () => {
  const drv = drive({ vectors: MERGE_VECTORS, summary: { goal: 'MERGED', facts: ['sf1'] } })
  try {
    await drv.hello()
    const result = await drv.call('merge', { summarize: true })
    assert.equal(result.value.summary_used, true)
    assert.equal(drv.shortMemory.memory.workspaces['w-1'].summary.goal, 'MERGED')
    assert.deepEqual(drv.shortMemory.memory.workspaces['w-1'].summary.facts, ['sf1'])
    const call = drv.portCalls.find(
      (item) => item.port === 'compress' && item.method === 'summarize',
    )
    assert.ok(call !== undefined)
    assert.equal(call.args.persist, false)
    assert.equal(call.args.mode, 'algorithmic')
  } finally {
    drv.close()
  }
})

test('merge：compress 不可用 → 明确失败、不半写', async () => {
  const drv = drive({
    vectors: MERGE_VECTORS,
    bridge: (message) =>
      message.port === 'compress'
        ? { ok: false, code: 'model_unavailable', message: 'no model' }
        : undefined,
  })
  try {
    await drv.hello()
    const before = JSON.stringify(drv.shortMemory.memory)
    const result = await drv.call('merge', { summarize: true })
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'model_unavailable')
    assert.equal(JSON.stringify(drv.shortMemory.memory), before)
  } finally {
    drv.close()
  }
})

test('merge：embedding 不可用 → 明确失败、不半写', async () => {
  const drv = drive({
    bridge: (message) =>
      message.port === 'embedding'
        ? { ok: false, code: 'embedding_unavailable', message: 'no embedding' }
        : undefined,
  })
  try {
    await drv.hello()
    const before = JSON.stringify(drv.shortMemory.memory)
    const result = await drv.call('merge', {})
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'embedding_unavailable')
    assert.equal(JSON.stringify(drv.shortMemory.memory), before)
  } finally {
    drv.close()
  }
})

test('trim：超容量从最旧一端裁；dry_run 只算不写', async () => {
  const memory = {
    version: 1,
    sessions: {},
    workspaces: {
      'w-1': {
        summary: { goal: '', facts: ['a', 'b', 'c'], decisions: [], open_questions: [], files: [] },
        sources: [],
        at: AT,
      },
    },
  }
  const drv = drive({ memory: structuredClone(memory) })
  try {
    await drv.hello()
    const dry = await drv.call('trim', { l2_capacity: 2, dry_run: true })
    assert.deepEqual(dry.value.candidates, [
      { layer: 'l2', id: 'w-1', reason: 'l2_over_capacity', excess: 1, items: ['a'] },
    ])
    assert.deepEqual(drv.shortMemory.memory.workspaces['w-1'].summary.facts, ['a', 'b', 'c'])

    const applied = await drv.call('trim', { l2_capacity: 2 })
    assert.deepEqual(applied.value.l2_trimmed, [{ workspace: 'w-1', removed: 1 }])
    assert.deepEqual(drv.shortMemory.memory.workspaces['w-1'].summary.facts, ['b', 'c'])
  } finally {
    drv.close()
  }
})

test('view：L2 一档字段齐全', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('view', {})
    assert.equal(result.value.kind, 'view')
    assert.equal(result.value.l2.length, 1)
    assert.deepEqual(result.value.l2[0].sources, ['c-0'])
  } finally {
    drv.close()
  }
})

test('edit：L1 删除写 short-memory；L2 置顶不支持；非法参数 bad_args', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const deleted = await drv.call('edit', { action: 'delete', layer: 'l1', id: 'c-1' })
    assert.equal(deleted.value.ok, true)
    assert.equal(drv.shortMemory.memory.sessions['c-1'], undefined)
    assert.equal(drv.shortMemory.memory.sessions['c-2'] !== undefined, true)

    const unsupported = await drv.call('edit', { action: 'pin', layer: 'l2', id: 'w-1' })
    assert.equal(unsupported.value.reason, 'unsupported_layer')

    const l3 = await drv.call('edit', { action: 'delete', layer: 'l3', id: 'x' })
    assert.equal(l3.code, 'bad_args')

    const bad = await drv.call('edit', { action: 'delete', id: 'x' })
    assert.equal(bad.code, 'bad_args')
  } finally {
    drv.close()
  }
})

test('未知方法 / 能力类 → 结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'l2-maintenance', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'view', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
