// 结构相等判定（enum / const 共用）；规范序列化由 plugin-sdk 提供（与内核同口径）。
// 本模块只保留插件自用的 `deepEq`，不 import 宿主与内核。

import { isRecord } from 'plugin-sdk'
import type { Json } from 'plugin-sdk'

export { canonicalJson } from 'plugin-sdk'

/** 结构相等：数组逐项、对象逐键（键集相同且值相等）。 */
export function deepEq(left: Json, right: Json): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEq(item, right[index]))
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEq(left[key], right[key]))
  }
  return false
}
