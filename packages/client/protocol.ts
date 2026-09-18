// 入站协议形状（客户端侧视图）。

import type { Json } from '../kernel/index.ts'

export const PROTOCOL_VERSION = '1'

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
  | { v: string; id: string; kind: 'state'; world_head: Json; loaded: Json[] }
  | { v: string; id: string; kind: 'error'; code: string; message: string }
  | { v: string; impl: string; kind: 'event'; topic: string; payload: Json }
