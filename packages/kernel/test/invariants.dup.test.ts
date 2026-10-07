// T5 全 put 批 dup 短路的计数桩与边界验收（invariants.gates.test.ts 的按点扩展新段；§14-14 计数桩
// 三条路之一——模块 mock 透传计数，本文件自带桩头）。只打公共面 ./index.ts。
// 计数口径（§14-14 / §10.5 本轮新增 4）：载荷规范化按 canonicalJson 计；
// entryHash 类小定长 map 不进载荷账、单列常数。段外两笔 = 批聚合 1 + outerPos 1（常数），
// 于是"2N → N"断成：走段 2 的载荷账 2N+1 → 短路的 N+1，entryHash 2 → 1。
import { afterEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({ canon: 0, entryHash: 0 }))

vi.mock('../value.ts', async (importOriginal) => {
  const o = (await importOriginal()) as Record<string, unknown>
  const inner = o.canonicalJson as (v: unknown) => string
  // positionMap 判定与 invariants.gates 桩同口径：位置哈希吃固定字段小 map，按常数记账
  const positionMap = (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const keys = Object.keys(v as Record<string, unknown>)
    const fixed = ['at', 'seq', 'prev', 'op', 'argsHash', 'by', 'ref']
    return keys.length > 0 && keys.every((k) => fixed.includes(k)) && keys.includes('argsHash')
  }
  return {
    ...o,
    canonicalJson: (v: unknown): string => {
      if (positionMap(v)) stubs.entryHash += 1
      else stubs.canon += 1
      return inner(v)
    },
  }
})

import { EMPTY_WORLD, H, cloneWorld, commit } from '../index.ts'
import type { Entry, Hash, Json, Op, World, WriteRequest } from '../index.ts'

const NOW = 313_370
const J = (v: unknown): Json => v as Json
type Head = Parameters<typeof commit>[0]
const snap = (v: unknown): string => JSON.stringify(v)
const req = (id: string, op: Op, args: Json, pos: Hash | null): WriteRequest =>
  ({ id, op, target: { expect_pos: pos }, args, by: 'dup-tester' }) as unknown as WriteRequest
const bodyOf = (tag: string): Json => ({ body: { tag } })
const keyOf = (tag: string): Hash => H(bodyOf(tag))
const subPut = (tag: string): Json => J({ op: 'put', args: bodyOf(tag) })
const subNote = (payload: Json): Json => J({ op: 'note', args: payload })
const batchArgs = (ops: Json[]): Json => J({ ops })

function emptyWorld(): World {
  return cloneWorld(EMPTY_WORLD)
}
const emptyHead = (): Head => ({ seq: -1, hash: null })

function link(head: Head, world: World, r: WriteRequest): { head: Head; entry: Entry } {
  const out = commit(head, world, r, NOW)
  if (!out.verdict.ok || out.entry === null) {
    throw new Error('seed commit refused: ' + out.verdict.reasons.join(','))
  }
  return { head: { seq: out.entry.seq, hash: out.hash as Hash }, entry: out.entry }
}

/** 把 n 条 def 逐个 put 入世（基线世界；测量前另行归零计数）。 */
function seedPuts(n: number): { world: World; head: Head; tags: string[] } {
  const world = emptyWorld()
  let head = emptyHead()
  const tags: string[] = []
  for (let k = 0; k < n; k++) {
    const tag = 'dup-' + k
    tags.push(tag)
    head = link(head, world, req('seed-' + k, 'put', bodyOf(tag), head.hash)).head
  }
  return { world, head, tags }
}

afterEach(() => {
  stubs.canon = 0
  stubs.entryHash = 0
})

describe('计数桩（段外两笔算常数）：短路把载荷账 2N+1 砍到 N+1、entryHash 2 砍到 1', () => {
  const N = 3
  it('全 put 全已知批：段 1 预哈希后定论——canon 恰 N+1、entryHash 恰 1（outerPos）', () => {
    const { world, head, tags } = seedPuts(N)
    const before = snap(world)
    stubs.canon = 0
    stubs.entryHash = 0
    const out = commit(
      head,
      world,
      req('dup-batch', 'batch', batchArgs(tags.map(subPut)), head.hash),
      NOW,
    )
    // 判决 = "跳过段 2" 的 dup 定论：不产 entry、pos 不动、written 空
    expect(out.verdict).toEqual({ ok: true, reasons: ['dup'], pos: head.hash, written: [] })
    expect([out.entry, out.hash]).toEqual([null, null])
    expect(stubs.canon).toBe(N + 1) // 只付段 1：每子一次 H(Def) + 批聚合一次；段 2 一趟为零
    expect(stubs.entryHash).toBe(1) // 仅 batchDigest 的 outerPos
    expect(snap(world)).toBe(before) // 短路不动世界、undo 无事可做
  })

  it('对照：同一 N、末子是新键的批走段 2 → 载荷账 2N+1、entryHash 2（outerPos + 回填位）', () => {
    const { world, head, tags } = seedPuts(N - 1)
    const fresher = 'dup-fresh-one'
    tags.push(fresher)
    const freshKey = keyOf(fresher) // 预计算在本测量窗口之外（H 也吃 canonicalJson 记账）
    stubs.canon = 0
    stubs.entryHash = 0
    const out = commit(
      head,
      world,
      req('mix-batch', 'batch', batchArgs(tags.map(subPut)), head.hash),
      NOW,
    )
    expect(out.hash).not.toBeNull()
    expect(out.verdict).toEqual({
      ok: true,
      reasons: [],
      pos: out.hash,
      written: [freshKey],
    })
    expect(out.entry).not.toBeNull()
    expect(stubs.canon).toBe(2 * N + 1) // 段 1 N 次 + 段 2 每子步①再 N 次 + 聚合 1 次
    expect(stubs.entryHash).toBe(2)
    expect(Object.keys(world.defs).length).toBe(N)
  })

  it('短路零痕迹：dup 批过后的下一条写入与"没发生过 dup"的世界/链位置逐字节一致（双世界对照）', () => {
    const build = (withDup: boolean): { tail: string; world: string; prevUnchanged: boolean } => {
      const s = seedPuts(N)
      if (withDup) {
        const d = commit(
          s.head,
          s.world,
          req('dup-then', 'batch', batchArgs(s.tags.map(subPut)), s.head.hash),
          NOW,
        )
        expect([d.verdict.reasons, d.entry]).toEqual([['dup'], null])
      }
      const next = link(s.head, s.world, req('after', 'put', bodyOf('after'), s.head.hash)).entry
      return { tail: snap(next), world: snap(s.world), prevUnchanged: next.prev === s.head.hash }
    }
    const withDup = build(true)
    const without = build(false)
    expect([withDup.tail, withDup.world, withDup.prevUnchanged]).toEqual([
      without.tail,
      without.world,
      true,
    ]) // 短路在链上不留任何可观测痕迹
  })
})

