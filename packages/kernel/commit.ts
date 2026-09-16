// 唯一写口：机械校验（validate）→ 构造（entryOf）→ 应用
// （applyEntry 恰一次）→ 回填 argsHash（全库唯一回填点）。判决 = ok/reasons，只管合法性。
// 形态检查拆分在 commit.form.ts（预算护栏）。

import { applyEntry, entryHash } from './journal.ts'
import { hasForm } from './commit.form.ts'
import type {
  CommitOutcome,
  CommitResult,
  Def,
  Entry,
  Hash,
  Head,
  Json,
  World,
  WriteRequest,
} from './types.ts'

type Rec = { [k: string]: Json }

/** 引用检查：内核认识的字段里的每个 Hash 必须已在 defs（body 内部的引用归上层）。 */
function checkRefs(world: World, req: WriteRequest): string | null {
  if (req.ref !== undefined && !world.defs[req.ref]) return 'missing_ref'
  const r = req.args as Rec
  const missing = (h: Json | undefined): string | null =>
    h === undefined ? null : world.defs[h as Hash] ? null : 'missing_ref'
  const missingPins = (): string | null => {
    const pins = r['pins'] as Record<string, Hash> | undefined
    if (!pins) return null
    for (const h of Object.values(pins)) if (!world.defs[h]) return 'missing_ref'
    return null
  }
  switch (req.op) {
    case 'put':
      return missing(r['sig']) ?? missingPins()
    case 'add_identity':
    case 'fork':
      return missing(r['schema'])
    case 'add_gen':
    case 'graft':
      for (const code of [missing(r['payload']), missing(r['sig']), missingPins()]) {
        if (code) return code
      }
      return null
    default:
      return null
  }
}

/** 不变量门禁：id 占位 / 父身份与被嫁接世代存在。 */
function checkGates(world: World, req: WriteRequest): string | null {
  const r = req.args as Rec
  switch (req.op) {
    case 'add_identity':
    case 'fork': {
      if (world.ids[r['id'] as string]) return 'id_taken'
      const parent = r['parent']
      if (parent !== undefined && !world.ids[parent as string]) return 'missing_parent'
      return null
    }
    case 'graft': {
      const src = world.ids[r['from'] as string]
      if (!src || src.gens[r['gen'] as number] === undefined) return 'missing_parent'
      return null
    }
    default:
      return null
  }
}

function verdictOf(ok: boolean, code: string | null, head: Head): CommitResult {
  return { ok, reasons: code ? [code] : [], pos: head.hash, written: [] }
}

/**
 * 机械校验，判定顺序焊死：形态 → 引用 → 位置 → 不变量；只读不改世界。
 * 幂等不在这里判（看不到 apply 结果，由 commit 按 isNoop 定论）；batch 不递归查子操作——
 * 批内引用/id 类失败在段 2 由 applyEntry 报出、整批回滚。
 * @param head 当前链头（位置门禁对照 expect_pos）
 * @param world 当前世界（引用与不变量门禁均为只读检查）
 * @param req 写请求
 * @returns 通过：reasons 空；失败：reasons 为单元素错误码（bad_form / missing_ref /
 *   pos_conflict / id_taken / missing_parent）
 */
export function validate(head: Head, world: World, req: WriteRequest): CommitResult {
  if (!hasForm(req)) return verdictOf(false, 'bad_form', head)
  const refErr = checkRefs(world, req)
  if (refErr) return verdictOf(false, refErr, head)
  if (req.target.expect_pos !== head.hash) return verdictOf(false, 'pos_conflict', head)
  const gateErr = checkGates(world, req)
  if (gateErr) return verdictOf(false, gateErr, head)
  return verdictOf(true, null, head)
}

/**
 * 把写请求转成一条 entry：只构造、不校验、不应用；`argsHash` 是输出位，留占位待回填。
 * @param head 链头（KernelInput.head）：seq = head.seq + 1（首条 0），prev = head.hash（首条 null）
 * @param req 写请求：op/args/by/ref 原样进 entry
 * @param now 时间戳（KernelInput.now，内核不自读时钟）
 */
export function entryOf(head: Head, req: WriteRequest, now: number): Entry {
  return {
    seq: head.seq + 1,
    prev: head.hash,
    op: req.op,
    args: req.args,
    argsHash: 'placeholder', // 输出位占位；commit 在 applyEntry 之后回填
    by: req.by,
    ref: req.ref,
    at: now,
  }
}

/**
 * 唯一写口：validate → entryOf → applyEntry（恰一次，不改 `e`）→
 * 回填 argsHash（全库唯一回填点）→ entryHash（O(1)）。就地修改调用方独占的世界副本。
 * @param head 链头；@param world 调用方独占副本（成功路径就地演化）；@param req 写请求；
 * @param now 来自 KernelInput.now 的时间戳（内核不自读时钟）
 * @returns verdict + entry/hash；entry=null = 被拒或幂等命中（dup，pos = 未变的 head.hash）
 * @throws KernelError 直达自 applyEntry 的语义违例（bad_selfref / no_identity / …）——
 *   错误一律在 run 的最外层 catch 收敛为 refused；batch 段 2 子操作失败不外抛，转 ok:false 判决
 */
export function commit(head: Head, world: World, req: WriteRequest, now: number): CommitOutcome {
  const v = validate(head, world, req)
  if (!v.ok) return { verdict: v, entry: null, hash: null }
  const e = entryOf(head, req, now)
  const r = applyEntry(world, e)
  if (!r.ok) {
    // 只有 batch 段 2 可达（undo 已回滚，世界分文未动）：转拒绝，不断言
    return {
      verdict: { ok: false, reasons: [r.error], pos: head.hash, written: [] },
      entry: null,
      hash: null,
    }
  }
  e.argsHash = r.argsHash
  if (r.isNoop) {
    return { verdict: { ...v, reasons: ['dup'], pos: head.hash }, entry: null, hash: null }
  }
  const h = entryHash(e)
  return { verdict: { ...v, pos: h, written: r.written }, entry: e, hash: h }
}

/**
 * 依附判定：def 相对身份当前世代是否失效。不兼容即隔离，不删除。
 * 口径（写死）：sig 只在两侧都非 null 时比较（乐观）；pins 精确断言，单侧缺即坏（保守）；
 * sig/pins 双缺 → 恒 false；身份不存在或 retired（active 为 null）→ true。
 */
export function stale(def: Def, world: World, identityId: string): boolean {
  const identity = world.ids[identityId]
  if (!identity) return true
  const gen = identity.gens.find((g) => g.payload === identity.active)
  if (!gen) return true
  if (def.sig != null && gen.sig != null && def.sig !== gen.sig) return true
  for (const [name, h] of Object.entries(def.pins ?? {})) {
    if ((gen.pins[name] ?? null) !== h) return true
  }
  return false
}
