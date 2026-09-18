// 入站协议与服务协议共用的线格式：4 字节大端长度 + 规范序列化的 UTF-8 JSON。
// 入站服务端与客户端各自持有本文件的等价实现（两侧边界独立，不跨包共享）。

import { canonicalJson } from '../kernel/index.ts'
import type { Directive, Json } from '../kernel/index.ts'

/** 入站协议版本；与 `plugin.json.protocol` 是两回事（后者属服务协议）。 */
export const PROTOCOL_VERSION = '1'

export interface Limits {
  gas: number
  depth: number
}

/** 发起者 → 宿主。 */
export type InboundMessage =
  | {
      v: string
      id: string
      kind: 'submit'
      directives: Directive[]
      caps?: Record<string, boolean>
      limits?: Limits
    }
  | {
      v: string
      id: string
      kind: 'command'
      name: string
      args?: Json
      caps?: Record<string, boolean>
      limits?: Limits
    }
  | { v: string; id: string; kind: 'cancel'; run: string }
  | { v: string; id: string; kind: 'audit'; filter?: Json }
  | { v: string; id: string; kind: 'asset.put'; mime: string; bytes: string }
  | { v: string; id: string; kind: 'asset.get'; sha256: string }
  | { v: string; id: string; kind: 'commands' }
  | { v: string; id: string; kind: 'status' }
  | { v: string; id: string; kind: 'stop' }

/** 宿主 → 发起者。 */
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

/** 把一条消息编码为一帧（长度前缀 + 规范 JSON 字节）。 */
export function encodeFrame(msg: Json): Uint8Array {
  const body = Buffer.from(canonicalJson(msg), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/** 单帧上限：防无界缓冲（本地客户端 / 服务也不许用超大长度前缀压内存）。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** 增量解码器：喂入任意分片的字节，产出已完整到达的消息；超限或坏 JSON 抛错。 */
export function createFrameDecoder(): { push: (chunk: Buffer) => Json[] } {
  let buffered: Buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): Json[] {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages: Json[] = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (length > MAX_FRAME_BYTES) throw new Error('frame_too_large')
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body) as Json)
      }
      return messages
    },
  }
}
