// T2 载荷 note 验收（母文件 commit.test.ts 的点分段）：只打公共面 ./index.ts。
// 口径：§11.2 形状表 note 行（任意 JSON 对象 = 留痕载荷）、§11.4 本轮新增 1–5、不变量 16。
// 裁决点 B（评审交接 §3）：改载荷不改 argsHash 的 args_hash_mismatch 断言只给**非 snapshot** op——
// snapshot 篡改的码序（world_rev_mismatch 先于 argsHash 比对）钉在 journal.c.test.ts。
import { describe, expect, it } from 'vitest'

import {
  EMPTY_HEAD,
  EMPTY_WORLD,
  H,
  cloneWorld,
  commit,
  entryHash,
  replay,
  verify,
  worldRev,
} from '../index.ts'
import type { Entry, Hash, Json, Op, World, WriteRequest } from '../index.ts'

const NOW = 987_654
const J = (v: unknown): Json => v as Json
type Head = Parameters<typeof commit>[0]
type Outcome = ReturnType<typeof commit>
type Chain = { entries: Entry[]; world: World; head: Head }
const snap = (v: unknown): string => JSON.stringify(v)
const req = (id: string, op: Op, args: Json, pos: Hash | null = null): WriteRequest =>
  ({ id, op, target: { expect_pos: pos }, args, by: 'note-tester' }) as unknown as WriteRequest
const noteReq = (payload: Json, pos: Hash | null = null): WriteRequest =>
  req('n', 'note', payload, pos)

function emptyWorld(): World {
  return cloneWorld(EMPTY_WORLD)
}
const emptyHead = (): Head => ({ ...EMPTY_HEAD })

function link(chain: Chain, r: WriteRequest): Outcome {
  // link 统一以当前链头填 expect_pos（调用方不必各自对齐位置）
  const out = commit(
    chain.head,
    chain.world,
    { ...r, target: { expect_pos: chain.head.hash } },
    NOW,
  )
  if (!out.verdict.ok || out.entry === null) {
    throw new Error('seed commit refused: ' + out.verdict.reasons.join(','))
  }
  chain.entries.push(out.entry)
  chain.head = { seq: out.entry.seq, hash: out.hash as Hash }
  return out
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    const c = (err as { code?: unknown }).code // 契约 code，不断言 KernelError 类型（journal.b 同口径）
    return typeof c === 'string' ? c : '<非 KernelError>'
  }
  return '<不抛>'
}

/** 一条载荷 note + 一个批内 $n 的混合构造：双跑逐字节一致用。 */
function buildNoteChain(): Chain {
  const chain: Chain = { entries: [], world: emptyWorld(), head: emptyHead() }
  link(chain, noteReq(J({ kind: 'obs', step: 1 })))
  const ops = J({
    ops: [
      { op: 'put', args: J({ body: { d: 1 } }) },
      { op: 'note', args: J({ pin: { $n: 0 } }) },
      { op: 'note', args: J({ kind: 'obs', step: 1 }) }, // 与散条同载荷：两条 entry 并存
    ],
  })
  link(chain, req('note-batch', 'batch', ops, chain.head.hash))
  link(chain, noteReq(J({ tail: true })))
  return chain
}

