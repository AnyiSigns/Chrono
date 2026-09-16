// 两个身份与常量、worldRev 摘要口径、replay/verify、归档锚点、深冻结桩与固定种子随机链（journal.b）。
// 公共面仅 ./index.ts。

import { describe, expect, it } from 'vitest'
import type { Def, Entry, Hash, Head, Json, Op, World } from './index.ts'
import {
  EMPTY_HEAD,
  EMPTY_WORLD,
  H,
  anchorAfter,
  applyEntry,
  cloneWorld,
  entryHash,
  pos,
  replay,
  verify,
  worldRev,
} from './index.ts'

type Outcome = ReturnType<typeof applyEntry>

function mkEntry(seq: number, prev: Hash | null, op: Op, args: Json): Entry {
  return { seq, prev, op, args, argsHash: '', by: 'u', at: 1000 + seq }
}

function asOk(r: Outcome) {
  if (!r.ok) throw new Error('期望 ok:true，实为 ' + r.error)
  return r
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    const c = (err as { code?: unknown }).code // KernelError 不断言类型，只契约 code
    return typeof c === 'string' ? c : '<非 KernelError>'
  }
  return '<不抛>'
}

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

type Harness = {
  w: World
  journal: Entry[]
  readonly head: Head
  push(op: Op, args: Json): Entry
}

function harness(): Harness {
  const w = cloneWorld(EMPTY_WORLD)
  const journal: Entry[] = []
  let head: Head = { ...EMPTY_HEAD }
  return {
    w,
    journal,
    get head() {
      return head
    },
    push(op: Op, args: Json): Entry {
      const e = mkEntry(head.seq + 1, head.hash, op, args)
      const r = applyEntry(w, e)
      if (!r.ok) throw new Error('b.harness 只用于成功链: ' + r.error)
      e.argsHash = r.argsHash // 测试扮演 commit 回填
      if (!r.isNoop) {
        journal.push(e)
        head = { seq: e.seq, hash: entryHash(e) }
      }
      return e
    },
  }
}

/** 一条含 put/add_identity/add_gen/batch($n)/fork/graft/note/snapshot/retire 的混合链。 */
function mixedChain(): Harness {
  const h = harness()
  const schemaDef = h.push('put', { body: { sch: 1 } })
  const firstPayload = h.push('put', { body: { g: 1 } })
  const secondPayload = h.push('put', { body: { g: 2 } })
  h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
  h.push('add_gen', {
    id: 'u1',
    payload: firstPayload.argsHash,
    pins: { k: secondPayload.argsHash },
    sig: schemaDef.argsHash,
  })
  h.push('batch', {
    ops: [
      { op: 'add_identity', args: { id: 'u2', schema: schemaDef.argsHash } },
      { op: 'put', args: { body: { g: 3 } } },
      { op: 'add_gen', args: { id: 'u2', payload: { $n: 1 }, pins: {}, sig: schemaDef.argsHash } },
    ],
  })
  h.push('fork', { id: 'u3', schema: schemaDef.argsHash, parent: 'u1' })
  h.push('graft', {
    id: 'u3',
    payload: secondPayload.argsHash,
    pins: {},
    sig: schemaDef.argsHash,
    from: 'u1',
    gen: 0,
  })
  h.push('note', { audit: 1 })
  h.push('snapshot', { world_rev: worldRev(h.w) })
  h.push('retire', { id: 'u1' })
  return h
}

function deepFreeze<T>(v: T): T {
  for (const child of Object.values(v as Record<string, unknown>)) {
    if (child !== null && typeof child === 'object') deepFreeze(child)
  }
  return Object.freeze(v)
}

