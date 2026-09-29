// 策略参数：调用方（留守门面）可随 args 传入；缺省回落原维护服务同口径常量。

import { integerField, numberField } from './plan.ts'
import type { Rec } from './types.ts'

/** L3 维护策略参数。 */
export interface L3Params {
  l3Capacity: number
  dedupThreshold: number
  weightThreshold: number
  candidateThreshold: number
  solidifyFullSources: number
}

const FALLBACK: L3Params = {
  l3Capacity: 500,
  dedupThreshold: 0.9,
  weightThreshold: 0.7,
  candidateThreshold: 0.2,
  solidifyFullSources: 4,
}

/** args 覆盖；形态非法即拒 `bad_args`，缺省回落缺省。 */
export function resolveParams(args: Rec): L3Params {
  return {
    l3Capacity: integerField(args['l3_capacity'], 'l3_capacity', FALLBACK.l3Capacity, 1),
    dedupThreshold: numberField(
      args['dedup_threshold'],
      'dedup_threshold',
      FALLBACK.dedupThreshold,
      0,
      1,
    ),
    weightThreshold: numberField(
      args['weight_threshold'],
      'weight_threshold',
      FALLBACK.weightThreshold,
      0,
      1,
    ),
    candidateThreshold: numberField(
      args['candidate_threshold'],
      'candidate_threshold',
      FALLBACK.candidateThreshold,
      0,
      1,
    ),
    solidifyFullSources: integerField(
      args['solidify_full_sources'],
      'solidify_full_sources',
      FALLBACK.solidifyFullSources,
      1,
    ),
  }
}
