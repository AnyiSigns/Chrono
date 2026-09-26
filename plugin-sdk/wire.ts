// 服务协议帧编解码（docs/protocol.md §一 / §二）：4 字节大端长度 + 规范序列化 UTF-8 JSON。
// 零内核零宿主依赖：规范序列化自带（`canonical.ts`），与宿主线格式逐字节一致。

import { canonicalJson } from './canonical.ts'
import type { Json } from './json.ts'

/** 服务协议版本；与 `plugin.json.protocol` 同源口径。 */
export const SERVICE_PROTOCOL_VERSION = '1'

/** 单帧上限：与宿主 / 客户端解码器一致（16 MiB）。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** 服务 → 宿主 / 调用方的出站帧种类。 */
export const SERVICE_OUTBOUND_KINDS = Object.freeze([
  'manifest',
  'pong',
  'ack',
  'bye',
  'result',
  'error',
  'event',
  'port.call',
] as const)

/** 出站帧种类联合。 */
export type ServiceOutboundKind = (typeof SERVICE_OUTBOUND_KINDS)[number]

/** 宿主 / 调用方 → 服务的入站帧种类（控制面与能力调用）。 */
export const SERVICE_INBOUND_KINDS = Object.freeze([
  'hello',
  'probe',
  'reload',
  'drain',
  'call',
  'port.result',
  'port.error',
] as const)

/** 入站帧种类联合。 */
export type ServiceInboundKind = (typeof SERVICE_INBOUND_KINDS)[number]

/** 把一条消息编码为一帧（长度前缀 + 规范 JSON 字节）。 */
export function encodeFrame(message: Json): Buffer {
  const body = Buffer.from(canonicalJson(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/** 写一帧到 stdout（stdio 形态的唯一协议出口；日志一律走 stderr）。 */
export function writeFrame(message: Json): void {
  process.stdout.write(encodeFrame(message))
}

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
