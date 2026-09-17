// 入站面线格式（客户端侧）：4 字节大端长度 + 规范序列化的 UTF-8 JSON。
// 与服务端各自持有等价实现，两侧边界独立。

import { canonicalJson } from '../kernel/index.ts'
import type { Json } from '../kernel/index.ts'

export function encodeFrame(message: Json): Uint8Array {
  const body = Buffer.from(canonicalJson(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

export function createFrameDecoder(): { push: (chunk: Buffer) => Json[] } {
  let buffered: Buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): Json[] {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages: Json[] = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body) as Json)
      }
      return messages
    },
  }
}
