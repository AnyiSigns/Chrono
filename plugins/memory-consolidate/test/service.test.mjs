// `memory-consolidate` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假后端。
// 覆盖：握手 / 控制 / EOF 自退出；consolidate 去重合并与固化（写 owner 服务、不产世界写计划）；
// 后端不可用明确失败不半写；空集不写；sweep L1 到期 / 水位 / L3 淘汰与 pinned 跳过；
// candidates 只读；view 字段；edit 三种动作。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FIXED_ENV,
  defaultBridge,
  memoryEntry,
  shortMemoryFixture,
  startService,
  vec,
} from './driver.mjs'

const AT = new Date(FIXED_ENV.now).toISOString()

/** 合并测试用的显式向量：f2 两会话重复（同向量）→ 去重；其余正交。 */
const MERGE_VECTORS = {
  f1: vec({ 0: 1 }),
  f2: vec({ 1: 1 }),
  f3: vec({ 2: 1 }),
  old: vec({ 3: 1 }),
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

test('consolidate：L1 合并进 L2、sources 最新在前、向量去重；写 owner 服务、不产世界写计划', async () => {
  const drv = startService({ vectors: MERGE_VECTORS, memory: shortMemoryFixture() })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', { weight_threshold: 1 })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, true)
    assert.equal(result.value.$directives, undefined, '运行记录不得产世界写计划')
    const memory = drv.shortMemory.memory
    assert.deepEqual(memory.workspaces['w-1'].sources, ['c-2', 'c-1', 'c-0'])
    assert.deepEqual(memory.workspaces['w-1'].summary.facts, ['old', 'f1', 'f3', 'f2'])
    assert.equal(memory.workspaces['w-1'].at, AT)
    assert.deepEqual(Object.keys(memory.sessions).sort(), ['c-1', 'c-2'])
    assert.equal(result.value.dedup, 'vector')
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'embed'))
    assert.ok(drv.portCalls.some((call) => call.port === 'short-memory' && call.method === 'apply'))
  } finally {
    drv.close()
  }
})

test('consolidate：同输入同输出（确定性）', async () => {
  const first = startService({ vectors: MERGE_VECTORS, memory: shortMemoryFixture() })
  const second = startService({ vectors: MERGE_VECTORS, memory: shortMemoryFixture() })
  try {
    await first.hello()
    await second.hello()
    const a = await first.call('consolidate', { weight_threshold: 1 })
    const b = await second.call('consolidate', { weight_threshold: 1 })
    assert.deepEqual(b.value, a.value)
  } finally {
    first.close()
    second.close()
  }
})

test('consolidate：需要摘要时 eff compress.summarize（persist:false，summary_used + goal 来自摘要）', async () => {
  const drv = startService({ vectors: MERGE_VECTORS, memory: shortMemoryFixture(), summary: { goal: 'MERGED', facts: ['sf1'] } })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', { summarize: true, weight_threshold: 1 })
    assert.equal(result.value.summary_used, true)
    assert.equal(drv.shortMemory.memory.workspaces['w-1'].summary.goal, 'MERGED')
    assert.deepEqual(drv.shortMemory.memory.workspaces['w-1'].summary.facts, ['sf1'])
    const call = drv.portCalls.find((item) => item.port === 'compress' && item.method === 'summarize')
    assert.ok(call !== undefined)
    assert.equal(call.args.persist, false)
  } finally {
    drv.close()
  }
})

test('consolidate：compress 不可用 → 明确失败、不半写', async () => {
  const drv = startService({
    vectors: MERGE_VECTORS,
    memory: shortMemoryFixture(),
    bridge: (port, method, args) =>
      port === 'compress'
        ? Promise.resolve({ error: 'model_unavailable', message: 'no model' })
        : Promise.resolve(defaultBridge({ vectors: MERGE_VECTORS })(port, method, args)),
  })
  try {
    await drv.hello()
    const before = JSON.stringify(drv.shortMemory.memory)
    const result = await drv.call('consolidate', { summarize: true })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'model_unavailable')
    assert.equal(JSON.stringify(drv.shortMemory.memory), before)
  } finally {
    drv.close()
  }
})

test('consolidate：embedding 不可用 → 明确失败、不半写', async () => {
  const drv = startService({
    memory: shortMemoryFixture(),
    bridge: () => Promise.resolve({ error: 'embedding_unavailable', message: 'no embedding' }),
  })
  try {
    await drv.hello()
    const before = JSON.stringify(drv.shortMemory.memory)
    const result = await drv.call('consolidate', {})
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'embedding_unavailable')
    assert.equal(JSON.stringify(drv.shortMemory.memory), before)
  } finally {
    drv.close()
  }
})

