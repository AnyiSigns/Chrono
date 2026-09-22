// 策略参数：声明住 `schema/memory-maintenance.json` 顶层 `params`（世界数据、可热改），
// 服务启动时读自身包内 schema 文件作缺省，调用方可在 args 里按次覆盖。
// 数值一律有界；非法 / 缺失回落缺省，不炸服务。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import { integerField, isRecord, numberField } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 记忆维护策略参数（与 schema.params 一一对应）。 */
export interface MaintenanceParams {
  l1TtlMs: number
  l2Capacity: number
  l3Capacity: number
  dedupThreshold: number
  weightThreshold: number
  candidateThreshold: number
  solidifyFullSources: number
}

const FALLBACK: MaintenanceParams = {
  l1TtlMs: 24 * 60 * 60 * 1000,
  l2Capacity: 200,
  l3Capacity: 500,
  dedupThreshold: 0.9,
  weightThreshold: 0.7,
  candidateThreshold: 0.2,
  solidifyFullSources: 4,
}

function positiveInt(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function ratio(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
}

let cached: MaintenanceParams | null = null

/** 读自身包内 schema 的 `params`（缺省来源）；读不到回落常量。 */
export function schemaParams(): MaintenanceParams {
  if (cached !== null) return cached
  try {
    const text = readFileSync(new URL('../schema/memory-maintenance.json', import.meta.url), 'utf8')
    const parsed: Json = JSON.parse(text)
    const raw = isRecord(parsed) && isRecord(parsed['params']) ? (parsed['params'] as Rec) : {}
    cached = {
      l1TtlMs: positiveInt(raw['l1_ttl_ms'], FALLBACK.l1TtlMs),
      l2Capacity: positiveInt(raw['l2_capacity'], FALLBACK.l2Capacity),
      l3Capacity: positiveInt(raw['l3_capacity'], FALLBACK.l3Capacity),
      dedupThreshold: ratio(raw['dedup_cosine_threshold'], FALLBACK.dedupThreshold),
      weightThreshold: ratio(raw['consolidate_weight_threshold'], FALLBACK.weightThreshold),
      candidateThreshold: ratio(raw['candidate_weight_threshold'], FALLBACK.candidateThreshold),
      solidifyFullSources: positiveInt(raw['solidify_full_sources'], FALLBACK.solidifyFullSources),
    }
  } catch (err) {
    log(`cannot read schema params: ${(err as Error).message}`)
    cached = FALLBACK
  }
  return cached
}

/** schema 缺省 + args 覆盖（覆盖值形态非法即拒 `bad_args`）。 */
export function resolveParams(args: Rec): MaintenanceParams {
  const base = schemaParams()
  return {
    l1TtlMs: integerField(args['l1_ttl_ms'], 'l1_ttl_ms', base.l1TtlMs, 1),
    l2Capacity: integerField(args['l2_capacity'], 'l2_capacity', base.l2Capacity, 1),
    l3Capacity: integerField(args['l3_capacity'], 'l3_capacity', base.l3Capacity, 1),
    dedupThreshold: numberField(args['dedup_threshold'], 'dedup_threshold', base.dedupThreshold, 0, 1),
    weightThreshold: numberField(args['weight_threshold'], 'weight_threshold', base.weightThreshold, 0, 1),
    candidateThreshold: numberField(
      args['candidate_threshold'],
      'candidate_threshold',
      base.candidateThreshold,
      0,
      1,
    ),
    solidifyFullSources: integerField(
      args['solidify_full_sources'],
      'solidify_full_sources',
      base.solidifyFullSources,
      1,
    ),
  }
}