describe('两个身份与常量', () => {
  it('EMPTY_HEAD/EMPTY_WORLD 口径 + pos([]) = null = EMPTY_HEAD.hash', () => {
    expect(EMPTY_HEAD).toEqual({ seq: -1, hash: null })
    expect(pos([])).toBeNull()
    expect(pos([])).toBe(EMPTY_HEAD.hash)
    expect(Object.isFrozen(EMPTY_WORLD)).toBe(true)
    expect(Object.isFrozen(EMPTY_WORLD.defs)).toBe(true)
    expect(Object.isFrozen(EMPTY_WORLD.ids)).toBe(true)
    const h = harness()
    const putEntry = h.push('put', { body: { p: 1 } })
    expect(pos(h.journal)).toBe(entryHash(putEntry))
    const addIdEntry = h.push('add_identity', { id: 'alpha', schema: putEntry.argsHash })
    expect(pos(h.journal)).toBe(entryHash(addIdEntry)) // 链位置 = 末条 entryHash
    expect(h.head.hash).toBe(pos(h.journal))
    for (let i = 1; i < h.journal.length; i++) {
      expect(h.journal[i].prev).toBe(entryHash(h.journal[i - 1])) // prev 接的是真实 entryHash
    }
  })

  it('worldRev(EMPTY_WORLD) 稳定且 = H({keys:[], ids:{}})；keys 升序与插入序无关', () => {
    expect(worldRev(EMPTY_WORLD)).toBe(worldRev(EMPTY_WORLD))
    expect(worldRev(EMPTY_WORLD)).toBe(H({ keys: [], ids: {} }))
    const defA: Json = { body: 1 } // Def 与 Json 名义不互配（无索引签名），入 defs 时同 put 口径 cast
    const defB: Json = { body: 2 }
    const keyA = H(defA)
    const keyB = H(defB)
    const worldA = emptyWorld()
    const worldB = emptyWorld()
    worldA.defs[keyA] = defA as unknown as Def
    worldA.defs[keyB] = defB as unknown as Def
    worldB.defs[keyB] = defB as unknown as Def
    worldB.defs[keyA] = defA as unknown as Def
    expect(worldRev(worldA)).toBe(worldRev(worldB))
    expect(keyA === keyB).toBe(false)
  })

  it('worldRev 摘要不吃 born/adopted 履历、吃 active：构造例', () => {
    const h = mixedChain()
    const origRev = worldRev(h.w)
    const historyVariant = cloneWorld(EMPTY_WORLD)
    const refHash = Object.keys(h.w.defs)[0]
    for (const e of h.journal) {
      const rewritten: Entry = { ...e, at: e.at + 7777, by: 'v', ref: refHash as Hash }
      const r = applyEntry(historyVariant, rewritten)
      if (!r.ok) throw new Error('履历改写不该影响 apply: ' + r.error)
      // at/by/ref 全变 ⇒ born、adopted.write、entryHash 全不同（三字段进 entryHash）
    }
    expect(worldRev(historyVariant)).toBe(origRev) // 同内容同 active：历史不同而摘要相等（pin 不漂移）
    expect(JSON.stringify(historyVariant)).not.toBe(JSON.stringify(h.w)) // 但履历确实不同（世界不等）
    historyVariant.ids.u2.active = '0'.repeat(64) // u2.active 由 add_gen 置为某 def 键，改成别的即换摘要
    expect(worldRev(historyVariant)).not.toBe(origRev) // active 要吃：换 active = 换世界状态
  })

  it('cloneWorld：只复制会被就地改写的层；Def/Gen 元素按不可变共享', () => {
    const baseWorld = cloneWorld(EMPTY_WORLD)
    expect(JSON.stringify(baseWorld)).toBe(JSON.stringify({ defs: {}, ids: {} }))
    asOk(applyEntry(baseWorld, mkEntry(0, null, 'put', { body: { c: 1 } })))
    const storedDef = baseWorld.defs[Object.keys(baseWorld.defs)[0]]
    asOk(
      applyEntry(
        baseWorld,
        mkEntry(1, '0'.repeat(64), 'add_identity', {
          id: 'c1',
          schema: H(storedDef as unknown as Json),
        }),
      ),
    )
    asOk(
      applyEntry(
        baseWorld,
        mkEntry(2, '0'.repeat(64), 'add_gen', {
          id: 'c1',
          payload: H(storedDef as unknown as Json),
          pins: {},
          sig: H(storedDef as unknown as Json),
        }),
      ),
    )
    const cloned = cloneWorld(baseWorld)
    const extra = { body: 9 } as unknown as Def // 新增键不动原件（Def 名义共享，同 put 口径）
    cloned.defs['a'.repeat(64)] = extra
    cloned.ids.c1.active = null
    cloned.ids.c1.born = { at: -1, by: 'x' }
    cloned.ids.c1.gens.push(cloned.ids.c1.gens[0])
    expect(Object.keys(baseWorld.defs).length).toBe(1)
    expect(baseWorld.ids.c1.active).not.toBeNull()
    expect(baseWorld.ids.c1.born.at).toBe(1001)
    expect(baseWorld.ids.c1.gens.length).toBe(1)
    expect(cloned.defs[Object.keys(baseWorld.defs)[0]]).toBe(storedDef) // Def 按引用共享（clone 层以下不复制）
    expect(cloned.ids.c1.gens[0]).toBe(baseWorld.ids.c1.gens[0]) // Gen 元素共享，数组独立
    expect(cloned.ids.c1).not.toBe(baseWorld.ids.c1)
  })
})

