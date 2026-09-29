// 策略参数：调用方（留守门面）可随 args 传入；缺省回落原维护服务同口径常量。

import { integerField } from './plan.ts'
import type { Rec } from './types.ts'

/** L1 维护策略参数。 */
export interface L1Params {
  l1TtlMs: number
}

const FALLBACK: L1Params = {
  l1TtlMs: 24 * 60 * 60 * 1000,
}

/** args 覆盖；形态非法即拒 `bad_args`，缺省回落缺省。 */
export function resolveParams(args: Rec): L1Params {
  return {
    l1TtlMs: integerField(args['l1_ttl_ms'], 'l1_ttl_ms', FALLBACK.l1TtlMs, 1),
  }
}