describe('载荷 note：形态、去重与 argsHash 镜像（§11.4 本轮新增 1–3）', () => {
  it('正例：任意 JSON 对象 → ok 且照常产 entry；空 {} 仍过；顶层数组/字符串/null → bad_form', () => {
    const w = emptyWorld()
    let head = emptyHead()
    const before = snap(w)
    const out = commit(head, w, noteReq(J({ kind: 'obs', step: 3, blob: 'cd'.repeat(32) })), NOW)
    expect([out.verdict.ok, out.verdict.reasons, out.verdict.written]).toEqual([true, [], []])
    expect(out.entry).not.toBeNull()
    expect(out.hash).toBe(entryHash(out.entry as Entry))
    expect(out.verdict.pos).toBe(out.hash)
    expect(snap(w)).toBe(before) // note 载荷不进世界（规矩 B）
    expect(Object.keys(w.defs).length).toBe(0)
    const e = out.entry as Entry
    head = { seq: e.seq, hash: out.hash as Hash }
    const emptyOk = commit(head, w, noteReq(J({}), head.hash), NOW)
    expect(emptyOk.verdict.ok).toBe(true) // 向后兼容：空对象载荷仍过
    for (const bad of [J([1, 2]), J('plain string'), J(null)]) {
      const rejected = commit(head, w, noteReq(bad), NOW)
      // 触发点在 hasForm 公共前置（args 必须是非 null 非数组对象），不是 note 检查——只锁理由码
      expect([
        rejected.verdict.ok,
        rejected.verdict.reasons,
        rejected.entry,
        rejected.hash,
      ]).toEqual([false, ['bad_form'], null, null])
    }
    expect(snap(w)).toBe(before)
  })

  it('同载荷提交两次 → 两条 entry：isNoop 恒 false、dup 不适用、argsHash 相同而 entryHash 必不同', () => {
    const payload = J({ kind: 'obs', steps: [1, 2, 3], blob: 'ff'.repeat(32) })
    const chain: Chain = { entries: [], world: emptyWorld(), head: emptyHead() }
    const h1 = link(chain, noteReq(payload))
    const h2 = link(chain, noteReq(payload))
    expect([h1.verdict.reasons, h2.verdict.reasons]).toEqual([[], []]) // 第二次也不是 dup
    const e1 = h1.entry as Entry
    const e2 = h2.entry as Entry
    expect(e2.seq).toBe(e1.seq + 1)
    expect(e2.prev).toBe(h1.hash) // 两条都在链上
    expect(e1.argsHash).toBe(e2.argsHash) // 载荷同 → 内容哈希同
    expect(h1.hash).not.toBe(h2.hash) // seq/prev 不同 → 位置哈希必不同
    expect(e1.at).toBe(e2.at) // at 可同（NOW 固定），不影响两条并存
    expect(snap(e1.args)).toBe(snap(e2.args))
  })

  it('改载荷不改 argsHash → args_hash_mismatch（journal.b:257 的镜像；本断言只给非 snapshot op）', () => {
    const chain: Chain = { entries: [], world: emptyWorld(), head: emptyHead() }
    link(chain, noteReq(J({ x: 1, deep: { keep: true } })))
    const e = chain.entries[0]
    const original = snap(e.args)
    const hashBefore = entryHash(e)
    // note 的 args 不入 defs ⇒ 就地篡改不污染任何共享对象（journal.b 选 note 作载体的同一理由）
    ;(e.args as { x: number }).x = 999
    expect(snap(e.args)).not.toBe(original)
    expect(entryHash(e)).toBe(hashBefore) // O(1)：entryHash 不读 args
    expect(verify(chain.entries)).toEqual({ ok: false, error: 'args_hash_mismatch' })
    expect(codeOf(() => replay(chain.entries))).toBe('args_hash_mismatch')
  })

  it('不变量 16 可执行定义：纯载荷 note 链 replay ≡ EMPTY_WORLD、worldRev 全程不变、键数桩与条数无关', () => {
    const chain: Chain = { entries: [], world: emptyWorld(), head: emptyHead() }
    const rev0 = worldRev(EMPTY_WORLD)
    for (let k = 0; k < 10; k++) {
      link(chain, noteReq(J({ ev: k, pad: 'x'.repeat(200) })))
      expect(Object.keys(chain.world.defs).length).toBe(0) // defs 键数桩：与条数无关
      expect(Object.keys(chain.world.ids).length).toBe(0)
      expect(worldRev(chain.world)).toBe(rev0) // 全程内容身份不变（不克隆、不摘要）
    }
    link(chain, noteReq(J({ ev: 0, pad: 'x'.repeat(200) }))) // 与第 1 条同载荷——仍产 entry，不吃 dup
    expect(chain.entries.length).toBe(11)
    const replayed = replay(chain.entries)
    expect(snap(replayed)).toBe(snap(emptyWorld())) // replay ≡ EMPTY_WORLD 逐字节
    expect(snap(chain.world)).toBe(snap(emptyWorld()))
    expect(verify(chain.entries)).toEqual({ ok: true })
  })
})

describe('载荷 note：batch 完整形态路径与双跑（§11.4 本轮新增 4–5）', () => {
  it('batch 内 note 含 $n 经 commit：占位符替换入批哈希、日志存替换前 args、批不是 dup', () => {
    const payloadDef = J({ body: { blob: 'batch-target' } })
    const chain: Chain = { entries: [], world: emptyWorld(), head: emptyHead() }
    const ops = J({
      ops: [
        { op: 'put', args: payloadDef },
        { op: 'note', args: J({ seen: { item: { $n: 0 } }, list: [{ $n: 0 }] }) },
      ],
    })
    const out = link(chain, req('b1', 'batch', ops, chain.head.hash))
    const e = out.entry as Entry
    expect(snap(e.args)).toBe(snap(ops)) // 日志里永远是替换前的占位符
    expect(out.verdict.written).toEqual([H(payloadDef)])
    expect(out.verdict.reasons).toEqual([])
    const r2 = commit(chain.head, chain.world, req('b2', 'batch', ops, chain.head.hash), NOW)
    // put 子项重复命中 noop，但 note 恒非 noop ⇒ 整批仍产 entry、判决不是 dup、written 空
    expect(r2.verdict.ok).toBe(true)
    expect([r2.verdict.reasons, r2.entry === null, r2.verdict.written]).toEqual([[], false, []])
    const tail = [e, r2.entry as Entry]
    expect(verify(tail, { world: emptyWorld(), head: emptyHead() })).toEqual({ ok: true })
    expect(snap(replay(tail))).toBe(snap(chain.world)) // 只有 put 的 1 键进世界；note 载荷不挤热世界
  })

  it('双跑逐字节一致：两套独立构造 journal/world 全等，且彼此哈希清单 + worldRev 交叉校验通过', () => {
    const a = buildNoteChain()
    const b = buildNoteChain()
    expect(b.entries.map(snap)).toEqual(a.entries.map(snap))
    expect(snap(b.world)).toBe(snap(a.world))
    expect(a.entries.length).toBe(3) // 自证：散条 + 批（内 $n/同载荷 note 折叠为一条链 entry）+ 尾条
    expect(
      verify(a.entries, undefined, {
        hashes: b.entries.map((e) => entryHash(e)),
        worldRev: worldRev(b.world),
      }),
    ).toEqual({ ok: true }) // A 的链吃 B 的哈希清单过 ⇒ 两条路线产出同一链
    expect(snap(replay(a.entries))).toBe(snap(b.world))
  })
})
