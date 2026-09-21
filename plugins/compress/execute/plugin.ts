// 从同包 `plugin.json` 派生服务自述（服务自述与声明一致；服务不 import 宿主与内核）。
// 读不到时回落到安全缺省，保证服务仍能起（宿主握手会按声明做机械校验）。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import type { Json, Rec } from './types.ts'

const CAPABILITY = 'compress'

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPlugin(): Rec {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read plugin.json: ${(err as Error).message}`)
  }
  return {}
}

const PLUGIN = readPlugin()

export const IDENTITY: string =
  typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : CAPABILITY

export const IMPLEMENTS: string[] = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : [CAPABILITY]

export const METHODS: Rec = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : {}

export const PROTOCOL: string =
  typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'

export const STATE: string =
  typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'
