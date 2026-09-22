// 降级判定（§15）：`agent.step` 失败（error 值 / 拒绝码）→ 规则判定是否降级 →
// `port.call router.select`（候选端口名清单 = 本插件 pins 主名 + 别名）→ 以返回端口名再 `port.call` 备选实现。
// 无别名候选时 select 恒返回主名（机械 no-op）；判定逻辑住 execute，降级规则（别名 pin 名）住 thresholds。

import { asStringArray, isRecord } from './plan.ts'
import type { PortCaller, Rec } from './types.ts'

export interface DowngradeChoice {
  port: string
  candidates: string[]
  aliases: string[]
}

/** 候选端口名清单：pins 主名 ∪ 别名（别名 = thresholds.model_alias_pins，缺省空 ⇒ 机械 no-op）。 */
export function downgradeCandidates(pins: Rec, thresholds: Rec, primary: string): { candidates: string[]; aliases: string[] } {
  const aliases = asStringArray(thresholds['model_alias_pins']).filter((name) => name.length > 0)
  const names = new Set<string>([primary, ...Object.keys(pins), ...aliases])
  return { candidates: [...names], aliases }
}

/**
 * 经 `router.select` 选降级端口；返回 null 表示不降级（无别名 / 传输失败 / 选中主名）。
 * 返回的端口名必在候选清单内（router 契约）。
 */
export async function resolveDowngrade(
  port: PortCaller,
  pins: Rec,
  thresholds: Rec,
  failureCode: string,
  primary = 'model',
): Promise<DowngradeChoice | null> {
  const { candidates, aliases } = downgradeCandidates(pins, thresholds, primary)
  if (aliases.length === 0) return null
  const outcome = await port.call('router', 'select', { candidates, failure: failureCode, aliases, primary })
  if (!outcome.ok) return null
  const chosen = asStringValue(outcome.value)
  if (chosen === null || chosen === primary || !candidates.includes(chosen)) return null
  return { port: chosen, candidates, aliases }
}

function asStringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (isRecord(value) && typeof value['port'] === 'string') return value['port'] as string
  return null
}
