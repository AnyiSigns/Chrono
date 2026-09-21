// `caps.net` 声明级钳制（实现尽力）：不经 sandbox.exec，按档位映射在本插件内判定。
// 档位映射优先取 bag.sandbox_tiers（本身份数据世代 body），缺省回落内建——与 sandbox 的内建兜底同形。
// 声明越档 → net_denied（fail-closed）；未知 / 缺失档位全拒。
// sandbox 无独立「查 net」方法；`sandbox.capabilities` 只自述强制面（见 sandboxNetEnforcement），
// 真正的 net 判定在本插件内完成。

import { ToolError } from './types.ts'
import type { Json, Rec } from './types.ts'

export type NetScope = 'none' | 'limited' | 'all'

/** 内建档位 net 映射（与 sandbox 的 tools/default-body.json 同形；测试保证一致）。 */
export const BUILTIN_TIER_NET: Record<string, NetScope> = {
  auto: 'all',
  severe: 'limited',
  review: 'none',
  deny: 'none',
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** net 范围序：none < limited < all。 */
export function netRank(scope: NetScope): number {
  if (scope === 'all') return 2
  if (scope === 'limited') return 1
  return 0
}

function parseScope(value: Json | undefined): NetScope | null {
  return value === 'none' || value === 'limited' || value === 'all' ? value : null
}

/** 当前档位的 net 范围：bag.sandbox_tiers 覆盖 > 内建；未知 / 缺失档位 fail-closed none。 */
export function tierNetScope(tier: string | null, sandboxTiers: Json | undefined): NetScope {
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

/**
 * 工具声明的 net 需求：只认字符串 none / limited / all（与 sandbox `tiers.rs` 的
 * `NetScope::parse` 同口径）。布尔 / 缺失 / 畸形一律视为未声明（none），与 sandbox
 * `parse_caps` 对畸形 net 的回落一致。
 */
export function declaredNetScope(caps: Json | undefined): NetScope {
  const net = isRecord(caps) ? caps['net'] : undefined
  return parseScope(net) ?? 'none'
}

/**
 * 读 sandbox `capabilities` 自述的 net 强制模式（`enforcement.net`）。
 * 非对象 / 字段缺失 / 非字符串 → null（未知）。本插件消费该值以确认强制面口径。
 */
export function sandboxNetEnforcement(value: Json | undefined): string | null {
  if (!isRecord(value)) return null
  const enforcement = value['enforcement']
  if (!isRecord(enforcement)) return null
  const net = enforcement['net']
  return typeof net === 'string' && net.length > 0 ? net : null
}

/** 声明 net 是否在档位范围内；越档即 net_denied。 */
export function assertNetAllowed(tier: string | null, caps: Json | undefined, sandboxTiers: Json | undefined): void {
  const required = declaredNetScope(caps)
  if (required === 'none') return
  const allowed = tierNetScope(tier, sandboxTiers)
  if (netRank(required) > netRank(allowed)) {
    throw new ToolError('net_denied', `declared net ${required} exceeds tier net ${allowed}`)
  }
}
