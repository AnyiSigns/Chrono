// 从同包 `schema/approval.json` 派生自用参数（服务不 import 宿主与内核）。
// 读不到时回落安全缺省，保证服务仍能起。
// 调用方可经 bag / args 覆盖超时 / 容量 / 归档保留数（缺省读 schema）。

import { readFileSync } from 'node:fs'
import { makeLogger } from 'plugin-sdk'
import { isRecord, type Rec } from './plan.ts'
import type { Json } from './types.ts'

const log = makeLogger('approval')
const DEFAULT_TIMEOUT_MS = 600000
const DEFAULT_CAPACITY = 64

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

const SCHEMA = readJson('../schema/approval.json')

export interface ApprovalPolicy {
  timeoutMs: number | null
  capacity: number
  capacityScope: 'pending' | 'live'
  archiveKeep: number
}

function positiveInt(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** 超时 / 容量 / 裁决策略：schema 缺省 + args 覆盖（覆盖仅接受合法值，非法忽略）。 */
export function approvalPolicy(overrides?: Rec): ApprovalPolicy {
  const schemaTimeout = SCHEMA['timeout_ms']
  let timeoutMs: number | null = DEFAULT_TIMEOUT_MS
  if (schemaTimeout === null) timeoutMs = null
  else if (positiveInt(schemaTimeout) !== null) timeoutMs = positiveInt(schemaTimeout)

  let capacity = positiveInt(SCHEMA['capacity']) ?? DEFAULT_CAPACITY

  const schemaPolicy = isRecord(SCHEMA['policy']) ? (SCHEMA['policy'] as Rec) : {}
  let capacityScope: 'pending' | 'live' =
    schemaPolicy['capacity_scope'] === 'live' ? 'live' : 'pending'
  let archiveKeep = positiveInt(schemaPolicy['archive_keep']) ?? capacity

  if (overrides !== undefined) {
    if (overrides['timeout_ms'] === null) timeoutMs = null
    else if (positiveInt(overrides['timeout_ms']) !== null) timeoutMs = positiveInt(overrides['timeout_ms'])
    const overrideCapacity = positiveInt(overrides['capacity'])
    if (overrideCapacity !== null) capacity = overrideCapacity
    const overrideKeep = positiveInt(overrides['archive_keep'])
    if (overrideKeep !== null) archiveKeep = overrideKeep
    if (overrides['capacity_scope'] === 'live') capacityScope = 'live'
    else if (overrides['capacity_scope'] === 'pending') capacityScope = 'pending'
  }
  if (archiveKeep > capacity) archiveKeep = capacity
  return { timeoutMs, capacity, capacityScope, archiveKeep }
}
