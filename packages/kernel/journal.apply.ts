// 机械语义层（世界的逐 op apply 语义）：applyEntry 与 batch 两段式。
// 点分段拆分（预算护栏）：两个身份在 journal.id.ts，世界常量与重放/校验在 journal.ts。
// 别名契约：只改调用方独占的世界副本，**绝不改传入的 Entry**。

import { defHas } from './defs.ts'
import { H } from './hash.ts'
import { entryHash, worldRev } from './journal.id.ts'
import { readPatchOps } from './patch.ts'
import { KernelError } from './types.ts'
import type { Def, Entry, Gen, Hash, Identity, Json, Op, World } from './types.ts'

/** 链上 batch 的 args 骨架（形状表；内核只看这一层，不解释子 op 的 args）。 */
export interface BatchOp {
  op: Op
  args: Json
}

export type ApplyOutcome =
  | { ok: true; world: World; isNoop: boolean; argsHash: Hash; written: Hash[] }
  | { ok: false; error: string }

/**
 * 应用一条 entry（固定次序：先算 argsHash——不回写、不触碰 `e`——再做 op 改动，最后返回）。
 * 就地修改独占副本 `w` 并返回同一对象；batch 段 2 失败时已逆序回滚，`w` 逐字节不动。
 * @param w 调用方独占的世界副本
 * @param e 要应用的 entry（不会被修改）
 * @param adoptedBy 仅 batch 内层用：外层真实位置，写入 `adopted.write`（两段式）
 * @returns ok:true 带世界与本次写入的 def 键；ok:false 仅 batch 子操作失败可达
 * @throws KernelError 单 op 语义违例（'id_taken' / 'missing_ref' / 'not_a_generation' /
 *   'stale_active' / 'bad_selfref' / 'world_rev_mismatch' / 'missing_parent' / 'no_identity' /
 *   'bad_form'）
 */
export function applyEntry(w: World, e: Entry, adoptedBy?: Hash): ApplyOutcome {
  return applyOp(w, e, adoptedBy, undefined)
}

function applyOp(
  w: World,
  e: Entry,
  adoptedBy: Hash | undefined,
  undo: Undo[] | undefined,
): ApplyOutcome {
  switch (e.op) {
    case 'put': {
      const argsHash = H(e.args) // 键与 argsHash 是同一个值
      if (defHas(w.defs, argsHash)) return ok(w, true, argsHash, [])
      if (undo) undo.push({ t: 'defs-new', k: argsHash }) // put 只新增键（同键必幂等命中）
      w.defs[argsHash] = e.args as unknown as Def // 原样入世界（不复制，O(1)）；此后视为不可变
      return ok(w, false, argsHash, [argsHash])
    }
    case 'note':
      return ok(w, false, H(e.args), [])
    case 'snapshot': {
      const argsHash = H(e.args)
      if (((e.args as { world_rev?: Json }).world_rev as Hash) !== worldRev(w)) {
        throw new KernelError('world_rev_mismatch')
      }
      return ok(w, false, argsHash, [])
    }
    case 'add_identity':
      return applyNewIdentity(w, e, undo, false)
    case 'fork':
      return applyNewIdentity(w, e, undo, true)
    case 'set_active':
      return applySetActive(w, e, undo, false)
    case 'retire':
      return applySetActive(w, e, undo, true)
    case 'add_gen':
      return applyAddGen(w, e, { adoptedBy, undo, isGraft: false })
    case 'graft':
      return applyAddGen(w, e, { adoptedBy, undo, isGraft: true })
    case 'batch':
      return applyBatch(w, e, adoptedBy, undo)
    default:
      throw new KernelError('bad_form')
  }
}

function ok(w: World, isNoop: boolean, argsHash: Hash, written: Hash[]): ApplyOutcome {
  return { ok: true, world: w, isNoop, argsHash, written }
}

type Undo =
  | { t: 'defs-new'; k: Hash }
  | { t: 'ids-abs'; id: string }
  | { t: 'ids-set'; id: string; v: Identity }

function recId(w: World, undo: Undo[] | undefined, id: string): void {
  if (!undo) return
  const existing = w.ids[id]
  if (existing) {
    undo.push({ t: 'ids-set', id, v: { ...existing, gens: [...existing.gens] } })
  } else {
    undo.push({ t: 'ids-abs', id })
  }
}

function rollback(w: World, undo: Undo[], from: number): void {
  for (let i = undo.length - 1; i >= from; i--) {
    const u = undo[i]
    if (u.t === 'defs-new') delete w.defs[u.k]
    else if (u.t === 'ids-abs') delete w.ids[u.id]
    else w.ids[u.id] = u.v
  }
  undo.length = from
}

