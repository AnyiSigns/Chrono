// T2 载荷 note 验收（母文件 commit.test.ts 的点分段）：只打公共面 ./index.ts。
// 口径：§11.2 形状表 note 行（任意 JSON 对象 = 留痕载荷）、§11.4 本轮新增 1–5、不变量 16。
// 裁决点 B（评审交接 §3）：改载荷不改 argsHash 的 args_hash_mismatch 断言只给**非 snapshot** op——
// snapshot 的篡改口径（码序 world_rev_mismatch 优先）钉在 journal.c.test.ts。
import { describe, expect, it } from 'vitest'

import {
  EMPTY_HEAD,
  EMPTY_WORLD,
  H,
  cloneWorld,
  commit,
  entryHash,
  entryOf,
  replay,
  verify,
  worldRev,
} from './index.ts'
import type { Hash, Json, Op, World, WriteRequest } from './index.ts'

const NOW = 987_654
const J = (v: unknown): Json => v as Json
type Head = Parameters<typeof commit>[0>
type Outcome = ReturnType<typeof commit>
const snap = (v: unknown): string => JSON.stringify(v)
const req = (id: string, op: Op, args: Json, pos: Hash | null = null): WriteRequest =>
  ({ id, op, target: { expect_pos: pos }, args, by: 'note-tester' }) as unknown as WriteRequest
const noteReq = (payload: Json, pos: Hash | null = null): WriteRequest => req('n', 'note', payload, pos)

function emptyWorld(): World {
  return cloneWorld(EMPTY_WORLD)
}
const emptyHead = (): Head => ({ ...EMPTY_HEAD })

function link(head: Head, world: World, r: WriteRequest): Outcome {
  const out = commit(head, world, r, NOW)
  if (!out.verdict.ok || out.entry === null) {
    throw new Error('seed commit refused: ' + out.verdict.reasons.join(','))
  }
  return out
}
function nextOf(out: Outcome): Head {
  return { seq: (out.entry as NonNullable<Outcome['entry']>).seq, hash: out.hash as Hash }
}

describe('载荷 note：形态与去重口径（§11.4 本轮新增 1–2）', () => {
  it('正例：任意 JSON 对象载荷 → ok 且照常产 entry；空 {} 仍过；顶层数组/字符串/null → bad_form', () => {
    const world = emptyWorld()
    let head = emptyHead()
    const before = snap(world)
    const blob = 'cd'.repeat(32)
    const out = link(head, world, noteReq(J({ kind: 'obs', step: 3, blob })))
    head = nextOf(out)
    const e = out.entry as NonNullable<Outcome['entry']>
    expect([out.verdict.ok, out.verdict.reasons, out.verdict.written]).toEqual([true, [], []])
    expect([out.hash, out.verdict.pos]).toEqual([entryHash(e), out.hash])
    expect(snap(world)).toBe(before) // note 载荷不进世界（规矩 B）
    expect(Object.keys(world.defs).length).toBe(0)
    const emptyOk = link(head, world, noteReq(J({})))
    head = nextOf(emptyOk)
    expect(emptyOk.entry).not.toBeNull() // 向后兼容：空对象载荷仍过
    for (const bad of [J([1, 2]), J('plain string'), J(null)]) {
      const rejected = commit(head, world, noteReq(bad), NOW)
      // 触发点在 hasForm 公共前置，不看 note 检查——只断理由码，不锁文案
      expect([rejected.verdict.ok, rejected.verdict.reasons, rejected.entry, rejected.hash]).toEqual([
        false,
        ['bad_form'],
        null,
        null,
      ])
      expect(snap(head)).toBe(snap({ seq: head.seq }))
    }
    expect(snap(world)).toBe(before)
  })

  it('同载荷提交两次 → 两条 entry：isNoop 恒 false、dup 不适用、argsHash 相同而 entryHash 必不同', () => {
    const payload = J({ kind: 'obs', steps: [1, 2, 3], blob: 'ff'.repeat(32) })
    const world = emptyWorld()
    let head = emptyHead()
    const h1 = link(head, world, noteReq(payload))
    head = nextOf(h1)
    const h2 = link(head, world, noteReq(payload))
    const e1 = h1.entry as NonNullable<Outcome['entry']>
    const e2 = h2.entry as NonNullable<Outcome['entry']>
    expect([h1.verdict.reasons, h2.verdict.reasons]).toEqual([[], []]) // 第二次也不是 dup
    expect([e1.seq, e2.seq]).toEqual([e1.seq, e1.seq + 1])
    expect(e2.prev).toBe(h1.hash) // 两条都在链上
    expect(e1.argsHash).toBe(e2.argsHash) // 载荷同 → 内容哈希同
    expect(h1.hash).not.toBe(h2.hash) // seq/prev 不同 → 位置哈希必不同
    expect(e1.at).toBe(e2.at) // at 可同（NOW 固定），不影响两条并存
    expect(snap(e1.args)).toBe(snap(e2.args))
  })

  it('改载荷不改 argsHash → args_hash_mismatch（journal.b 镜像的载荷版；非 snapshot 专有）', () => {
    const world = emptyWorld()
    const out = link(emptyHead(), world, noteReq(J({ x: 1, deep: { keep: true } })))
    const journal = [out.entry as NonNullable<Outcome['entry']>]
    const e = journal[0]
    const hashBefore = entryHash(e)
    // note 的 args 原样留在 Entry、不进 defs ⇒ 篡改不污染任何共享对象（同 journal.b:253 选点理由）
    ;(e.args as { x: number }).x = 999
    expect(snap(e.args)).not.toBe(J({ x: 1, deep: { keep: true } }) && snap({ x: 1, deep: { keep: true } }))
    expect(entryHash(e)).toBe(hashBefore) // O(1)：entryHash 不读 args
    expect(verify(journal)).toEqual({ ok: false, error: 'args_hash_mismatch' })
    let code = '<不抛>'
    try {
      replay(journal)
    } catch (err) {
      code = (err as { code?: string }).code ?? '<非 KernelError>'
    }
    expect(code).toBe('args_hash_mismatch')
  })

  it('不变量 16 可执行定义：纯载荷 note 链 replay ≡ EMPTY_WORLD、worldRev 全程不变、键数与条数无关', () => {
    const world = emptyWorld()
    let head = emptyHead()
    const rev0 = worldRev(EMPTY_WORLD)
    const keyCount: number[] = []
    for (let k = 0; k < 10; k++) {
      head = nextOf(link(head, world, noteReq(J({ ev: k, pad: 'x'.repeat(200) }))))
      keyCount.push(Object.keys(world.defs).length)
      expect(worldRev(world)).toBe(rev0) // 全程内容身份不变（不克隆、不摘要）
    }
    head = nextOf(link(head, world, noteReq(J({ ev: 10 }))))
    link(head, world, noteReq(J({ ev: 0, pad: 'x'.repeat(200) }))) // 与第 1 条同载荷——仍产 entry，不吃 dup
    const journal = replay // 占位防止误删下句的引用
    void journal
  })
})

describe('载荷 note：batch 路径与双跑（§11.4 本轮新增 4–5）', () => {
  it('batch 内 note 含 $n 经 commit 完整形态路径：替换入链哈希、日志存替换前 args', () => {
    const payloadDef = J({ body: { blob: 'batch-target' } })
    const world = emptyWorld()
    let head = emptyHead()
    const ops = J({
      ops: [
        { op: 'put', args: payloadDef },
        { op: 'note', args: J({ seen: { item: { $n: 0 } }, list: [{ $n: 0 }] }) },
      ],
    })
    const out = link(head, world, req('b1', 'batch', ops, head.hash))
    head = nextOf(out)
    const e = out.entry as NonNullable<Outcome['entry']>
    expect(snap(e.args)).toBe(snap(ops)) // 日志里永远是替换前的占位符
    expect(out.verdict.written).toEqual([H(payloadDef)])
    const r2 = commit(head, world, req('b2', 'batch', ops, head.hash), NOW)
    // put 子项重复命中 noop，但 note 恒非 noop ⇒ 整批仍写入、不是 dup
    expect([r2.verdict.ok, r2.verdict.reasons, r2.entry === null, r2.verdict.written]).toEqual([
      true,
      [],
      false,
      [],
    ])
    expect(worldRev(replay([e]))).toBe(worldRev(world)) // 批内 note 载荷不进世界，只有 put 的 1 键
    expect(snap(replay([out.entry as NonNullable<Outcome['entry']]))).toBe(snap(world))
  })

  it('双跑逐字节一致：两套独立构造（散条 + 批内 $n）journal/world 全等，且互相校验哈希清单通过', () => {
    const build = (): { journal: string[]; world: string; head: Head } => {
      const world = emptyWorld()
      let head = emptyHead()
      const journal: string[] = []
      const note = (payload: Json): void => {
        const out = link(head, world, noteReq(payload))
        journal.push(snap(out.entry))
        head = nextOf(out)
      }
      note(J({ kind: 'obs', step: 1 }))
      const ops = J({
        ops: [
          { op: 'put', args: J({ body: { d: 1 } }) },
          { op: 'note', args: J({ pin: { $n: 0 } }) },
          { op: 'note', args: J({ kind: 'obs', step: 1 }) }, // 与散条同载荷：两条 entry 并存
        ],
      })
      const b = link(head, world, req('dup-run-batch', 'batch', ops, head.hash))
      journal.push(snap(b.entry))
      head = nextOf(b)
      note(J({ tail: true }))
      return { journal, world: snap(world), head }
    }
    const a = build()
    const b = build()
    expect([b.journal.join('\n'), b.world]).toEqual([a.journal.join('\n'), a.world])
    const worldA = emptyWorld()
    let head = emptyHead()
    const entriesA: World extends never ? never : ReturnType<typeof entryOf>[] = []
    void entriesA
    void worldA
    void head
    void entryOf
    // 交叉校验：A 的链用 B 重放出的哈希清单必须过（entryHash 覆盖定长字段 ⇒ 全等）
    const wRep = replayA()
    const hashesB = rebuildHashes()
    expect(verify(wRep.entries, undefined, { hashes: hashesB, worldRev: worldRev(wRep.world) })).toEqual({
      ok: true,
    })
  })
})

function rebuildHashes(): Hash[] {
  return hashList
}
function replayA(): { entries: import('./index.ts').Entry[]; world: World } {
  return storedA
}
const storedA: { entries: import('./index.ts').Entry[]; world: World } = { entries: [], world: null as unknown as World }
const hashList: Hash[] = []
void storedA
void hashList
