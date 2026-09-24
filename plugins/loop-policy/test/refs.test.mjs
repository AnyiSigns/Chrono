// 引用解析（refs）契约：宿主 `def.read` 对部分哈希回 missing / denied 时 fail-closed。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'
import { createRefHydrator, DefUnavailableError } from '../execute/refs.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

test('hydrate：宿主回 missing → 抛 DefUnavailableError（code / hashes）', async () => {
  const hydrator = createRefHydrator(async () => ({ defs: {}, missing: [HASH_A], denied: [] }))
  await assert.rejects(
    () => hydrator.hydrate('evolution', [HASH_A]),
    (err) => {
      assert.ok(err instanceof DefUnavailableError)
      assert.equal(err.code, 'def_unavailable')
      assert.deepEqual(err.hashes, [HASH_A])
      return true
    },
  )
})

test('hydrate：宿主回 denied → 抛 DefUnavailableError；去重后上限 64', async () => {
  const hashes = Array.from({ length: 70 }, (_, index) => index.toString(16).padStart(64, '0'))
  const hydrator = createRefHydrator(async () => ({ defs: {}, missing: [], denied: hashes }))
  await assert.rejects(
    () => hydrator.hydrate('evolution', [...hashes, hashes[0]]),
    (err) => {
      assert.ok(err instanceof DefUnavailableError)
      assert.equal(err.hashes.length, 64, '不可用哈希去重且截断到 64')
      assert.equal(new Set(err.hashes).size, 64)
      return true
    },
  )
})

test('hydrate：refs 已是对象 / 非数组原样返回，不抛', async () => {
  const hydrator = createRefHydrator(async () => null)
  const closure = { [HASH_A]: { kind: 'trace' } }
  assert.deepEqual(await hydrator.hydrate('evolution', closure), closure)
  assert.deepEqual(await hydrator.hydrate('evolution', null), {})
  assert.deepEqual(await hydrator.hydrate('evolution', 'not-a-list'), {})
})

test('hydrate：逐跳全部取回则返回完整闭包', async () => {
  const entry = { kind: 'trace', prev: { def: HASH_B } }
  const hydrator = createRefHydrator(async (identity, hashes) => ({
    defs: Object.fromEntries(hashes.map((hash) => [hash, hash === HASH_A ? entry : { kind: 'trace', prev: null }])),
  }))
  const out = await hydrator.hydrate('evolution', [HASH_A])
  assert.deepEqual(out, { [HASH_A]: entry, [HASH_B]: { kind: 'trace', prev: null } })
})

test('服务调用：refs 不可用 → def_unavailable 错误帧（非 internal）', async () => {
  const service = startService({
    providers: {
      'host.def.read': () => ({ defs: {}, missing: [HASH_A], denied: [] }),
    },
  })
  try {
    const result = await service.interpret({
      evolution: {
        version: 1,
        trace: { tail: null, count: 0 },
        evidence: { tail: null, count: 0 },
        proposals: { tail: null, count: 0 },
        verdicts: { tail: null, count: 0 },
        refs: [HASH_A],
      },
    })
    assert.equal(result.kind, 'error', JSON.stringify(result))
    assert.equal(result.code, 'def_unavailable')
  } finally {
    service.close()
  }
})
