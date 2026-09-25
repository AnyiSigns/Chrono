// 服务协议帧编解码与 stdio 读写（docs/protocol.md §一 / §二）。
// 4 字节大端长度 + UTF-8 JSON；stdout 只许协议帧，日志一律走 stderr。

import type { Json } from './types.ts'

/** 单帧上限：与宿主 / 客户端解码器一致（16 MiB）。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export function encodeFrame(message: Json): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

export function writeFrame(message: Json): void {
  process.stdout.write(encodeFrame(message))
}

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

export function log(line: string): void {
  process.stderr.write(`[input] ${line}\n`)
}
