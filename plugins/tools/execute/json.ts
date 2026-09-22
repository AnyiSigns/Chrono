// 规范 JSON 序列化与结构相等：缓存键（canonicalJson）与 enum / const 判定（deepEq）共用。
// 与内核同口径（一种值模型、键序确定），但不 import 内核——本模块自带实现。

import { isRecord } from './types.ts'
import type { Json } from './types.ts'

function stringify(value: Json | undefined): string {
  if (value === undefined) return 'null'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stringify(item)).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) as string
}

/** 规范序列化：对象键排序、无空白；同值恒同串（作缓存键）。 */
export function canonicalJson(value: Json): string {
  return stringify(value)
}

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