describe('边界（§10.3 短路句写死）：非全 put 不短路、同批内部自重不短路、嵌套批经段 2 得同一判决', () => {
  it('含 note 的混合批（子 put 全命中）不短路：照常产 entry、非 dup、written 空', () => {
    const { world, head, tags } = seedPuts(2)
    const args = batchArgs([...tags.map(subPut), subNote(J({ after: true }))])
    stubs.canon = 0
    stubs.entryHash = 0
    const out = commit(head, world, req('note-batch', 'batch', args, head.hash), NOW)
    expect([out.verdict.ok, out.verdict.reasons, out.verdict.written, out.entry === null]).toEqual([
      true,
      [],
      [], // 子 put 全部 noop：本批无新写入——但 note 令 isNoop 恒 false，dup 不沾身
      false,
    ])
    expect(stubs.canon).toBe(2 * 3 + 1) // 3 子 × 两段 + 聚合：与上例"走段 2"同账（不短路的代价）
    expect(stubs.entryHash).toBe(2)
  })

  it('同批内部自重（键不在 defs、靠本批第一个 put 才存在）不短路：isNoop=false、written 单键；重提同批才 dup', () => {
    const world = emptyWorld()
    let head = emptyHead()
    head = link(head, world, req('noop-seed', 'note', J({ first: true }), head.hash)).head // 非零 seq 上验短路
    const args = batchArgs([subPut('intra-self'), subPut('intra-self')]) // 段 1 两哈希同键，进场都不在 defs
    const first = commit(head, world, req('intra-1', 'batch', args, head.hash), NOW)
    expect([
      first.verdict.ok,
      first.verdict.reasons,
      first.verdict.written,
      first.entry === null,
    ]).toEqual([true, [], [keyOf('intra-self')], false]) // 短路与段 2 语义等价的最锋利反例：every() 查的是进场前状态
    expect(Object.keys(world.defs).length).toBe(1)
    head = { seq: (first.entry as Entry).seq, hash: first.hash as Hash }
    stubs.canon = 0
    stubs.entryHash = 0
    const second = commit(head, world, req('intra-2', 'batch', args, head.hash), NOW)
    expect(second.verdict).toEqual({ ok: true, reasons: ['dup'], pos: head.hash, written: [] })
    expect([second.entry, second.hash]).toEqual([null, null])
    expect(stubs.canon).toBe(2 + 1) // 此时 every 全真：段 1 (N=2) + 聚合
    expect(stubs.entryHash).toBe(1)
  })

  it('嵌套全 put 已知批：外层 every 触到 batch 子 ⇒ 走段 2；dup 定论与段 2 一致——与扁平短路同形', () => {
    const { world, head, tags } = seedPuts(2)
    const before = snap(world)
    const inner = J({ op: 'batch', args: batchArgs(tags.map(subPut)) })
    const vFlat = commit(
      head,
      world,
      req('flat', 'batch', batchArgs(tags.map(subPut)), head.hash),
      NOW,
    )
    const vNest = commit(head, world, req('nested', 'batch', batchArgs([inner]), head.hash), NOW)
    // vNest 是"同一语义批走段 2"的定论：判决与 vFlat（短路）逐字段一致、同样无 entry——
    // 这就是 §10.3 "短路不改任何形态"的公共面证据（嵌套令外层无法短路、段 2 内层才短路）。
    expect([vNest.verdict, vNest.entry, vNest.hash]).toEqual([vFlat.verdict, null, null])
    expect(vNest.verdict).toEqual({ ok: true, reasons: ['dup'], pos: head.hash, written: [] })
    expect(snap(world)).toBe(before)
  })

  it('空批在 every() 下平凡成立：定论与段 2 空转相同（dup、entry=null、账仅聚合一笔）', () => {
    const { world, head } = seedPuts(1)
    stubs.canon = 0
    stubs.entryHash = 0
    const out = commit(head, world, req('empty', 'batch', batchArgs([]), head.hash), NOW)
    expect(out.verdict).toEqual({ ok: true, reasons: ['dup'], pos: head.hash, written: [] })
    expect([out.entry, out.hash, Object.keys(world.defs).length]).toEqual([null, null, 1])
    expect(stubs.canon).toBe(1) // 0 子：仅批聚合一次
    expect(stubs.entryHash).toBe(1) // outerPos
  })
})
