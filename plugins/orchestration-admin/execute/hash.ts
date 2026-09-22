// 内容哈希（与内核同口径，本包内自实现，不 import 内核）：H = sha256(utf8(canonicalJson(v)))。
// 本插件的 validate 结果哈希、提案 patch 引用的 def 哈希都走此口径；规范序列化与内核 value.ts
// 的 canonicalJson 保持同口径（键升序、剔 undefined、-0→0），保证同输入同输出、可对拍。

import { createHash } from 'node:crypto'
import type { Json } from './types.ts'

function typeTag(v: Json | undefined): 'none' | 'bool' | 'num' | 'str' | 'list' | 'json' {
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return 'num'
  if (typeof v === 'string') return 'str'
  if (Array.isArray(v)) return 'list'
  if (v === null || v === undefined) return 'none'
  return 'json'
}

function canon(v: Json | undefined, depth: number): string {
  if (depth > 64) throw new Error('depth')
  if (v === undefined) throw new Error('undefined')
  switch (typeTag(v)) {
    case 'none':
      return 'null'
    case 'bool':
      return v ? 'true' : 'false'
    case 'num': {
      const n = v as number
      if (!Number.isFinite(n)) throw new Error('nonfinite')
      return String(n === 0 ? 0 : n)
    }
    case 'str':
      return JSON.stringify(v)
    case 'list': {
      const items = v as Json[]
      return `[${items.map((item) => canon(item, depth + 1)).join(',')}]`
    }
    default: {
      const record = v as { [k: string]: Json }
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
      const fields = keys.map((key) => `${JSON.stringify(key)}:${canon(record[key], depth + 1)}`)
      return `{${fields.join(',')}}`
    }
  }
}

/** 规范序列化（内核口径）。 */
export function canonicalJson(v: Json | undefined): string {
  return canon(v, 0)
}

/** 内容哈希：hex(sha256(utf8(canonicalJson(v))))。 */
export function H(v: Json | undefined): string {
  return createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex')
}
