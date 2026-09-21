// 从同包 plugin.json 派生服务自述常量（服务自述与声明一致）。

import { readFileSync } from 'node:fs'
import { isRec } from './types.ts'
import type { Json, Rec } from './types.ts'

const CAPABILITY = 'tool-http'

function readPlugin(): Rec {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRec(parsed)) return parsed
  } catch {
    // 声明读不到时回落到内建身份常量，服务仍可握手。
  }
  return {}
}

const PLUGIN = readPlugin()

export const IDENTITY =
  typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : CAPABILITY
export const IMPLEMENTS = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : [CAPABILITY]
export const METHODS = isRec(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : {}
export const PROTOCOL = typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'
export const STATE = typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'
export const COMMANDS = Array.isArray(PLUGIN['commands']) ? (PLUGIN['commands'] as Json[]) : []
