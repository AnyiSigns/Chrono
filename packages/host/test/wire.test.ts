import { describe, expect, it } from 'vitest'
import { MAX_FRAME_BYTES, createFrameDecoder, encodeFrame } from '../wire.ts'

describe('入站线格式 wire', () => {
  it('encodeFrame → 解码器往返得到原消息', () => {
    const decoder = createFrameDecoder()
    const message = { v: '1', id: 'x', kind: 'status' }
    expect(decoder.push(Buffer.from(encodeFrame(message)))).toEqual([message])
  })

  it('分片到达：不足一帧不产出，补齐后一次产出', () => {
    const decoder = createFrameDecoder()
    const message = { v: '1', id: 'a', kind: 'commands' }
    const frame = Buffer.from(encodeFrame(message))
    expect(decoder.push(frame.subarray(0, 2))).toEqual([])
    expect(decoder.push(frame.subarray(2))).toEqual([message])
  })

  it('长度前缀 > 16 MiB → frame_too_large', () => {
    const decoder = createFrameDecoder()
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => decoder.push(prefix)).toThrow('frame_too_large')
  })

  it('帧内 JSON 非法 → 解码器抛错', () => {
    const decoder = createFrameDecoder()
    const body = Buffer.from('{', 'utf8')
    const frame = Buffer.allocUnsafe(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)
    expect(() => decoder.push(frame)).toThrow()
  })
})
