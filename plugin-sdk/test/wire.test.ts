// 帧编解码：长度前缀、增量解码、单帧上限与坏 JSON 收口。

import { describe, expect, it } from 'vitest'

import {
  createFrameDecoder,
  encodeFrame,
  MAX_FRAME_BYTES,
  SERVICE_PROTOCOL_VERSION,
} from '../wire.ts'
import type { Json } from '../json.ts'

describe('服务协议帧', () => {
  it('编码 = 4 字节大端长度 + 规范 JSON 字节', () => {
    const frame = encodeFrame({ v: '1', id: 'a', kind: 'pong', ok: true })
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4)
    expect(frame.subarray(4).toString('utf8')).toBe('{"id":"a","kind":"pong","ok":true,"v":"1"}')
  })

  it('任意分片喂入可增量解出完整消息', () => {
    const messages: Json[] = [
      { v: '1', id: 'a', kind: 'ack' },
      { v: '1', id: 'b', kind: 'result', ok: true, value: [1, 2, 3] },
    ]
    const bytes = Buffer.concat(messages.map((message) => encodeFrame(message)))
    const decoder = createFrameDecoder()
    const out: Json[] = []
    for (let i = 0; i < bytes.length; i += 3) out.push(...decoder.push(bytes.subarray(i, i + 3)))
    expect(out).toEqual(messages)
  })

  it('长度前缀超单帧上限抛错', () => {
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => createFrameDecoder().push(head)).toThrow('frame_too_large')
  })

  it('坏 JSON 抛错（不静默吞掉）', () => {
    const body = Buffer.from('{not-json', 'utf8')
    const frame = Buffer.allocUnsafe(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)
    expect(() => createFrameDecoder().push(frame)).toThrow()
  })

  it('协议版本为 1', () => {
    expect(SERVICE_PROTOCOL_VERSION).toBe('1')
  })
})
