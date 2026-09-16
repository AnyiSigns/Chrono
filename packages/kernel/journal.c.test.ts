// T3 verify 不抛验收（母文件 journal.a/b 的点分段）：只打公共面 ./index.ts。
// 口径：§10.1 verify 旁注（一切失败转返回码）、§10.4 snapshot 行（catch 转 world_rev_mismatch）、
// §10.5 本轮新增 1–3（含 §19 replay 保持抛的对照）、§19"接错基础不报错"、§20 码序（裁决点 B）。
// 夹具与 journal.b 同规则（就地重复，不另建共享夹具）。
import { describe, expect, it } from 'vitest'

import type { Entry, Hash, Head, Json, Op, World } from './index.ts'
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

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    const c = (err as { code?: unknown }).code
    return typeof c === 'string' ? c : '<非 KernelError>'
  }
  return '<不抛>'
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
      if (!r.ok) throw new Error('c.harness 只用于成功链: ' + r.error)
      e.argsHash = r.argsHash // 测试扮演 commit 回填
      journal.push(e)
      head = { seq: e.seq, hash: entryHash(e) }
      return e
    },
  }
}

function asOk(r: Outcome) {
  if (!r.ok) throw new Error('期望 ok:true，实为 ' + r.error)
  return r
}

describe('verify 不抛：篡改 snapshot 走返回码，applyEntry / replay 保持抛（§10.5 本轮新增 1）', () => {
  it('verify 返回 world_rev_mismatch（裁决点 B：码序先于 args_hash）；非 KernelError 仍穿出', () => {
    const h = harness()
    h.push('put', { body: { v: 1 } })
    const snap = h.push('snapshot', { world_rev: worldRev(h.w) })
    const snapshotBefore = worldRev(h.w)
    // 篡改 args.world_rev 而**不同步 argsHash**：§20 循环里 applyEntry 先于 argsHash 比对，
    // 命中的必须是 world_rev_mismatch 而非 args_hash_mismatch——实现按 §20 顺序的行为冻结于此。
    ;(snap.args as { world_rev: string }).world_rev = '1'.repeat(64)
    expect(verify(h.journal)).toEqual({ ok: false, error: 'world_rev_mismatch' })
    expect(verify(h.journal, undefined, { hashes: h.journal.map((e) => entryHash(e)) })).toEqual({
      ok: false,
      error: 'world_rev_mismatch',
    })
    // 对照例：同一构造 applyEntry 直测仍抛（两口径各一例）
    const baseAtSnap = cloneWorld(EMPTY_WORLD)
    asOk(applyEntry(baseAtSnap, h.journal[0]))
    expect(codeOf(() => applyEntry(baseAtSnap, snap))).toBe('world_rev_mismatch')
    expect(codeOf(() => replay(h.journal))).toBe('world_rev_mismatch') // §19：replay 的契约就是抛
    // 篡改只是 entry.args：世界内容与快照锚点本身无恙（verify 不改入参世界）
    expect(worldRev(h.w)).toBe(snapshotBefore)
    // catch 只收 KernelError：非 KernelError 原样穿出（§10.1 旁注的另一半——"不抛"的边界）
    expect(() => verify([null as unknown as Entry])).toThrow(TypeError)
  })

  it('未篡改的 snapshot 链仍 ok（不误伤 verify 正路）', () => {
    const h = harness()
    h.push('put', { body: { v: 2 } })
    h.push('snapshot', { world_rev: worldRev(h.w) })
    h.push('note', { after: true })
    expect(verify(h.journal)).toEqual({ ok: true })
    expect(verify(h.journal, undefined, { worldRev: worldRev(h.w) })).toEqual({ ok: true })
  })
})

