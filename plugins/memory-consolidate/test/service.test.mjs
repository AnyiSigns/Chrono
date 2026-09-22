// `memory-consolidate` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假后端。
// 覆盖：握手 / 控制 / EOF 自退出；consolidate 去重合并与固化；#19 / #20 不可用明确失败不半写；
// 空集不产生写；sweep L1 到期 / 水位 / L3 淘汰与 pinned 跳过；candidates 只读；view 字段；edit 三种动作。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIXED_ENV,
  defaultBridge,
  directivesOf,
  externOf,
  memoryStoreFixture,
  memoryStoreWith,
  opsOf,
  sessionFixture,
  shortMemoryFixture,
  startService,
  vec,
} from './driver.mjs'

const AT = new Date(FIXED_ENV.now).toISOString()
const HASH = 'a'.repeat(64)

/** 合并测试用的显式向量：f2 两会话重复（同向量）→ 去重；其余正交。 */
const MERGE_VECTORS = {
  f1: vec({ 0: 1 }),
  f2: vec({ 1: 1 }),
  f3: vec({ 2: 1 }),
  old: vec({ 3: 1 }),
}

function consolidateArgs(extra = {}) {
  return {
    short_memory: shortMemoryFixture(),
    session: sessionFixture(),
    memory_store: memoryStoreFixture(),
    memory_store_refs: {},
    ...extra,
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'memory-consolidate')
    assert.deepEqual(manifest.implements, ['memory-maintenance'])
    assert.deepEqual(manifest.methods['memory-maintenance'], ['consolidate', 'sweep', 'candidates', 'view', 'edit'])
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

test('consolidate：L1 合并进 L2、sources 最新在前、向量去重、保留其他会话', async () => {
  const drv = startService({ vectors: MERGE_VECTORS })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', consolidateArgs({ weight_threshold: 1 }))
    assert.equal(result.kind, 'result')
    const ops = opsOf(result.value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
    assert.equal(ops[1].args.id, 'short-memory')
    const body = ops[0].args.body
    assert.deepEqual(body.workspaces['w-1'].sources, ['c-2', 'c-1', 'c-0'])
    assert.deepEqual(body.workspaces['w-1'].summary.facts, ['old', 'f1', 'f3', 'f2'])
    assert.equal(body.workspaces['w-1'].at, AT)
    assert.deepEqual(Object.keys(body.sessions).sort(), ['c-1', 'c-2'])
    assert.equal(externOf(result.value).dedup, 'vector')
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'embed'))
  } finally {
    drv.close()
  }
})

test('consolidate：同输入同输出（确定性）', async () => {
  const drv = startService({ vectors: MERGE_VECTORS })
  try {
    await drv.hello()
    const first = await drv.call('consolidate', consolidateArgs({ weight_threshold: 1 }))
    const second = await drv.call('consolidate', consolidateArgs({ weight_threshold: 1 }))
    assert.deepEqual(second.value, first.value)
  } finally {
    drv.close()
  }
})

test('consolidate：需要摘要时 eff #19（summary_used + goal 来自摘要）', async () => {
  const drv = startService({
    vectors: MERGE_VECTORS,
    summary: { goal: 'MERGED', facts: ['sf1'] },
  })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', consolidateArgs({ summarize: true, weight_threshold: 1 }))
    assert.equal(externOf(result.value).summary_used, true)
    const body = opsOf(result.value)[0].args.body
    assert.equal(body.workspaces['w-1'].summary.goal, 'MERGED')
    assert.deepEqual(body.workspaces['w-1'].summary.facts, ['sf1'])
    assert.ok(drv.portCalls.some((call) => call.port === 'compress' && call.method === 'summarize'))
  } finally {
    drv.close()
  }
})

test('consolidate：#19 不可用 → 明确失败、不半写', async () => {
  const drv = startService({
    vectors: MERGE_VECTORS,
    bridge: (port, method, args) =>
      port === 'compress'
        ? Promise.resolve({ error: 'model_unavailable', message: 'no model' })
        : Promise.resolve(defaultBridge({ vectors: MERGE_VECTORS })(port, method, args)),
  })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', consolidateArgs({ summarize: true }))
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'model_unavailable')
    assert.equal(result.value.$directives, undefined)
  } finally {
    drv.close()
  }
})

test('consolidate：#20 不可用 → 明确失败、不半写', async () => {
  const drv = startService({
    bridge: () => Promise.resolve({ error: 'embedding_unavailable', message: 'no embedding' }),
  })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', consolidateArgs())
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'embedding_unavailable')
    assert.equal(result.value.$directives, undefined)
  } finally {
    drv.close()
  }
})

