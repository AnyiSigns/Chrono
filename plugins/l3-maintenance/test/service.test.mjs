// `l3-maintenance` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假 owner。
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

function memoryEntry(entry = {}) {
  return {
    id: entry.id ?? 'm-1',
    text: entry.text ?? 'text',
    meta: {
      source: 'manual',
      workspace: 'w-1',
      at: entry.at ?? '2023-01-01T00:00:00.000Z',
      tags: entry.tags ?? [],
    },
    weight: entry.weight ?? null,
  }
}

function fakeMemory(initialEntries = [], initialPinned = {}) {
  const entries = structuredClone(initialEntries)
  const pinned = { ...initialPinned }
  return {
    entries,
    pinned,
    call(method, args) {
      if (method === 'list') {
        return {
          ok: true,
          kind: 'list',
          entries: structuredClone(entries),
          count: entries.length,
          pinned: { ...pinned },
        }
      }
      if (method === 'append') {
        for (const entry of args?.entries ?? []) entries.push(structuredClone(entry))
        return { ok: true, kind: 'append', count: entries.length }
      }
      if (method === 'delete') {
        for (const id of args?.ids ?? []) {
          const index = entries.findIndex((item) => item.id === id)
          if (index >= 0) entries.splice(index, 1)
        }
        return { ok: true, kind: 'delete', deleted: args?.ids ?? [] }
      }
      if (method === 'pin') {
        if (args?.pinned === false) delete pinned[args.id]
        else pinned[args.id] = true
        return { ok: true, kind: 'pin', id: args.id, pinned: args.pinned !== false }
      }
      if (method === 'edit') {
        const entry = entries.find((item) => item.id === args?.id)
        if (entry === undefined)
          return { ok: false, kind: 'edit', id: args?.id, reason: 'not_found' }
        entry.text = args.text
        return { ok: true, kind: 'edit', id: args.id, text: args.text }
      }
      return undefined
    },
  }
}

function shortMemoryFixture() {
  return {
    version: 1,
    sessions: {},
    workspaces: {
      'w-1': {
        summary: { goal: 'WG', decisions: [], facts: ['f3'], open_questions: [], files: [] },
        sources: ['c-1', 'c-2'],
        at: AT,
      },
    },
  }
}

function drive(options = {}) {
  const memory = options.memory ?? fakeMemory(options.entries, options.pinned)
  const vectors = options.vectors ?? undefined
  const drv = startService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    onPortCall: (message) => {
      if (options.bridge) {
        const outcome = options.bridge(message)
        if (outcome !== undefined) return outcome
      }
      if (message.port === 'memory') {
        const outcome = memory.call(message.method, message.args ?? {})
        if (outcome === undefined)
          return { ok: false, code: 'unknown_method', message: message.method }
        return { ok: true, value: outcome }
      }
      if (message.port === 'short-memory' && message.method === 'read')
        return { ok: true, value: structuredClone(options.shortMemory ?? shortMemoryFixture()) }
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
      return { ok: false, code: 'not_ready', message: 'no resolver' }
    },
  })
  return {
    ...drv,
    memory,
    hello: () => drv.hello('l3-maintenance'),
    call: (method, args, env = FIXED_ENV) => drv.call('l3-maintenance', method, args, env),
  }
}

const VECTORS = { f3: vec({ 0: 1 }) }

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'l3-maintenance')
    assert.deepEqual(manifest.implements, ['l3-maintenance'])
    assert.deepEqual(manifest.methods['l3-maintenance'], ['solidify', 'forget', 'view', 'edit'])
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('solidify：高价值项固化进 L3（meta.source=consolidate），写 memory.append', async () => {
  const drv = drive({ vectors: VECTORS })
  try {
    await drv.hello()
    const result = await drv.call('solidify', {
      workspaces: ['w-1'],
      item_weights: { f3: 0.9 },
      solidify_full_sources: 100,
    })
    assert.equal(result.value.kind, 'solidify')
    assert.equal(result.value.solidified.length, 1)
    assert.equal(drv.memory.entries.length, 1)
    assert.equal(drv.memory.entries[0].text, 'f3')
    assert.equal(drv.memory.entries[0].meta.source, 'consolidate')
    assert.equal(drv.memory.entries[0].meta.workspace, 'w-1')
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'embed'))
  } finally {
    drv.close()
  }
})

test('solidify：向量模型随调用方传入；缺省不带 model，交由 embedding 门面按提供方元数据解析', async () => {
  const embeddingCalls = (drv) =>
    drv.portCalls.filter((call) => call.port === 'embedding' && call.method === 'embed')
  const args = { workspaces: ['w-1'], item_weights: { f3: 0.9 }, solidify_full_sources: 100 }

  const omitted = drive({ vectors: VECTORS })
  try {
    await omitted.hello()
    await omitted.call('solidify', args)
    const calls = embeddingCalls(omitted)
    assert.ok(calls.length > 0)
    assert.equal(Object.hasOwn(calls[0].args ?? {}, 'model'), false)
  } finally {
    omitted.close()
  }

  const explicit = drive({ vectors: VECTORS })
  try {
    await explicit.hello()
    await explicit.call('solidify', { ...args, embedding_model: 'custom-model' })
    const calls = embeddingCalls(explicit)
    assert.ok(calls.length > 0)
    assert.equal(calls[0].args.model, 'custom-model')
  } finally {
    explicit.close()
  }
})

