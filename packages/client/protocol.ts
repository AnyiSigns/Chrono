// 入站协议形状（客户端侧视图）。

import type { Json } from '../kernel/index.ts'

export const PROTOCOL_VERSION = '1'

/**
 * 单资产原始字节上限：与宿主 `host/assets.ts` 的 `MAX_ASSET_BYTES` 同口径
 * （契约见 `docs/protocol.md` 资产面；两侧边界独立、不跨包共享），供 `putAsset` 入口前置收口。
 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024

export interface Limits {
  gas: number
  depth: number
}

export type OutboundMessage =
  | { v: string; id: string; kind: 'accepted'; run?: string }
  | { v: string; kind: 'result'; run: string; status: string; observations: Json[] }
  | { v: string; id: string; kind: 'result'; status: string; observations: Json[] }
  | { v: string; id: string; kind: 'list'; commands: Json[] }
  | { v: string; id: string; kind: 'audits'; records: Json[]; truncated: boolean }
  | { v: string; id: string; kind: 'asset.ref'; ref: Json }
  | { v: string; id: string; kind: 'asset.bytes'; sha256: string; size: number; bytes: string }
  | { v: string; id: string; kind: 'secrets.ok'; name: string }
  | { v: string; id: string; kind: 'state'; world_head: Json; world_rev: Json; loaded: Json[] }
  | { v: string; id: string; kind: 'error'; code: string; message: string }
  | { v: string; impl: string; kind: 'event'; topic: string; payload: Json }
