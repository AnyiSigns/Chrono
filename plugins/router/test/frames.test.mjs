// 帧编解码单元测试：增量分片、坏帧超限后解码器可恢复（不被残留前缀卡死）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from '../execute/frames.ts'

test('增量分片：半帧不产出，补齐后产出', () => {
  const decoder = createFrameDecoder()
  const frame = encodeFrame({ kind: 'hello', id: 'a' })
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), [])
  assert.deepEqual(decoder.push(frame.subarray(3)), [{ kind: 'hello', id: 'a' }])
})

test('超限帧抛 frame_too_large 并清空缓冲，后续合法帧仍可解', () => {
  const decoder = createFrameDecoder()
  const oversized = Buffer.alloc(4)
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
  assert.throws(() => decoder.push(oversized), /frame_too_large/)
  assert.deepEqual(decoder.push(encodeFrame({ kind: 'pong' })), [{ kind: 'pong' }])
})