test('solidify：与现有 L3 重复的候选被跳过', async () => {
  const drv = drive({
    vectors: VECTORS,
    entries: [memoryEntry({ id: 'm-x', text: 'f3' })],
  })
  try {
    await drv.hello()
    const result = await drv.call('solidify', {
      workspaces: ['w-1'],
      item_weights: { f3: 0.9 },
      solidify_full_sources: 100,
    })
    assert.equal(result.value.solidified.length, 0)
    assert.equal(drv.memory.entries.length, 1)
  } finally {
    drv.close()
  }
})

test('solidify：无候选不调后端、不写', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('solidify', { workspaces: ['w-1'] })
    assert.deepEqual(result.value.solidified, [])
    assert.equal(
      drv.portCalls.some((call) => call.port === 'embedding'),
      false,
    )
  } finally {
    drv.close()
  }
})

test('forget：低权重删除；pinned 跳过；游标增量；同输入同删除集', async () => {
  const drv = drive({
    entries: [
      memoryEntry({ id: 'm-1', text: 'x', weight: 0.1 }),
      memoryEntry({ id: 'm-pin', text: 'y', weight: 0.1 }),
    ],
    pinned: { 'm-pin': true },
  })
  try {
    await drv.hello()
    const result = await drv.call('forget', { cursor: '2022-01-01T00:00:00.000Z' })
    assert.deepEqual(result.value.l3_deleted, [{ id: 'm-1', reason: 'low_weight' }])
    assert.deepEqual(
      drv.memory.entries.map((entry) => entry.id),
      ['m-pin'],
    )

    const skipped = await drv.call('forget', { cursor: '2099-01-01T00:00:00.000Z' })
    assert.deepEqual(skipped.value.l3_deleted, [])
  } finally {
    drv.close()
  }
})

test('forget：dry_run 只算不写，回 low_weight 候选', async () => {
  const drv = drive({ entries: [memoryEntry({ id: 'm-1', text: 'x', weight: 0.1 })] })
  try {
    await drv.hello()
    const result = await drv.call('forget', { dry_run: true })
    assert.deepEqual(result.value.candidates, [
      {
        layer: 'l3',
        id: 'm-1',
        text: 'x',
        at: '2023-01-01T00:00:00.000Z',
        weight: 0.1,
        reason: 'low_weight',
      },
    ])
    assert.equal(drv.memory.entries.length, 1)
  } finally {
    drv.close()
  }
})

test('forget：超容量按 weight / at 淘汰', async () => {
  const drv = drive({
    entries: [
      memoryEntry({ id: 'm-1', text: 'x', weight: 0.5, at: '2023-01-01T00:00:00.000Z' }),
      memoryEntry({ id: 'm-2', text: 'y', weight: 0.5, at: '2023-02-01T00:00:00.000Z' }),
      memoryEntry({ id: 'm-3', text: 'z', weight: 0.5, at: '2023-03-01T00:00:00.000Z' }),
    ],
  })
  try {
    await drv.hello()
    const result = await drv.call('forget', { l3_capacity: 2 })
    assert.deepEqual(result.value.l3_deleted, [{ id: 'm-1', reason: 'over_capacity' }])
    assert.deepEqual(
      drv.memory.entries.map((entry) => entry.id),
      ['m-2', 'm-3'],
    )
  } finally {
    drv.close()
  }
})

test('view：L3 一档字段齐全', async () => {
  const drv = drive({
    entries: [memoryEntry({ id: 'm-1', text: 't', weight: 0.5, tags: ['tag-a'] })],
  })
  try {
    await drv.hello()
    const result = await drv.call('view', {})
    assert.equal(result.value.kind, 'view')
    assert.deepEqual(Object.keys(result.value.l3[0]).sort(), [
      'at',
      'id',
      'pinned',
      'source',
      'tags',
      'text',
      'weight',
      'workspace',
    ])
    assert.deepEqual(result.value.l3[0].tags, ['tag-a'])
    assert.equal(result.value.l3[0].weight, 0.5)
    assert.equal(result.value.l3[0].pinned, false)
  } finally {
    drv.close()
  }
})

test('edit：delete / pin / text 三种动作写 owner 服务；非法参数 bad_args', async () => {
  const drv = drive({ entries: [memoryEntry({ id: 'm-1', text: 'old' })] })
  try {
    await drv.hello()
    const pinned = await drv.call('edit', { action: 'pin', layer: 'l3', id: 'm-1' })
    assert.equal(pinned.value.pinned, true)
    assert.equal(drv.memory.pinned['m-1'], true)
    const unpinned = await drv.call('edit', {
      action: 'pin',
      layer: 'l3',
      id: 'm-1',
      patch: { pinned: false },
    })
    assert.equal(unpinned.value.pinned, false)
    assert.equal(drv.memory.pinned['m-1'], undefined)
    const edited = await drv.call('edit', {
      action: 'text',
      layer: 'l3',
      id: 'm-1',
      patch: { text: 'new' },
    })
    assert.equal(edited.value.ok, true)
    assert.equal(drv.memory.entries[0].text, 'new')
    const deleted = await drv.call('edit', { action: 'delete', layer: 'l3', id: 'm-1' })
    assert.equal(deleted.value.ok, true)
    assert.deepEqual(drv.memory.entries, [])

    const missing = await drv.call('edit', { action: 'delete', layer: 'l3', id: 'nope' })
    assert.equal(missing.value.reason, 'not_found')
    assert.equal(
      (await drv.call('edit', { action: 'delete', layer: 'l2', id: 'x' })).code,
      'bad_args',
    )
    assert.equal((await drv.call('edit', { action: 'delete', id: 'x' })).code, 'bad_args')
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
          { port: 'l3-maintenance', method: 'nope', args: {}, env: FIXED_ENV },
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