describe('replay 与 verify', () => {
  it('replay(entries) 与逐步 applyEntry 逐字段一致（born/adopted.write/pins/graft）', () => {
    const h = mixedChain()
    const replayed = replay(h.journal)
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(h.w)) // 逐字段（含履历）
    expect(replayed).not.toBe(h.w)
    expect(replayed.ids.u2.gens[0].adopted.write).toBe(h.w.ids.u2.gens[0].adopted.write) // 批内 write 复现
    expect(replayed.ids.u1.born).toEqual({ at: 1003, by: 'u' })
    expect(replayed.ids.u3.gens[0].graft).toEqual({ from: 'u1', gen: 0 })
    expect(JSON.stringify(h.w)).not.toBe('{}')
  })

  it('verify 正例：缺省锚、expected.hashes、worldRev 锚点；worldRev 锚不符 → world_rev_mismatch', () => {
    const h = mixedChain()
    const rev = worldRev(h.w)
    const hashes = h.journal.map((e) => entryHash(e))
    expect(verify(h.journal)).toEqual({ ok: true })
    expect(verify(h.journal, undefined, { hashes, worldRev: rev })).toEqual({ ok: true })
    expect(verify(h.journal, undefined, { worldRev: '1'.repeat(64) })).toEqual({
      ok: false,
      error: 'world_rev_mismatch',
    })
  })

  it('verify 负例：seq 跳号 / prev 断链 / hashes 清单错 → chain_broken', () => {
    const h = mixedChain()
    const j = h.journal
    const jump = j.map((e, i) => (i === 3 ? { ...e, seq: e.seq + 1 } : e))
    expect(verify(jump)).toEqual({ ok: false, error: 'chain_broken' })
    const cut = j.map((e, i) => (i === 5 ? { ...e, prev: '7'.repeat(64) } : e))
    expect(verify(cut)).toEqual({ ok: false, error: 'chain_broken' })
    const hashes = j.map((e) => entryHash(e))
    hashes[hashes.length - 2] = '9'.repeat(64)
    expect(verify(j, undefined, { hashes })).toEqual({ ok: false, error: 'chain_broken' })
    expect(verify([])).toEqual({ ok: true }) // 空段（EMPTY 锚起）自洽
  })

  it('改 args 不改 argsHash → verify/replay 出 args_hash_mismatch；entryHash 不吃 args', () => {
    const h = harness()
    h.push('put', { body: { v: 'orig' } })
    h.push('put', { body: { v: 'target' } })
    const note = h.push('note', { x: 1 }) // 挑 note：args 不在别名下，篡改不污染世界对象
    const before = JSON.stringify(h.w)
    const hashBefore = entryHash(note)
    ;(note.args as { x: number }).x = 999
    expect(hashBefore).toBe(entryHash(note)) // O(1)：不读 args
    expect(verify(h.journal)).toEqual({ ok: false, error: 'args_hash_mismatch' })
    expect(codeOf(() => replay(h.journal))).toBe('args_hash_mismatch')
    expect(JSON.stringify(h.w)).toBe(before) // 校验用副本，原世界不动
  })

  it('篡改 entryHash 覆盖的 by（末条）→ expected.hashes 抓出 chain_broken', () => {
    const h = mixedChain()
    const last = h.journal[h.journal.length - 1]
    const hashes = h.journal.map((e) => entryHash(e))
    last.by = 'mallory'
    expect(verify(h.journal)).toEqual({ ok: true }) // 中段由 prev 互锁；末条无后继引用其位置
    expect(verify(h.journal, undefined, { hashes })).toEqual({ ok: false, error: 'chain_broken' })
  })

  it('batch 子失败：verify 出 apply_failed、replay 抛 apply_failed；applyEntry 不回填入参', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    const bad = mkEntry(h.journal.length, h.head.hash, 'batch', {
      ops: [
        { op: 'put', args: { body: { z: 9 } } },
        {
          op: 'add_gen',
          args: { id: 'ghost', payload: 'a'.repeat(64), pins: {}, sig: 'b'.repeat(64) },
        },
      ],
    })
    bad.argsHash = 'c'.repeat(64)
    const journal = [...h.journal, bad]
    expect(verify(journal)).toEqual({ ok: false, error: 'apply_failed' })
    expect(codeOf(() => replay(journal))).toBe('apply_failed')
    expect(bad.argsHash).toBe('c'.repeat(64)) // 不覆写 e；回填只发生在 commit
  })

  it('快照在中段：anchorAfter+verify(tail) 过、replay(tail, snap) 与全量逐字段同', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const payloadDef = h.push('put', { body: { g: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    h.push('add_gen', {
      id: 'u1',
      payload: payloadDef.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    h.push('note', { pre: 1 })
    const snap = h.push('snapshot', { world_rev: worldRev(h.w) })
    const snapWorld = cloneWorld(h.w) // 边界 = 这条 entry；世界本体随它落盘
    const anchor = anchorAfter(snapWorld, snap)
    expect(anchor.head).toEqual({ seq: snap.seq, hash: entryHash(snap) }) // 与 head 同形
    expect(anchor.world).toBe(snapWorld)
    const secondPayload = h.push('put', { body: { g: 2 } })
    h.push('add_gen', {
      id: 'u1',
      payload: secondPayload.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    const tail = h.journal.slice(h.journal.indexOf(snap) + 1)
    expect(verify(tail, anchor)).toEqual({ ok: true }) // 起点来自锚点，非硬编码 null
    expect(
      verify(tail, anchor, {
        hashes: tail.map((e) => entryHash(e)),
        worldRev: worldRev(h.w),
      }),
    ).toEqual({ ok: true })
    const half = replay(tail, snapWorld)
    expect(worldRev(half)).toBe(worldRev(replay(h.journal))) // 长链安全的核心断言
    expect(JSON.stringify(half)).toBe(JSON.stringify(replay(h.journal))) // 逐字段
    const wrong = anchorAfter(snapWorld, h.journal[0]) // 边界凭证拿错 → 拒挂
    expect(verify(tail, wrong)).toEqual({ ok: false, error: 'chain_broken' })
  })
})

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

describe('冻结桩与固定种子随机链', () => {
  it('深冻结 Entry（含 args、batch/嵌套 batch 路径）传 applyEntry：e 逐字节不变', () => {
    const w = cloneWorld(EMPTY_WORLD)
    const schemaDef: Json = { body: { sch: 9 } }
    const schemaKey = H(schemaDef)
    const payloadDef: Json = { body: { a: 1 } }
    const plain = [
      mkEntry(0, null, 'put', schemaDef),
      mkEntry(1, null, 'put', payloadDef),
      mkEntry(2, null, 'add_identity', { id: 'bz', schema: schemaKey }),
      mkEntry(3, null, 'add_gen', { id: 'bz', payload: H(payloadDef), pins: {}, sig: schemaKey }),
      mkEntry(4, null, 'batch', {
        ops: [
          { op: 'put', args: { body: { b: 2 } } },
          {
            op: 'graft',
            args: { id: 'bz', payload: { $n: 0 }, pins: {}, sig: schemaKey, from: 'bz', gen: 0 },
          },
          {
            op: 'batch',
            args: {
              ops: [
                { op: 'put', args: { body: { c: 3 } } },
                { op: 'note', args: { inner: { $n: 0 } } },
              ],
            },
          },
        ],
      }),
    ]
    for (const raw of plain.map((e) => deepFreeze(e))) {
      const before = JSON.stringify(raw)
      const r = applyEntry(w, raw)
      if (!r.ok) throw new Error('冻结不应改变语义: ' + r.error)
      expect(JSON.stringify(raw)).toBe(before) // 严格模式下任何就地改写会当场抛
      expect(raw.argsHash).toBe('') // 不回填（回填只归 commit）
    }
    expect(w.ids.bz.gens.length).toBe(2) // add_gen + 批内 graft 正常生效
    expect(w.ids.bz.gens[1].graft).toEqual({ from: 'bz', gen: 0 })
  })

  it('整条深冻结链：verify/replay 通过后每条 entry 仍逐字节不变', () => {
    const h = mixedChain()
    const frozen = h.journal.map((e) => deepFreeze(e))
    const snaps = frozen.map((e) => JSON.stringify(e))
    expect(
      verify(frozen, undefined, {
        hashes: frozen.map((e) => entryHash(e)),
        worldRev: worldRev(h.w),
      }),
    ).toEqual({ ok: true })
    expect(worldRev(replay(frozen))).toBe(worldRev(h.w))
    frozen.forEach((e, i) => expect(JSON.stringify(e)).toBe(snaps[i]))
  })

  it('固定种子 20260916 随机混合链（无 IO 口径下可重跑）：replay 与逐步 apply 一致', () => {
    const rnd = lcg(20260916)
    const h = harness()
    const schemaKey = h.push('put', { body: { s: 0 } }).argsHash
    const defKeys: Hash[] = [schemaKey]
    const ids: string[] = []
    const gensOf: Record<string, Hash[]> = {}
    for (let i = 1; i <= 40; i++) {
      const pick = rnd()
      if (pick < 0.4) {
        const d: Json = { body: { f: i } }
        h.push('put', d)
        defKeys.push(H(d))
      } else if (pick < 0.6 || ids.length === 0) {
        const id = 'x' + ids.length
        h.push('add_identity', { id, schema: schemaKey })
        ids.push(id)
        gensOf[id] = []
      } else if (pick < 0.85) {
        const id = ids[Math.floor(rnd() * ids.length)]
        const pl = defKeys[Math.floor(rnd() * defKeys.length)]
        h.push('add_gen', { id, payload: pl, pins: {}, sig: schemaKey })
        gensOf[id].push(pl)
      } else {
        const id = ids[Math.floor(rnd() * ids.length)]
        const g = gensOf[id]
        if (g.length === 0 || rnd() < 0.5) h.push('set_active', { id, active: null })
        else h.push('set_active', { id, active: g[Math.floor(rnd() * g.length)] })
      }
    }
    expect(h.journal.length).toBeGreaterThanOrEqual(10)
    expect(JSON.stringify(replay(h.journal))).toBe(JSON.stringify(h.w)) // 逐字段
    expect(
      verify(h.journal, undefined, {
        hashes: h.journal.map((e) => entryHash(e)),
        worldRev: worldRev(h.w),
      }),
    ).toEqual({ ok: true })
  })
})
