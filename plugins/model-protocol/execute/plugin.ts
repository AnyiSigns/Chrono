// 从同包 `plugin.json` 与 `schema/protocol.json` 派生服务自述与自用参数
// （服务自述与声明一致；服务不 import 宿主与内核）。读不到时回落安全缺省，保证服务仍能起。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import type { Json, Rec } from './types.ts'

const CAPABILITY = 'model'

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(relative: string): Rec {
  try {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read ${relative}: ${(err as Error).message}`)
  }
  return {}
}

const PLUGIN = readJson('../plugin.json')
const SCHEMA = readJson('../schema/protocol.json')

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

/** schema 顶层自用键（宿主只读 periodic / method_timeouts，其余归本插件）。 */
export function schemaConfig(): Rec {
  return isRecord(SCHEMA['resilience']) ? (SCHEMA['resilience'] as Rec) : {}
}
