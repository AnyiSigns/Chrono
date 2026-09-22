// 从同包 `plugin.json` 派生服务自述，从 `schema/memory.json` 派生索引版本锚（服务自述与声明一致）。
// 读不到时回落到安全缺省，保证服务仍能起（宿主握手会按声明做机械校验）。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import type { Json, Rec } from './types.ts'

const CAPABILITY = 'memory'
const DEFAULT_MODEL = { id: 'granite-97m', dim: 384 }

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
const SCHEMA = readJson('../schema/memory.json')

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

/** 索引版本锚：schema 顶层 `model.{id,dim}`；缺省 granite-97m / 384。 */
export const ANCHOR: { id: string; dim: number } = (() => {
  const model = SCHEMA['model']
  if (!isRecord(model)) return { ...DEFAULT_MODEL }
  const id = typeof model['id'] === 'string' && model['id'].length > 0 ? (model['id'] as string) : DEFAULT_MODEL.id
  const dim =
    typeof model['dim'] === 'number' && Number.isInteger(model['dim']) && (model['dim'] as number) > 0
      ? (model['dim'] as number)
      : DEFAULT_MODEL.dim
  return { id, dim }
})()