function applyNewIdentity(
  w: World,
  e: Entry,
  undo: Undo[] | undefined,
  isFork: boolean,
): ApplyOutcome {
  const s = e.args as { id: string; schema: Hash; parent?: string }
  const argsHash = H(e.args)
  if (w.ids[s.id]) throw new KernelError('id_taken')
  if (!defHas(w.defs, s.schema)) throw new KernelError('missing_ref')
  if (s.parent !== undefined && !w.ids[s.parent]) throw new KernelError('missing_parent')
  if (isFork && s.parent === undefined) throw new KernelError('missing_parent')
  recId(w, undo, s.id)
  const born: Identity['born'] = { at: e.at, by: e.by }
  if (s.parent !== undefined) born.parent = s.parent
  w.ids[s.id] = { id: s.id, schema: s.schema, gens: [], active: null, born }
  return ok(w, false, argsHash, [])
}

function applySetActive(
  w: World,
  e: Entry,
  undo: Undo[] | undefined,
  isRetire: boolean,
): ApplyOutcome {
  const s = e.args as { id: string; active?: Hash | null }
  const argsHash = H(e.args)
  const identity = w.ids[s.id]
  if (!identity) throw new KernelError('no_identity')
  const next = isRetire ? null : (s.active ?? null)
  if (next !== null && !identity.gens.some((g) => g.payload === next)) {
    throw new KernelError('not_a_generation')
  }
  recId(w, undo, s.id)
  identity.active = next
  return ok(w, false, argsHash, [])
}

interface GenCtx {
  adoptedBy?: Hash
  undo?: Undo[]
  isGraft: boolean
}

function applyAddGen(w: World, e: Entry, ctx: GenCtx): ApplyOutcome {
  const { adoptedBy, undo, isGraft } = ctx // 4 项打包（编码纪律：参数 ≤4）
  const s = e.args as {
    id: string
    payload: Hash
    pins?: Record<string, Hash>
    sig: Hash
    base?: number
    from?: string
    gen?: number
    expect_active?: Hash | null
  }
  const argsHash = H(e.args)
  const identity = w.ids[s.id]
  if (!identity) throw new KernelError('no_identity')
  if (Object.hasOwn(s, 'expect_active') && identity.active !== s.expect_active) {
    throw new KernelError('stale_active')
  }
  if (!defHas(w.defs, s.payload) || !defHas(w.defs, s.sig)) throw new KernelError('missing_ref')
  // 补丁世代：base 必须是同身份内已存在的世代下标；payload def 必须是合法补丁体。
  // 两查都在改动世界之前（fail-closed），任一不过整条 entry 不落地。
  let base: number | undefined
  if (!isGraft && s.base !== undefined) {
    if (!Number.isInteger(s.base) || s.base < 0 || s.base >= identity.gens.length) {
      throw new KernelError('missing_parent')
    }
    if (readPatchOps(w.defs[s.payload].body) === null) throw new KernelError('bad_patch')
    base = s.base
  }
  let graft: Gen['graft'] | undefined
  if (isGraft) {
    const src = s.from === undefined ? undefined : w.ids[s.from]
    if (!src || s.gen === undefined || src.gens[s.gen] === undefined) {
      throw new KernelError('missing_parent')
    }
    graft = { from: s.from as string, gen: s.gen }
  }
  recId(w, undo, s.id)
  identity.gens.push({
    seq: identity.gens.length, // 内核分配：从 0 起、严格 +1，push 之前取值
    payload: s.payload,
    pins: s.pins ?? {},
    sig: s.sig,
    adopted: { at: e.at, by: e.by, write: adoptedBy ?? entryHash({ ...e, argsHash }) },
    graft,
    ...(base !== undefined ? { base } : {}),
  })
  identity.active = s.payload // add_gen 同时激活
  return ok(w, false, argsHash, [])
}

function batchDigest(
  opsList: BatchOp[],
  e: Entry,
): { argsHash: Hash; hashes: Hash[]; outerPos: Hash } {
  // 段 1：纯哈希，不碰世界——坏占位符 / 坏形态在世界分文未动前就抛出
  const hashes: Hash[] = []
  const pairs: [Op, Hash][] = []
  const acc0: (Hash | null)[] = []
  for (let k = 0; k < opsList.length; k++) {
    const a2 = substitute(opsList[k].args, acc0, k)
    const h = argsHashOf(opsList[k].op, a2)
    hashes.push(h)
    pairs.push([opsList[k].op, h])
    acc0.push(opsList[k].op === 'put' ? h : null)
  }
  const argsHash = H({ ops: pairs })
  return { argsHash, hashes, outerPos: entryHash({ ...e, argsHash }) }
}

