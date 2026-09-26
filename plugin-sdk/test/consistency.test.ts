// 服务协议帧一致性：SDK 编码器与宿主 `packages/host/wire.ts` 对同一帧产出逐字节相同，
// 且 SDK 声明的出站 kind 集合与宿主服务协议处理面一致。两处编码器是刻意双实现，
// 用一致性测试钉死「同帧字节相同、出站 kind 集合不漂移」。

import { describe, expect, it } from 'vitest'

import { createFrameDecoder as sdkDecoder, encodeFrame as sdkEncode } from '../wire.ts'
import { SERVICE_OUTBOUND_KINDS } from '../wire.ts'
import {
  createFrameDecoder as hostDecoder,
  encodeFrame as hostEncode,
} from '../../packages/host/wire.ts'
import type { Json } from '../json.ts'

/** 服务 → 宿主 / 调用方的出站帧（宿主服务协议侧逐种处理）。 */
const EXPECTED_OUTBOUND_KINDS = [
  'manifest',
  'pong',
  'ack',
  'bye',
  'result',
  'error',
  'event',
  'port.call',
]

const MESSAGES: Json[] = [
  {
    id: 'h1',
    kind: 'manifest',
    v: '1',
    identity: 'toy',
    implements: ['toy'],
    methods: { toy: ['echo'] },
    protocol: '1',
    state: 'recomputable',
  },
  { v: '1', id: 'p1', kind: 'pong', ok: true },
  { v: '1', id: 'r1', kind: 'ack' },
  { v: '1', id: 'd1', kind: 'bye' },
  { v: '1', id: 'c1', kind: 'result', ok: true, value: { text: '中文', list: [1, null, false] } },
  { v: '1', id: 'c2', kind: 'error', ok: false, code: 'bad_args', message: 'x' },
  { v: '1', id: 'e1', kind: 'event', topic: 'ready', payload: { at: 1_700_000_000_000 } },
  {
    v: '1',
    id: 'pc1',
    kind: 'port.call',
    port: 'input',
    method: 'clear',
    args: { thread_id: 't' },
  },
]

describe('服务协议双实现一致性', () => {
  it('同一帧两端编码逐字节相同，且可互相解码', () => {
    for (const message of MESSAGES) {
      const sdk = Buffer.from(sdkEncode(message))
      const host = Buffer.from(hostEncode(message))
      expect(sdk.equals(host), JSON.stringify(message)).toBe(true)
      expect(sdkDecoder().push(Buffer.from(host))).toEqual([message])
      expect(hostDecoder().push(Buffer.from(sdk))).toEqual([message])
    }
  })

  it('出站 kind 集合与宿主服务协议面一致', () => {
    expect([...SERVICE_OUTBOUND_KINDS].sort()).toEqual([...EXPECTED_OUTBOUND_KINDS].sort())
  })
})
