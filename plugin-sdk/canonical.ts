// 规范序列化：键按 code-unit 升序、剔除 undefined 键、-0 归一为 0、最短往返数字表示。
// 零依赖自带实现，与宿主线格式所依赖的内核口径逐字节一致；SDK 不 import 内核。
// 内容哈希与帧字节的地基——两处同值必须逐字节同一串。

import type { Json } from './json.ts'

/** 递归序列化深度上限：与内核口径同源。 */
export const MAX_JSON_DEPTH = 64

/**
 * 规范序列化。
 * @param value 待序列化的值
 * @returns 规范化 JSON 串
 * @throws Error 顶层 undefined、非有限数、嵌套超过 `MAX_JSON_DEPTH`
 */
export function canonicalJson(value: Json | undefined): string {
  return canon(value, 0)
}

function canon(value: Json | undefined, depth: number): string {
  if (depth > MAX_JSON_DEPTH) throw new Error('depth')
  if (value === undefined) throw new Error('undefined')
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('nonfinite')
    return String(value === 0 ? 0 : value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const parts = new Array<string>(value.length)
    for (let i = 0; i < value.length; i++) parts[i] = canon(value[i], depth + 1)
    return `[${parts.join(',')}]`
  }
  const record = value as { [key: string]: Json }
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  const fields = new Array<string>(keys.length)
  for (let i = 0; i < keys.length; i++) {
    fields[i] = `${JSON.stringify(keys[i])}:${canon(record[keys[i]], depth + 1)}`
  }
  return `{${fields.join(',')}}`
}