test('consolidate：空集不产生写、不调后端', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('consolidate', {})
    assert.equal(result.value.no_input, true)
    assert.equal(result.value.$directives, undefined)
    assert.equal(drv.portCalls.some((call) => call.port === 'embedding'), false)
  } finally {
    drv.close()
  }
})

test('consolidate：L2 高价值项固化进 L3（meta.source=consolidate）', async () => {
  const drv = startService({ vectors: MERGE_VECTORS, memory: shortMemoryFixture() })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', { item_weights: { f3: 0.9 }, solidify_full_sources: 100 })
    assert.equal(result.value.solidified.length, 1)
    assert.equal(drv.memory.entries.length, 1)
    const entry = drv.memory.entries[0]
    assert.equal(entry.text, 'f3')
    assert.equal(entry.meta.source, 'consolidate')
    assert.equal(entry.meta.workspace, 'w-1')
  } finally {
    drv.close()
  }
})

test('consolidate：与现有 L3 重复的固化候选被跳过', async () => {
  const drv = startService({
    vectors: { ...MERGE_VECTORS },
    memory: shortMemoryFixture(),
    entries: [memoryEntry({ id: 'm-x', text: 'f3', at: '2023-01-01T00:00:00.000Z' })],
  })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', { item_weights: { f3: 0.9 }, solidify_full_sources: 100 })
    assert.equal(result.value.solidified.length, 0)
    assert.equal(drv.memory.entries.length, 1)
  } finally {
    drv.close()
  }
})

test('sweep：L1 到期删除（写 short-memory）', async () => {
  const drv = startService({ memory: shortMemoryFixture() })
  try {
    await drv.hello()
    const result = await drv.call('sweep', {})
    assert.deepEqual(result.value.l1_deleted, ['c-1', 'c-2'])
    assert.deepEqual(drv.shortMemory.memory.sessions, {})
  } finally {
    drv.close()
  }
})

test('sweep：空删除集不产生写', async () => {
  const future = { ...shortMemoryFixture(), sessions: { 'c-9': { summary: { facts: [] }, at: AT, expires_at: '2099-01-01T00:00:00.000Z' } } }
  const drv = startService({ memory: future })
  try {
    await drv.hello()
    const result = await drv.call('sweep', {})
    assert.equal(result.value.no_changes, true)
  } finally {
    drv.close()
  }
})

test('sweep：L3 低权重删除；pinned 跳过；同输入同删除集', async () => {
  const drv = startService({
    memory: { version: 1, sessions: {}, workspaces: {} },
    entries: [memoryEntry({ id: 'm-1', text: 'x', weight: 0.1 })],
  })
  try {
    await drv.hello()
    const args = { cursor: '2022-01-01T00:00:00.000Z' }
    const first = await drv.call('sweep', args)
    assert.deepEqual(first.value.l3_deleted, [{ id: 'm-1', reason: 'low_weight' }])
    assert.deepEqual(drv.memory.entries, [])

    const drv2 = startService({
      memory: { version: 1, sessions: {}, workspaces: {} },
      entries: [memoryEntry({ id: 'm-1', text: 'x', weight: 0.1 })],
      pinned: { 'm-1': true },
    })
    try {
      await drv2.hello()
      const pinned = await drv2.call('sweep', args)
      assert.equal(pinned.value.no_changes, true)
      assert.equal(drv2.memory.entries.length, 1)
    } finally {
      drv2.close()
    }
  } finally {
    drv.close()
  }
})

test('sweep：同输入同删除集（确定性）；重跑幂等', async () => {
  const args = {}
  const first = startService({
    memory: { version: 1, sessions: {}, workspaces: {} },
    entries: [memoryEntry({ id: 'm-1', text: 'x', weight: 0.1, at: '2023-01-01T00:00:00.000Z' })],
  })
  const second = startService({
    memory: { version: 1, sessions: {}, workspaces: {} },
    entries: [memoryEntry({ id: 'm-1', text: 'x', weight: 0.1, at: '2023-01-01T00:00:00.000Z' })],
  })
  try {
    await first.hello()
    await second.hello()
    const a = await first.call('sweep', args)
    const b = await second.call('sweep', args)
    assert.deepEqual(b.value, a.value)
    assert.deepEqual(a.value.l3_deleted, [{ id: 'm-1', reason: 'low_weight' }])
    // 立即落盘后重跑：条目已删，幂等为无变更。
    const again = await first.call('sweep', args)
    assert.equal(again.value.no_changes, true)
  } finally {
    first.close()
    second.close()
  }
})

