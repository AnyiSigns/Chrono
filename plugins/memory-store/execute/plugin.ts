// 从 `schema/memory.json` 派生索引版本锚（服务不 import 宿主与内核）。
// 读不到时回落到安全缺省，保证服务仍能起（宿主握手会按声明做机械校验）。

import { readFileSync } from 'node:fs'
import { log } from './log.ts'
import type { Json, Rec } from './types.ts'

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

const SCHEMA = readJson('../schema/memory.json')

/** 索引版本锚：schema 顶层 `model.{id,dim}`；缺省 granite-97m / 384。 */
export const ANCHOR: { id: string; dim: number } = (() => {
  const model = SCHEMA['model']
  if (!isRecord(model)) return { ...DEFAULT_MODEL }
  const id =
    typeof model['id'] === 'string' && model['id'].length > 0
      ? (model['id'] as string)
      : DEFAULT_MODEL.id
  const dim =
    typeof model['dim'] === 'number' &&
    Number.isInteger(model['dim']) &&
    (model['dim'] as number) > 0
      ? (model['dim'] as number)
      : DEFAULT_MODEL.dim
  return { id, dim }
})()
