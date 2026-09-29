// 水合器级测试：命中 / 闭包展开 / fail-closed / 去重上限 64 / 对象与非数组短路 / 身份隔离（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LIMITS, DefUnavailableError, RefHydrator } from '../execute/hydrate.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

test('hydrate：宿主回 missing → 抛 DefUnavailableError（code / hashes / message）', async () => {
  const hydrator = new RefHydrator(async () => ({ defs: {}, missing: [HASH_A], denied: [] }))
  await assert.rejects(
    () => hydrator.hydrate('evolution', [HASH_A]),
    (err) => {
      assert.ok(err instanceof DefUnavailableError)
      assert.equal(err.code, 'def_unavailable')
      assert.deepEqual(err.hashes, [HASH_A])
      assert.equal(err.message, `def unavailable: ${HASH_A}`)
      return true
    },
  )
})

test('hydrate：宿主回 denied / 传输失败 → 同样 def_unavailable', async () => {
  const denied = new RefHydrator(async () => ({ defs: {}, missing: [], denied: [HASH_A] }))
  await assert.rejects(
    () => denied.hydrate('session', [HASH_A]),
    (err) => err.code === 'def_unavailable',
  )
  const failed = new RefHydrator(async () => null)
  await assert.rejects(
    () => failed.hydrate('session', [HASH_A]),
    (err) => err.code === 'def_unavailable',
  )
})

test('hydrate：去重后不可用上限 64；limits 可下调', async () => {
  const hashes = Array.from({ length: 70 }, (_, index) => index.toString(16).padStart(64, '0'))
  const hydrator = new RefHydrator(async () => ({ defs: {}, missing: [], denied: hashes }))
  await assert.rejects(
    () => hydrator.hydrate('evolution', [...hashes, hashes[0]]),
    (err) => {
      assert.ok(err instanceof DefUnavailableError)
      assert.equal(err.hashes.length, 64, '不可用哈希去重且截断到 64')
      assert.equal(new Set(err.hashes).size, 64)
      return true
    },
  )
  await assert.rejects(
    () => hydrator.hydrate('evolution', hashes, { ...DEFAULT_LIMITS, maxUnavailable: 2 }),
    (err) => {
      assert.equal(err.hashes.length, 2)
      return true
    },
  )
})

test('hydrate：refs 已是对象 / 非数组原样返回，不抛、不外呼', async () => {
  let reads = 0
  const hydrator = new RefHydrator(async () => {
    reads += 1
    return null
  })
  const closure = { [HASH_A]: { kind: 'trace' } }
  assert.deepEqual(await hydrator.hydrate('evolution', closure), closure)
  assert.deepEqual(await hydrator.hydrate('evolution', null), {})
  assert.deepEqual(await hydrator.hydrate('evolution', 'not-a-list'), {})
  assert.equal(reads, 0)
})

test('hydrate：逐跳全部取回则返回完整闭包', async () => {
  const entry = { kind: 'trace', prev: { def: HASH_B } }
  const hydrator = new RefHydrator(async (identity, hashes) => ({
    defs: Object.fromEntries(
      hashes.map((hash) => [hash, hash === HASH_A ? entry : { kind: 'trace', prev: null }]),
    ),
  }))
  const out = await hydrator.hydrate('evolution', [HASH_A])
  assert.deepEqual(out, { [HASH_A]: entry, [HASH_B]: { kind: 'trace', prev: null } })
})

test('hydrate：缓存按身份隔离，A 取回的 body 不泄漏给 B 且 B 重读', async () => {
  let reads = 0
  const hydrator = new RefHydrator(async (identity, hashes) => {
    reads += 1
    if (identity === 'a') return { defs: { [HASH_A]: { id: 'x' } } }
    return { defs: {}, missing: hashes, denied: [] }
  })
  assert.deepEqual(await hydrator.hydrate('a', [HASH_A]), { [HASH_A]: { id: 'x' } })
  await assert.rejects(
    () => hydrator.hydrate('b', [HASH_A]),
    (err) => err.code === 'def_unavailable',
  )
  assert.equal(reads, 2, '不同身份不得命中同一缓存键')
})