test('consolidate：空集不产生写、不调后端', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('consolidate', {
      short_memory: { version: 1, sessions: {}, workspaces: {} },
      session: {},
      memory_store: memoryStoreFixture(),
      memory_store_refs: {},
    })
    assert.deepEqual(directivesOf(result.value).map((item) => item.kind), ['extern'])
    assert.equal(externOf(result.value).no_input, true)
    assert.equal(drv.portCalls.length, 0)
  } finally {
    drv.close()
  }
})

test('consolidate：L2 高价值项固化进 L3（meta.source=consolidate、链式 prev/tail）', async () => {
  const drv = startService({ vectors: MERGE_VECTORS })
  try {
    await drv.hello()
    const result = await drv.call(
      'consolidate',
      consolidateArgs({ item_weights: { f3: 0.9 }, solidify_full_sources: 100 }),
    )
    const ops = opsOf(result.value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen', 'put', 'put', 'add_gen'])
    assert.equal(ops[1].args.id, 'short-memory')
    const entry = ops[2].args.body
    assert.equal(entry.text, 'f3')
    assert.equal(entry.meta.source, 'consolidate')
    assert.equal(entry.meta.workspace, 'w-1')
    assert.equal(entry.prev, null)
    assert.equal(ops[3].args.body.tail.def.$n, 2)
    assert.equal(ops[3].args.body.count, 1)
    assert.equal(ops[4].args.id, 'memory-store')
    assert.equal(ops[4].args.payload.$n, 3)
    assert.equal(externOf(result.value).solidified.length, 1)
  } finally {
    drv.close()
  }
})

test('consolidate：与现有 L3 重复的固化候选被跳过', async () => {
  const existing = memoryStoreWith({ id: 'm-x', text: 'f3', at: '2023-01-01T00:00:00.000Z' })
  const drv = startService({ vectors: { ...MERGE_VECTORS } })
  try {
    await drv.hello()
    const result = await drv.call(
      'consolidate',
      consolidateArgs({
        memory_store: existing.body,
        memory_store_refs: existing.refs,
        item_weights: { f3: 0.9 },
        solidify_full_sources: 100,
      }),
    )
    const ops = opsOf(result.value)
    assert.deepEqual(ops.map((op) => op.args?.id ?? op.op), ['put', 'short-memory'])
    assert.equal(externOf(result.value).solidified.length, 0)
  } finally {
    drv.close()
  }
})

test('sweep：L1 到期出删除计划（可回放）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('sweep', {
      short_memory: shortMemoryFixture(),
      memory_store: memoryStoreFixture(),
      memory_store_refs: {},
    })
    const ops = opsOf(result.value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
    assert.equal(ops[1].args.id, 'short-memory')
    assert.deepEqual(ops[0].args.body.sessions, {})
    assert.deepEqual(externOf(result.value).l1_deleted, ['c-1', 'c-2'])
  } finally {
    drv.close()
  }
})

test('sweep：空删除集不产生写', async () => {
  const future = { ...shortMemoryFixture(), sessions: { 'c-9': { summary: { facts: [] }, at: AT, expires_at: '2099-01-01T00:00:00.000Z' } } }
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('sweep', { short_memory: future, memory_store: memoryStoreFixture(), memory_store_refs: {} })
    assert.deepEqual(directivesOf(result.value).map((item) => item.kind), ['extern'])
    assert.equal(externOf(result.value).no_changes, true)
  } finally {
    drv.close()
  }
})

