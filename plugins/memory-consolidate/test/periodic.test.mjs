// 周期派发链路测试：`schema.periodic` 声明的 reads 能把数据世代 body 里的派发策略注入 args，
// 使 consolidate 的 `summarize` 不再是恒 false —— 周期路径到 `compress.summarize` 的链路不再死。
// reads 的 `{bag 键: 投影字面路径}` 注入规则由宿主 `buildPeriodicBag` 实现；此处按同规则解析声明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService, shortMemoryFixture } from './driver.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(rel) {
  return JSON.parse(readFileSync(join(PKG_ROOT, rel), 'utf8'))
}

/** 按 `{bag 键: 投影字面路径}` 从投影取片段（与宿主 buildPeriodicBag 同规则）。 */
function buildBag(projection, reads) {
  const keys = Object.keys(reads)
  if (keys.length === 0) return null
  const bag = {}
  for (const [key, path] of Object.entries(reads)) {
    let current = projection
    for (const segment of path) current = current[segment] ?? null
    bag[key] = current
  }
  return bag
}

function entryOf(schema, method) {
  const entry = schema.periodic.find((item) => item.method === method)
  assert.ok(entry !== undefined, `schema.periodic 缺 ${method}`)
  return entry
}

test('periodic.consolidate：reads 注入 summarize（数据世代策略 → 非空 bag）', () => {
  const schema = readJson('schema/memory-maintenance.json')
  const entry = entryOf(schema, 'consolidate')
  assert.deepEqual(entry.reads, {
    summarize: ['ids', 'memory-consolidate', 'body', 'consolidate', 'summarize'],
  })
  const body = readJson('tools/default-body.json')
  const bag = buildBag({ ids: { 'memory-consolidate': { body } } }, entry.reads)
  assert.notEqual(bag, null, '有 reads 时 bag 不得为 null')
  assert.equal(bag.summarize, true)
})

test('periodic.sweep：reads 注入阈值覆盖（非空 bag）', () => {
  const schema = readJson('schema/memory-maintenance.json')
  const entry = entryOf(schema, 'sweep')
  assert.deepEqual(Object.keys(entry.reads).sort(), [
    'candidate_threshold',
    'l1_ttl_ms',
    'l2_capacity',
    'l3_capacity',
  ])
  const body = readJson('tools/default-body.json')
  const bag = buildBag({ ids: { 'memory-consolidate': { body } } }, entry.reads)
  assert.notEqual(bag, null)
  assert.equal(bag.l1_ttl_ms, body.sweep.l1_ttl_ms)
  assert.equal(bag.l2_capacity, body.sweep.l2_capacity)
  assert.equal(bag.l3_capacity, body.sweep.l3_capacity)
  assert.equal(bag.candidate_threshold, body.sweep.candidate_threshold)
})

test('periodic 的 method_timeouts 保持声明（consolidate > compress.summarize + memory-store，sweep > memory-store）', () => {
  const schema = readJson('schema/memory-maintenance.json')
  const compress = readJson('../compress/schema/compress.json')
  const memory = readJson('../memory-store/schema/memory.json')
  const storeCeiling = Math.max(...Object.values(memory.method_timeouts))
  assert.equal(schema.method_timeouts['memory-maintenance.consolidate'], 4800000)
  assert.equal(schema.method_timeouts['memory-maintenance.sweep'], 900000)
  assert.ok(
    schema.method_timeouts['memory-maintenance.consolidate'] >
      compress.method_timeouts['compress.summarize'] + storeCeiling,
    'consolidate 必须大于 compress.summarize 与 memory-store 之和',
  )
  assert.ok(
    schema.method_timeouts['memory-maintenance.sweep'] > storeCeiling,
    'sweep 必须大于 memory-store',
  )
})

test('周期 bag 直达 compress.summarize：summarize 可被真正触发', async () => {
  const schema = readJson('schema/memory-maintenance.json')
  const body = readJson('tools/default-body.json')
  const bag = buildBag(
    { ids: { 'memory-consolidate': { body } } },
    entryOf(schema, 'consolidate').reads,
  )

  const drv = startService({ memory: shortMemoryFixture() })
  try {
    await drv.hello()
    const result = await drv.call('consolidate', { ...bag, weight_threshold: 1 })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.equal(result.value.ok, true)
    assert.equal(result.value.summary_used, true)
    const call = drv.portCalls.find(
      (item) => item.port === 'compress' && item.method === 'summarize',
    )
    assert.ok(call !== undefined, 'summarize=true 时应反向调 compress.summarize')
    assert.equal(call.args.persist, false)
    assert.equal(call.args.mode, 'algorithmic')
  } finally {
    drv.close()
  }
})
