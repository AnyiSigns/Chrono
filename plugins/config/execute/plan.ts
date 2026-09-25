// 配置补丁应用与阈值切分的共享纯函数。
// 运行记录（ui / providers / vendor / model）出世界，住自有存储；判定阈值（permission / params）
// 仍镜像进世界（供门禁 / 重放从世界读），故本文件同时提供补丁合并与阈值切分。

import type { Json, Rec } from './types.ts'

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深合并补丁：`null` 值删除该键；两值皆对象则递归；否则整值替换。返回新对象，不改入参。 */
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

/** 判定阈值子集（留世界）：版本 + 权限档 + 模型参数；缺键不补。 */
export function thresholdsOf(body: Rec): Rec {
  const out: Rec = {}
  for (const key of ['version', 'permission', 'params']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key] as Json
  }
  return out
}

/** 结构相等（用于幂等短路 / 阈值是否变化）。 */
export function canonicalEqual(left: Json, right: Json): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