test('sweep：无变更时才推进水位（后续调用按水位增量）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mc-state-'))
  const future = { ...shortMemoryFixture(), sessions: { 'c-9': { summary: { facts: [] }, at: AT, expires_at: '2099-01-01T00:00:00.000Z' } } }
  try {
    const drv = startService({ stateDir, memory: future })
    try {
      await drv.hello()
      const first = await drv.call('sweep', {})
      assert.equal(first.value.no_changes, true)
    } finally {
      drv.close()
    }
    const drv2 = startService({
      stateDir,
      memory: future,
      entries: [memoryEntry({ id: 'm-1', text: 'x', weight: 0.1, at: '2023-01-01T00:00:00.000Z' })],
    })
    try {
      await drv2.hello()
      const second = await drv2.call('sweep', {})
      assert.equal(second.value.no_changes, true)
    } finally {
      drv2.close()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
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
  const drv = startService({ memory })
  try {
    await drv.hello()
    const result = await drv.call('sweep', { l2_capacity: 2 })
    assert.deepEqual(drv.shortMemory.memory.workspaces['w-1'].summary.facts, ['b', 'c'])
    assert.deepEqual(result.value.l2_trimmed, [{ workspace: 'w-1', removed: 1 }])
  } finally {
    drv.close()
  }
})

test('sweep：水位之后的条目才扫描（游标增量）', async () => {
  const drv = startService({
    memory: { version: 1, sessions: {}, workspaces: {} },
    entries: [memoryEntry({ id: 'm-1', text: 'x', weight: 0.1, at: '2023-01-01T00:00:00.000Z' })],
  })
  try {
    await drv.hello()
    const result = await drv.call('sweep', { cursor: '2023-06-01T00:00:00.000Z' })
    assert.equal(result.value.no_changes, true)
  } finally {
    drv.close()
  }
})

test('candidates：只读回候选、不产写、不删', async () => {
  const drv = startService({
    memory: {
      version: 1,
      sessions: shortMemoryFixture().sessions,
      workspaces: { 'w-1': { summary: { goal: '', facts: ['a', 'b', 'c'], decisions: [], open_questions: [], files: [] }, sources: [], at: AT } },
    },
    entries: [memoryEntry({ id: 'm-1', text: 'x', weight: 0.1 })],
  })
  try {
    await drv.hello()
    const result = await drv.call('candidates', { l2_capacity: 2 })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.$directives, undefined)
    const reasons = result.value.candidates.map((item) => item.reason).sort()
    assert.deepEqual(reasons, ['l1_expired', 'l1_expired', 'l2_over_capacity', 'low_weight'])
    assert.equal(drv.memory.entries.length, 1)
  } finally {
    drv.close()
  }
})

test('view：L1/L2/L3 三档字段齐全（含剩余 TTL 与条目字段）', async () => {
  const drv = startService({
    memory: shortMemoryFixture(),
    entries: [memoryEntry({ id: 'm-1', text: 't', weight: 0.5, tags: ['tag-a'] })],
  })
  try {
    await drv.hello()
    const result = await drv.call('view', {})
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

test('edit：delete / pin / text 三种动作写 owner 服务', async () => {
  const drv = startService({ entries: [memoryEntry({ id: 'm-1', text: 'old' })] })
  try {
    await drv.hello()
    const deleted = await drv.call('edit', { action: 'delete', layer: 'l3', id: 'm-1' })
    assert.equal(deleted.value.ok, true)
    assert.deepEqual(drv.memory.entries, [])

    const drv2 = startService({ entries: [memoryEntry({ id: 'm-1', text: 'old' })] })
    try {
      await drv2.hello()
      const pinned = await drv2.call('edit', { action: 'pin', layer: 'l3', id: 'm-1' })
      assert.equal(pinned.value.pinned, true)
      assert.equal(drv2.memory.pinned['m-1'], true)
      const unpinned = await drv2.call('edit', { action: 'pin', layer: 'l3', id: 'm-1', patch: { pinned: false } })
      assert.equal(unpinned.value.pinned, false)
      assert.equal(drv2.memory.pinned['m-1'], undefined)
      const edited = await drv2.call('edit', { action: 'text', layer: 'l3', id: 'm-1', patch: { text: 'new' } })
      assert.equal(edited.value.ok, true)
      assert.equal(drv2.memory.entries[0].text, 'new')
    } finally {
      drv2.close()
    }
  } finally {
    drv.close()
  }
})

test('edit：L1 删除写 short-memory；L2 置顶不支持；非法参数 bad_args', async () => {
  const drv = startService({ memory: shortMemoryFixture() })
  try {
    await drv.hello()
    const deleted = await drv.call('edit', { action: 'delete', layer: 'l1', id: 'c-1' })
    assert.equal(deleted.value.ok, true)
    assert.equal(drv.shortMemory.memory.sessions['c-1'], undefined)
    assert.equal(drv.shortMemory.memory.sessions['c-2'] !== undefined, true)

    const unsupported = await drv.call('edit', { action: 'pin', layer: 'l2', id: 'w-1' })
    assert.equal(unsupported.value.reason, 'unsupported_layer')

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
