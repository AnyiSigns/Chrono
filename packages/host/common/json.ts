// 宿主内共享的 JSON 形态判定：对象 / 字符串数组 / 字符串映射 / 原型键集。
// 单一真源，避免同一判定在宿主各处被抄成多份而漂移。

import type { Json } from '../../kernel/index.ts'

/**
 * JS 原型键：作为对象键会命中继承成员（`obj[key]` 不为 undefined），
 * 凡读取外部数据构造对象键 / 路径段处一律显式拒绝。
 */
export const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

/** 非 null、非数组的 JSON 对象。 */
export function isRecord(value: unknown): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 同 `isRecord`，形态不符返回 null（调用方按缺失处理）。 */
function recordOrNull(value: unknown): { [k: string]: Json } | null {
  return isRecord(value) ? value : null
}

export { recordOrNull as asRecord }

/** 字符串数组。 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 值全为字符串的映射。 */
export function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

/** JSON 值的序列化体量近似（字符数）；序列化异常按 0 计。 */
export function jsonByteLength(value: Json): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}
