// 技能清单是运行记录（内联清单 + 结构化触发 + 作用域），已出世界。
// 本文件只提供 JSON 形态判定与合并纯函数，不构造世界写计划。

import type { Json, Rec } from './types.ts'

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深合并：`null` 值删除该键；两值皆对象则递归；否则整值替换。返回新对象，不改入参。 */
export function applyPatch(base: Rec, patch: Rec): Rec {
  const next: Rec = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key]
      continue
    }
    const current = next[key]
    if (isRecord(value) && isRecord(current)) {
      next[key] = applyPatch(current, value)
      continue
    }
    next[key] = value
  }
  return next
}

/** 结构相等（用于幂等短路）。 */
export function canonicalEqual(left: Json, right: Json): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
