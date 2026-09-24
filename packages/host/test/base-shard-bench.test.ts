// 分片落盘 + 按需加载的量化对比（小基准）：
// 同一世界分别写 v1 单文件（body 内联）与 v2 分片（索引 + body 分片），对比读基础世界的耗时、
// 常驻 body 字节与读盘次数。两种规模：多小 def（索引/常驻收益）与大 body（解析收益）。
// 数值随机器而变，只作量级参照；断言取宽松结构性质。

import { describe, expect, it, afterEach } from 'vitest'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { H, worldRev } from '../../kernel/index.ts'
import type { Def, Hash, Json, World } from '../../kernel/index.ts'
import { readBase, writeBase } from '../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'

function buildWorld(count: number, pad: number): World {
  const defs: Record<Hash, Def> = {}
  for (let i = 0; i < count; i++) {
    const body: Json = { kind: 'bench', i, text: 'x'.repeat(pad) }
    const def: Def = { body }
    defs[H(def as unknown as Json)] = def
  }
  return { defs, ids: {} }
}

function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc === 'function') gc()
}

function heap(): number {
  forceGc()
  return process.memoryUsage().heapUsed
}

/** 多轮读同一文件，返回均耗时（毫秒）。 */
function meanRead(fn: () => void, rounds = 5): number {
  fn() // 预热
  let total = 0
  for (let i = 0; i < rounds; i++) {
    const begin = performance.now()
    fn()
    total += performance.now() - begin
  }
  return total / rounds
}

/** 读一次并测常驻堆增量（读前强制 GC；返回后世界不再被引用）。 */
function measure(file: string, rev: Hash): { ms: number; heap: number } {
  const before = heap()
  const begin = performance.now()
  const base = readBase(file)!
  const ms = performance.now() - begin
  const delta = heap() - before
  if (worldRev(base.world) !== rev) throw new Error('rev mismatch')
  return { ms, heap: delta }
}

function prepare(
  count: number,
  pad: number,
): {
  root: string
  rev: Hash
  world: World
  v1File: string
  v2File: string
} {
  const root = createTempRoot()
  const world = buildWorld(count, pad)
  const rev = worldRev(world)
  const snapshot = { seq: count, hash: 'c'.repeat(64) }
  const v2File = join(root, 'state', 'world', 'base.json')
  writeBase(v2File, { snapshot, world })
  const v1File = join(root, 'state', 'world', 'base-v1.json')
  writeFileSync(v1File, JSON.stringify({ v: 1, snapshot, worldRev: rev, snapshotRev: rev, world }))
  return { root, rev, world, v1File, v2File }
}

function log(
  label: string,
  count: number,
  pad: number,
  v1: { ms: number; heap: number },
  v2: { ms: number; heap: number },
  v1Bytes: number,
  v2Bytes: number,
  extra: string,
): void {
  console.log(
    `[shard-bench:${label}] defs=${count} pad=${pad}B v1=${(v1Bytes / 1024).toFixed(0)}KiB 读=${v1.ms.toFixed(1)}ms 常驻Δ=${(v1.heap / 1024).toFixed(0)}KiB | ` +
      `v2 索引=${(v2Bytes / 1024).toFixed(1)}KiB 读=${v2.ms.toFixed(1)}ms 常驻Δ=${(v2.heap / 1024).toFixed(0)}KiB${extra}`,
  )
}

describe('基础世界分片量化对比（v1 内联 vs v2 分片）', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTempRoot(root)
  })

  it('多小 def（1200×1KiB）：索引远小于内联，body 零常驻、零读盘', () => {
    const { root, rev, world, v1File, v2File } = prepare(1200, 1024)
    roots.push(root)
    const v1Bytes = statSync(v1File).size
    const v2Bytes = statSync(v2File).size

    const v1Ms = meanRead(() => {
      expect(worldRev(readBase(v1File)!.world)).toBe(rev)
    })
    const v2Ms = meanRead(() => {
      const base = readBase(v2File)!
      expect(worldRev(base.world)).toBe(rev)
      expect(base.store!.stats.loads).toBe(0)
    })
    const v1 = measure(v1File, rev)
    const v2 = measure(v2File, rev)
    expect(v2Bytes).toBeLessThan(v1Bytes / 8)

    const base = readBase(v2File)!
    expect(base.store!.cached()).toBe(0)
    const key = Object.keys(world.defs)[0] as Hash
    const firstStart = performance.now()
    expect(base.world.defs[key]).toEqual(world.defs[key])
    const firstMs = performance.now() - firstStart
    expect(base.store!.stats.loads).toBe(1)

    log(
      'many',
      1200,
      1024,
      { ms: v1Ms, heap: v1.heap },
      { ms: v2Ms, heap: v2.heap },
      v1Bytes,
      v2Bytes,
      ` 首次取def=${firstMs.toFixed(2)}ms`,
    )
  })

  it('大 body（48×64KiB）：解析收益明显，读索引不常驻 body', () => {
    const { root, rev, v1File, v2File } = prepare(48, 64 * 1024)
    roots.push(root)
    const v1Bytes = statSync(v1File).size
    const v2Bytes = statSync(v2File).size

    const v1Ms = meanRead(() => {
      expect(worldRev(readBase(v1File)!.world)).toBe(rev)
    })
    const v2Ms = meanRead(() => {
      const base = readBase(v2File)!
      expect(worldRev(base.world)).toBe(rev)
      expect(base.store!.stats.loads).toBe(0)
    })
    const v1 = measure(v1File, rev)
    const v2 = measure(v2File, rev)
    expect(v2Bytes).toBeLessThan(v1Bytes / 8)
    // 读索引不常驻 body：以 store 缓存为结构证据；有 --expose-gc 时再断言堆增量
    const gcAvailable = typeof (globalThis as { gc?: unknown }).gc === 'function'
    if (gcAvailable) expect(v2.heap).toBeLessThan(256 * 1024)

    log(
      'large',
      48,
      64 * 1024,
      { ms: v1Ms, heap: v1.heap },
      { ms: v2Ms, heap: v2.heap },
      v1Bytes,
      v2Bytes,
      '',
    )
  })
})