function applyBatch(
  w: World,
  e: Entry,
  adoptedBy: Hash | undefined,
  sink: Undo[] | undefined,
): ApplyOutcome {
  const opsList = readOps(e.args)
  const { argsHash, hashes, outerPos } = batchDigest(opsList, e)
  // dup 短路：全为 put 且段 1 算出的每个键都已在 defs——预哈希后即可定论，
  // 跳过段 2（重试不重付 apply 账）。判决与走段 2 的定论逐字段一致（isNoop=true、written=[]）。
  // 边界写死：含任何非 put（或嵌套 batch）的批仍走段 2——非 put 的 isNoop 不由键存在性决定。
  // 空批在 every() 下平凡成立：与段 2 的空转定论相同。段 1 的哈希账不可免（链格式）。
  if (opsList.every((s, k) => s.op === 'put' && defHas(w.defs, hashes[k]))) {
    return ok(w, true, argsHash, [])
  }
  // 段 2：真实应用。undo 收集沿嵌套链共享（收紧批局部回滚，令外层回滚可覆盖已提交的
  // 内层改动，否则整批原子性在嵌套下不成立）；子操作失败面与规格的边界表一致
  const undo: Undo[] = sink ?? []
  const mark = undo.length
  const acc: (Hash | null)[] = []
  const written: Hash[] = []
  let allNoop = true
  for (let k = 0; k < opsList.length; k++) {
    const a2 = substitute(opsList[k].args, acc, k) // 与段 1 逐字同规则（acc 前缀同构），必得同结果
    const child: Entry = {
      seq: e.seq,
      prev: e.prev,
      argsHash: 'placeholder', // applyOp 从不读入参 argsHash（首步只计算），占位安全
      op: opsList[k].op,
      args: a2,
      by: e.by,
      ref: e.ref,
      at: e.at,
    }
    let r: ApplyOutcome
    try {
      r = applyOp(w, child, adoptedBy ?? outerPos, undo)
    } catch (err) {
      if (err instanceof KernelError) {
        rollback(w, undo, mark)
        return { ok: false, error: err.code }
      }
      throw err
    }
    if (!r.ok) {
      rollback(w, undo, mark)
      return { ok: false, error: r.error }
    }
    if (r.argsHash !== hashes[k]) throw new Error('batch two-phase divergence') // 护栏
    allNoop = allNoop && r.isNoop
    written.push(...r.written)
    acc.push(opsList[k].op === 'put' ? r.argsHash : null)
  }
  return ok(w, allNoop, argsHash, written)
}

function readOps(args: Json): BatchOp[] {
  const opsList = (args as { ops?: BatchOp[] }).ops
  if (!Array.isArray(opsList)) throw new KernelError('bad_form')
  return opsList
}

/** argsHash 的按 op 口径：put / 其余 → H(args)；batch → 子对聚合（递归段 1）。 */
export function argsHashOf(op: Op, args: Json): Hash {
  return op === 'batch' ? hashOnly('batch', args) : H(args)
}

function hashOnly(op: Op, args: Json): Hash {
  if (op !== 'batch') return H(args)
  const opsList = readOps(args)
  const pairs: [Op, Hash][] = []
  const acc: (Hash | null)[] = []
  for (let k = 0; k < opsList.length; k++) {
    const h = hashOnly(opsList[k].op, substitute(opsList[k].args, acc, k))
    pairs.push([opsList[k].op, h])
    acc.push(opsList[k].op === 'put' ? h : null)
  }
  return H({ ops: pairs })
}

/**
 * batch 占位符替换：`{'$n': k}` 只能指向**本批内更早**且有产物（put）的子操作；
 * 返回**新对象**，不回写入参——日志里存的永远是替换前的 args。
 *
 * 数据里若要出现 `{'$n':k}` 字面量（工具结果 / 术语 AST / 模型入参等任意 JSON 都可能有），
 * 用转义包裹 `{'$lit': v}` 落盘：`v` 按数据原样保留、其中的 `$n` 不再当占位符。
 */
export function substitute(v: Json, acc: (Hash | null)[], k: number): Json {
  if (Array.isArray(v)) return v.map((x) => substitute(x, acc, k))
  if (v === null || typeof v !== 'object') return v
  const record = v as { [key: string]: Json }
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === '$n') {
    const j = record['$n']
    if (typeof j !== 'number' || !Number.isInteger(j) || j < 0 || j >= k || acc[j] === null) {
      throw new KernelError('bad_selfref')
    }
    return acc[j] as Hash
  }
  if (keys.length === 1 && keys[0] === '$lit') return literal(record['$lit'])
  const out: { [key: string]: Json } = {}
  for (const key of keys) {
    const sv = substitute(record[key], acc, k)
    if (sv !== undefined) out[key] = sv
  }
  return out
}

/**
 * 转义包裹 `{'$lit': v}` 的还原：`v` 是**数据**，其中的 `$n` 不再当占位符；
 * 只继续还原嵌套的 `$lit`（若要落数据 `{'$lit':…}` 本身，须再包一层）。
 */
function literal(v: Json): Json {
  if (Array.isArray(v)) return v.map((x) => literal(x))
  if (v === null || typeof v !== 'object') return v
  const record = v as { [key: string]: Json }
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === '$lit') return literal(record['$lit'])
  const out: { [key: string]: Json } = {}
  for (const key of keys) out[key] = literal(record[key])
  return out
}

/** 把任意数据包成转义形态（写方用：数据里带 `{'$n':k}` 字面量时避免被内核当占位符替换）。 */
export function asLiteral(v: Json): Json {
  return { $lit: v }
}
