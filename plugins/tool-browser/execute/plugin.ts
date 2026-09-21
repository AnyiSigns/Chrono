// 同包 plugin.json 派生服务自述常量（服务自述与声明一致，不重复硬编码）。

import { readFileSync } from 'node:fs'
import type { Json, Rec } from './types.ts'

/** 身份名 = 能力类名。 */
export const IDENTITY = 'tool-browser'
/** 协议版本。 */
export const PROTOCOL = '1'
/** 状态档：v1 只允许可重算。 */
export const STATE = 'recomputable'

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPlugin(): Rec {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch {
    // 读取失败回落内建常量：服务仍可自述最小形态。
  }
  return {}
}

const PLUGIN = readPlugin()

export const IMPLEMENTS: string[] = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : [IDENTITY]

export const METHODS: Rec = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : { [IDENTITY]: ['describe', 'invoke'] }
