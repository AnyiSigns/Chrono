// 策略参数：调用方（留守门面）可随 args 传入；缺省回落原维护服务同口径常量。

import { integerField, numberField } from './plan.ts'
import type { Rec } from './types.ts'

/** L2 维护策略参数。 */
export interface L2Params {
  dedupThreshold: number
  l2Capacity: number
}

const FALLBACK: L2Params = {
  dedupThreshold: 0.9,
  l2Capacity: 200,
}

/** args 覆盖；形态非法即拒 `bad_args`，缺省回落缺省。 */
export function resolveParams(args: Rec): L2Params {
  return {
    dedupThreshold: numberField(
      args['dedup_threshold'],
      'dedup_threshold',
      FALLBACK.dedupThreshold,
      0,
      1,
    ),
    l2Capacity: integerField(args['l2_capacity'], 'l2_capacity', FALLBACK.l2Capacity, 1),
  }
}