test('sweep：L3 低权重出删除计划（#21 body 加 deleted）；pinned 跳过；同输入同删除集', async () => {
  const low = memoryStoreWith({ id: 'm-1', text: 'x', weight: 0.1 })
  const drv = startService()
  try {
    await drv.hello()
    const args = {
      short_memory: { version: 1, sessions: {}, workspaces: {} },
      memory_store: low.body,
      memory_store_refs: low.refs,
      cursor: '2022-01-01T00:00:00.000Z',
    }
    const first = await drv.call('sweep', args)
    const ops = opsOf(first.value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
    assert.equal(ops[1].args.id, 'memory-store')
    assert.equal(ops[0].args.body.deleted['m-1'], AT)
    assert.deepEqual(externOf(first.value).l3_deleted, [{ id: 'm-1', reason: 'low_weight' }])

    const second = await drv.call('sweep', args)
    assert.deepEqual(second.value, first.value)

    const pinnedBody = { ...low.body, pinned: { 'm-1': true } }
    const pinned = await drv.call('sweep', { ...args, memory_store: pinnedBody })
    assert.deepEqual(directivesOf(pinned.value).map((item) => item.kind), ['extern'])
    assert.equal(externOf(pinned.value).no_changes, true)
  } finally {
    drv.close()
  }
})

test('sweep：计划未落账时同输入重跑仍出同一删除集（水位不先推进）', async () => {
  const low = memoryStoreWith({ id: 'm-1', text: 'x', weight: 0.1, at: '2023-01-01T00:00:00.000Z' })
  const drv = startService()
  try {
    await drv.hello()
    const args = {
      short_memory: { version: 1, sessions: {}, workspaces: {} },
      memory_store: low.body,
      memory_store_refs: low.refs,
    }
    const first = await drv.call('sweep', args)
    const firstDeleted = externOf(first.value).l3_deleted
    assert.deepEqual(firstDeleted, [{ id: 'm-1', reason: 'low_weight' }])
    // 模拟计划未落账：同输入重跑不得因水位前进而跳过候选。
    const second = await drv.call('sweep', args)
    assert.deepEqual(externOf(second.value).l3_deleted, firstDeleted)
    assert.deepEqual(second.value, first.value)
  } finally {
    drv.close()
  }
})

test('sweep：无变更时才推进水位（后续调用按水位增量）', async () => {
  const future = { ...shortMemoryFixture(), sessions: { 'c-9': { summary: { facts: [] }, at: AT, expires_at: '2099-01-01T00:00:00.000Z' } } }
  const drv = startService()
  try {
    await drv.hello()
    const first = await drv.call('sweep', { short_memory: future, memory_store: memoryStoreFixture(), memory_store_refs: {} })
    assert.equal(externOf(first.value).no_changes, true)
    // 水位已推进到本次 at：低权重旧条目（at <= 水位）不再被扫描。
    const low = memoryStoreWith({ id: 'm-1', text: 'x', weight: 0.1, at: '2023-01-01T00:00:00.000Z' })
    const second = await drv.call('sweep', {
      short_memory: future,
      memory_store: low.body,
      memory_store_refs: low.refs,
    })
    assert.equal(externOf(second.value).no_changes, true)
  } finally {
    drv.close()
  }
})

test('sweep：L2 超容量从最旧一端裁', async () => {
  const memory = {
    version: 1,
    sessions: {},
    workspaces: {
      'w-1': { summary: { goal: '', facts: ['a', 'b', 'c'], decisions: [], open_questions: [], files: [] }, sources: [], at: AT },
    },
  }
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('sweep', {
      short_memory: memory,
      memory_store: memoryStoreFixture(),
      memory_store_refs: {},
      l2_capacity: 2,
    })
    const ops = opsOf(result.value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
    assert.deepEqual(ops[0].args.body.workspaces['w-1'].summary.facts, ['b', 'c'])
    assert.deepEqual(externOf(result.value).l2_trimmed, [{ workspace: 'w-1', removed: 1 }])
  } finally {
    drv.close()
  }
})

test('sweep：水位之后的条目才扫描（游标增量）', async () => {
  const low = memoryStoreWith({ id: 'm-1', text: 'x', weight: 0.1, at: '2023-01-01T00:00:00.000Z' })
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('sweep', {
      short_memory: { version: 1, sessions: {}, workspaces: {} },
      memory_store: low.body,
      memory_store_refs: low.refs,
      cursor: '2023-06-01T00:00:00.000Z',
    })
    assert.equal(externOf(result.value).no_changes, true)
  } finally {
    drv.close()
  }
})

test('candidates：只读回候选、不产写、不删', async () => {
  const low = memoryStoreWith({ id: 'm-1', text: 'x', weight: 0.1 })
  const drv = startService()
  try {
    await drv.hello()
    const memory = {
      version: 1,
      sessions: shortMemoryFixture().sessions,
      workspaces: { 'w-1': { summary: { goal: '', facts: ['a', 'b', 'c'], decisions: [], open_questions: [], files: [] }, sources: [], at: AT } },
    }
    const result = await drv.call('candidates', {
      short_memory: memory,
      memory_store: low.body,
      memory_store_refs: low.refs,
      l2_capacity: 2,
    })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.$directives, undefined)
    const reasons = result.value.candidates.map((item) => item.reason).sort()
    assert.deepEqual(reasons, ['l1_expired', 'l1_expired', 'l2_over_capacity', 'low_weight'])
  } finally {
    drv.close()
  }
})