describe('replay(尾段, 错的基础) 不报错：把"不保证"写死成断言（§10.5 本轮新增 2）', () => {
  it('id_taken 的尾段接在缺前缀的基础上成功产出链上从未被授权的世界；verify 两个锚各抓各的码', () => {
    const h = harness()
    const schema: Json = { body: { s: 1 } }
    h.push('put', schema)
    h.push('add_identity', { id: 'a', schema: H(schema) })
    // 错的基础：只有 put 的前缀世界（缺 add_identity 'a' 那一步），锚点是它的末条
    const g = harness()
    const gPut = g.push('put', schema)
    expect(g.journal.length).toBe(1)
    // 尾段按 h 的真实链序构造——首条就是"在真实历史上该 id_taken"的 add_identity 'a'
    const t0 = mkEntry(h.head.seq + 1, h.head.hash, 'add_identity', { id: 'a', schema: H(schema) })
    t0.argsHash = H(t0.args)
    const t1 = mkEntry(t0.seq + 1, entryHash(t0), 'note', { after: 1 })
    t1.argsHash = H(t1.args)
    // 真实基座上该抛 id_taken（尾段从来进不了链）：
    expect(codeOf(() => applyEntry(cloneWorld(h.w), t0))).toBe('id_taken')
    // 错基础上的 replay **不报错**——replay 不校验链（§19），产出从未被任何可验链授权的"第二个 a"：
    const unauth = replay([t0, t1], g.w)
    expect(unauth.ids.a).toBeDefined()
    expect(unauth.ids.a.born).toEqual({ at: t0.at, by: 'u' })
    expect(codeOf(() => replay([t0, t1], g.w))).toBe('<不抛>')
    const real = replay(h.journal)
    expect(JSON.stringify(unauth)).not.toBe(JSON.stringify(real)) // 与真实历史的世界可辨（born/履历不同）
    // 三步成对（§10.7-4）抓同一构造：接驳凭证拿错 → chain_broken
    expect(verify([t0, t1], anchorAfter(g.w, gPut))).toEqual({ ok: false, error: 'chain_broken' })
    // 真实锚点上应用趟直接撞门禁 → id_taken（verify 对 KernelError 全部转码，§20 catch）
    expect(verify([t0, t1], anchorAfter(h.w, h.journal[1]))).toEqual({
      ok: false,
      error: 'id_taken',
    })
    // replay 的"错基础"不动入参世界
    expect(Object.keys(g.w.ids).length).toBe(0)
  })
})

describe('三步取用与全量逐字段等价：①校基础 → ②校接驳 → ③出状态（§10.5 本轮新增 3）', () => {
  it('partial 成对组装的世界与 full 全量重放逐字段相同；① 单独抓坏基础、② 单独抓断链', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const p1 = h.push('put', { body: { g: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    h.push('add_gen', { id: 'u1', payload: p1.argsHash, pins: {}, sig: schemaDef.argsHash })
    h.push('note', { kind: 'obs', step: 1 })
    const snap = h.push('snapshot', { world_rev: worldRev(h.w) })
    const base = cloneWorld(h.w) // 宿主随快照边界落盘的世界本体
    const anchor = anchorAfter(base, snap)
    const revSnap = (snap.args as { world_rev: Hash }).world_rev
    // ① 校基础：空段只剩 worldRev 比对——内核里唯一能校验基础的入口（assemble partial 的第一步）
    expect(verify([], anchor, { worldRev: revSnap })).toEqual({ ok: true })
    const rotten = cloneWorld(base)
    delete rotten.defs[p1.argsHash] // 存储被改过的基础（哪怕一字之差）必须在挂尾段前就被拒
    expect(verify([], anchorAfter(rotten, snap), { worldRev: revSnap })).toEqual({
      ok: false,
      error: 'world_rev_mismatch',
    })
    // 边界继续追加
    const p2 = h.push('put', { body: { g: 2 } })
    h.push('add_gen', { id: 'u1', payload: p2.argsHash, pins: {}, sig: schemaDef.argsHash })
    h.push('batch', {
      ops: [
        { op: 'put', args: { body: { g: 3 } } },
        { op: 'note', args: { joined: { n: 1 } } },
      ],
    })
    const tail = h.journal.slice(h.journal.indexOf(snap) + 1)
    expect(tail.length).toBe(3)
    // ② 校接驳（含 prev 被改一字的负例）
    expect(verify(tail, anchor)).toEqual({ ok: true })
    const cut = tail.map((e, i) => (i === 0 ? { ...e, prev: '7'.repeat(64) } : e))
    expect(verify(cut, anchor)).toEqual({ ok: false, error: 'chain_broken' })
    // ③ 出状态：尾段接基础 == 全量重放，逐字段（含履历）+ worldRev + 位置
    const partial = replay(tail, base)
    const full = replay(h.journal)
    expect(JSON.stringify(partial)).toBe(JSON.stringify(full))
    expect(worldRev(partial)).toBe(worldRev(full))
    expect(pos(tail)).toBe(pos(h.journal))
    expect(anchorAfter(base, snap)).toEqual({
      world: base,
      head: { seq: snap.seq, hash: entryHash(snap) },
    })
    // full 起点免 ①（冻结常量）：默认锚 + 段末 worldRev 一次过
    expect(verify(h.journal, undefined, { worldRev: worldRev(full) })).toEqual({ ok: true })
  })
})
