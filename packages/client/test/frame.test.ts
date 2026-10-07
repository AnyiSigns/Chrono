import { describe, expect, it } from 'vitest'
import { createFrameDecoder, encodeFrame } from '../frame.ts'
import { MAX_FRAME_BYTES } from '../../host/wire.ts'

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

  it('编码超单帧上限 → frame_too_large（不写出脏帧）', () => {
    const blob = 'a'.repeat(MAX_FRAME_BYTES)
    expect(() => encodeFrame({ v: '1', id: 'big', kind: 'status', blob })).toThrow(
      'frame_too_large',
    )
  })

  it('客户端帧上限与服务端导出常量一致（相对导入断言，防两侧漂移）', () => {
    const atLimit = Buffer.alloc(4)
    atLimit.writeUInt32BE(MAX_FRAME_BYTES, 0)
    expect(() => createFrameDecoder().push(atLimit)).not.toThrow()
    const overLimit = Buffer.alloc(4)
    overLimit.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => createFrameDecoder().push(overLimit)).toThrow('frame_too_large')
  })
})