test('view：L1/L2/L3 三档字段齐全（含剩余 TTL 与 #21 条目字段）', async () => {
  const store = memoryStoreWith({ id: 'm-1', text: 't', weight: 0.5, tags: ['tag-a'] })
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('view', {
      short_memory: shortMemoryFixture(),
      memory_store: store.body,
      memory_store_refs: store.refs,
    })
    const value = result.value
    assert.equal(value.kind, 'view')
    assert.equal(value.l1.length, 2)
    assert.equal(value.l1[0].ttl_remaining_ms, 0)
    assert.equal(typeof value.l1[0].summary.goal, 'string')
    assert.equal(value.l2.length, 1)
    assert.deepEqual(value.l2[0].sources, ['c-0'])
    assert.equal(value.l3.length, 1)
    assert.deepEqual(
      Object.keys(value.l3[0]).sort(),
      ['at', 'id', 'pinned', 'source', 'tags', 'text', 'weight', 'workspace'],
    )
    assert.deepEqual(value.l3[0].tags, ['tag-a'])
    assert.equal(value.l3[0].weight, 0.5)
    assert.equal(value.l3[0].pinned, false)
  } finally {
    drv.close()
  }
})

test('edit：delete / pin / text 三种动作计划形状', async () => {
  const store = memoryStoreWith({ id: 'm-1', text: 'old' })
  const drv = startService()
  try {
    await drv.hello()
    const base = { memory_store: store.body, memory_store_refs: store.refs }

    const deleted = await drv.call('edit', { action: 'delete', layer: 'l3', id: 'm-1', ...base })
    const deleteOps = opsOf(deleted.value)
    assert.deepEqual(deleteOps.map((op) => op.op), ['put', 'add_gen'])
    assert.equal(deleteOps[1].args.id, 'memory-store')
    assert.equal(deleteOps[0].args.body.deleted['m-1'], AT)

    const pinned = await drv.call('edit', { action: 'pin', layer: 'l3', id: 'm-1', ...base })
    const pinOps = opsOf(pinned.value)
    assert.equal(pinOps[0].args.body.pinned['m-1'], true)
    const unpinned = await drv.call('edit', { action: 'pin', layer: 'l3', id: 'm-1', patch: { pinned: false }, ...base })
    assert.equal(opsOf(unpinned.value)[0].args.body.pinned['m-1'], undefined)

    const edited = await drv.call('edit', { action: 'text', layer: 'l3', id: 'm-1', patch: { text: 'new' }, ...base })
    const textOps = opsOf(edited.value)
    assert.deepEqual(textOps.map((op) => op.op), ['put', 'put', 'add_gen'])
    assert.equal(textOps[0].args.body.text, 'new')
    assert.equal(textOps[0].args.body.id, 'm-1')
    assert.deepEqual(textOps[0].args.body.prev, { def: HASH })
    assert.deepEqual(textOps[1].args.body.tail.def, { $n: 0 })
    assert.equal(textOps[1].args.body.count, 2)
    assert.equal(textOps[2].args.payload.$n, 1)
  } finally {
    drv.close()
  }
})

test('edit：L1 删除写 #3；L2 置顶不支持；非法参数 bad_args', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const deleted = await drv.call('edit', {
      action: 'delete',
      layer: 'l1',
      id: 'c-1',
      short_memory: shortMemoryFixture(),
      memory_store: memoryStoreFixture(),
      memory_store_refs: {},
    })
    const ops = opsOf(deleted.value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
    assert.equal(ops[1].args.id, 'short-memory')
    assert.equal(ops[0].args.body.sessions['c-1'], undefined)
    assert.equal(ops[0].args.body.sessions['c-2'] !== undefined, true)

    const unsupported = await drv.call('edit', {
      action: 'pin',
      layer: 'l2',
      id: 'w-1',
      short_memory: shortMemoryFixture(),
      memory_store: memoryStoreFixture(),
      memory_store_refs: {},
    })
    assert.deepEqual(directivesOf(unsupported.value).map((item) => item.kind), ['extern'])
    assert.equal(externOf(unsupported.value).reason, 'unsupported_layer')

    const bad = await drv.call('edit', { action: 'delete', id: 'x' })
    assert.equal(bad.kind, 'error')
    assert.equal(bad.code, 'bad_args')
  } finally {
    drv.close()
  }
})

test('未知方法 / 能力类 → 结构化 error', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal(
      (await drv.request('call', { port: 'memory-maintenance', method: 'nope', args: {} }, 'error')).code,
      'unknown_method',
    )
    assert.equal(
      (await drv.request('call', { port: 'other', method: 'view', args: {} }, 'error')).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
