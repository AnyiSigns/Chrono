// sandbox net 策略的纯 TS 单源：内建档位映射 / 声明 net 归一 / 档位 net 解析 / 范围序。
// 语义拥有方是 `sandbox-policy`；插件侧（graph-run / tool-dispatch / guard / tool-browser）
// 共享本模块，避免跨插件 import。Rust 侧 `tiers.rs`（sandbox-policy / sandbox-fs /
// sandbox-exec）无法引用本模块，保留各自拷贝，不在此任务内强行对齐。
// 纯函数，零内核零宿主依赖。

import type { Json } from './json.ts'
import { isRecord } from './json.ts'

/** net 范围：none < limited < all。 */
export type NetScope = 'none' | 'limited' | 'all'

/** 内建档位 net 映射（与 sandbox-policy tools/default-body.json 同形）。 */
export const BUILTIN_TIER_NET: Record<string, NetScope> = {
  auto: 'all',
  severe: 'limited',
  review: 'none',
  deny: 'none',
}

/** 解析 net 范围：只认字符串 none / limited / all；其余（缺失 / 布尔 / 未知串）回 null。 */
export function parseScope(value: Json | undefined): NetScope | null {
  return value === 'none' || value === 'limited' || value === 'all' ? value : null
}

/** 规范化 net 范围：只认 none / limited / all，其余视为 none。 */
export function netScope(value: Json | undefined): NetScope {
  return parseScope(value) ?? 'none'
}

/** net 范围序：none < limited < all。 */
export function netRank(scope: string): number {
  return scope === 'all' ? 2 : scope === 'limited' ? 1 : 0
}

/** 工具声明的 net 需求：从 caps.net 取（只认字符串 none / limited / all；缺失 / 畸形按 none）。 */
export function declaredNetOf(caps: Json | undefined): NetScope {
  const net = isRecord(caps) ? caps['net'] : undefined
  return netScope(net)
}

/** 当前档位的 net 范围：sandbox_tiers 覆盖 > 内建；未知 / 缺失档位 fail-closed none。 */
export function tierNetOf(tier: Json | undefined, sandboxTiers: Json | undefined): NetScope {
  const tiers = isRecord(sandboxTiers) ? sandboxTiers['tiers'] : undefined
  if (typeof tier === 'string' && isRecord(tiers)) {
    const entry = tiers[tier]
    if (isRecord(entry)) {
      const declared = parseScope(entry['net'])
      if (declared !== null) return declared
    }
  }
  if (typeof tier === 'string' && tier in BUILTIN_TIER_NET) return BUILTIN_TIER_NET[tier]
  return 'none'
}
