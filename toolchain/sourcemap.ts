// 源映射：把内核错误里的失败节点路径（降级后 AST 坐标）映射回糖化源 JSON 指针。
// 零内核依赖。只处理「直接对应」的糖化键；`let`/`bind` 是写期展开，落到它们时只能给近似指针（approx=true）。

import type { Json } from './lower.ts'

export interface SourceAt {
  /** 相对该 term 根的 JSON 指针（根为 ''，子节点如 '/if/then/pred/a'）。 */
  pointer: string
  /** true = 因写期宏展开等原因，指针只到最近的可见节点，不精确。 */
  approx: boolean
}

/** AST 段号 → 糖化子键（仅「直接对应」的键）。 */
const CHILD_KEY: Record<string, Record<number, string>> = {
  if: { 1: 'cond', 2: 'then', 3: 'else' },
  pred: { 2: 'a', 3: 'b' },
  arith: { 2: 'a', 3: 'b' },
  get: { 1: 'of' },
  getOr: { 1: 'of', 3: 'fallback' },
  list: { 1: 'items' },
  obj: { 1: 'fields' },
  fold: { 1: 'coll', 2: 'init', 3: 'step' },
  eff: { 3: 'args' },
  call: { 1: 'ref', 2: 'args' },
}

function isRecord(v: unknown): v is { [k: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 把失败节点路径 `at` 映射为糖化源指针。
 * @param sugar 该 term 的糖化表达式
 * @param at 内核错误里的失败节点路径（降级后 AST 坐标）
 */
export function sourceAt(sugar: Json, at: Array<string | number>): SourceAt {
  let cur: unknown = sugar
  let pointer = ''
  for (const seg of at) {
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number' || seg < 0 || seg >= cur.length) return { pointer, approx: true }
      pointer += `/${seg}`
      cur = cur[seg]
      continue
    }
    if (!isRecord(cur)) return { pointer, approx: true }
    const k = cur['k']
    if (k === 'let' || k === 'bind') {
      return { pointer, approx: true } // 写期宏展开后无法精确回溯
    }
    if (typeof k !== 'string') {
      // 无 `k` 的普通记录（如 `obj.fields` 的字段 bag）：按字面键下钻
      if (typeof seg === 'string' && Object.hasOwn(cur, seg)) {
        pointer += `/${seg}`
        cur = cur[seg]
        continue
      }
      return { pointer, approx: true }
    }
    const key = CHILD_KEY[k]?.[seg as number]
    if (key === undefined) {
      return { pointer, approx: false } // 直接量类 / 非节点段：停在当前节点
    }
    pointer += `/${key}`
    cur = cur[key]
  }
  return { pointer, approx: false }
}
