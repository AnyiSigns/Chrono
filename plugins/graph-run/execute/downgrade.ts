// 降级判定（§15）：`agent.step` 失败（error 值 / 拒绝码）→ 判定是否降级 →
// `port.call router.select`（候选端口名 = 本插件 pins 的端口名；别名清单另传）→ 以返回端口名再 `port.call` 备选实现。
// 候选 / 别名的选择语义归 `router.select` 判定（terms/select.json）；本文件只汇集调用方事实并消费返回值，
// 不再自行把别名并入候选。无别名候选时 select 恒返回主名（机械 no-op）；降级规则数据住 thresholds。

import { asStringArray, isRecord } from './plan.ts'
import type { PortCaller, Rec } from './types.ts'

export interface DowngradeChoice {
  port: string
  candidates: string[]
  aliases: string[]
}

/** 候选端口名清单：本插件 pins 主名 ∪ pins 的端口名。别名清单另传，由 `router.select` 做交集选择。 */
export function downgradeCandidates(
  pins: Rec,
  thresholds: Rec,
  primary: string,
): { candidates: string[]; aliases: string[] } {
  const aliases = asStringArray(thresholds['model_alias_pins']).filter((name) => name.length > 0)
  const names = new Set<string>([primary, ...Object.keys(pins)])
  return { candidates: [...names], aliases }
}

/**
 * 经 `router.select` 选降级端口；返回 null 表示不降级（无别名 / 传输失败 / 选中主名）。
 * 返回的端口名由 router 契约保证在候选清单内；此处仍按 `port` 消费。
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
  const outcome = await port.call('router', 'select', {
    candidates,
    failure: failureCode,
    aliases,
    primary,
  })
  if (!outcome.ok) return null
  const chosen = asStringValue(outcome.value)
  if (chosen === null || chosen === primary) return null
  return { port: chosen, candidates, aliases }
}

function asStringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (isRecord(value) && typeof value['port'] === 'string') return value['port'] as string
  return null
}
