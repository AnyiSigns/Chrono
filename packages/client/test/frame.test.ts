import { describe, expect, it } from 'vitest'
import { createFrameDecoder, encodeFrame } from '../frame.ts'

const MAX_FRAME_BYTES = 16 * 1024 * 1024

describe('客户端线格式 frame', () => {
  it('encodeFrame → 解码器往返得到原消息', () => {
    const decoder = createFrameDecoder()
    const message = { v: '1', id: 'x', kind: 'status' }
    expect(decoder.push(Buffer.from(encodeFrame(message)))).toEqual([message])
  })

  it('长度前缀 > 16 MiB → frame_too_large', () => {
    const decoder = createFrameDecoder()
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => decoder.push(prefix)).toThrow('frame_too_large')
  })
})
