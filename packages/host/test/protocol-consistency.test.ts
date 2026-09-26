// 协议一致性：入站面两端（宿主 `wire.ts` 与客户端 `frame.ts` / `protocol.ts`）是刻意双实现，
// 用一致性测试钉死「同帧字节相同、出站 kind 白名单与联合一致、错误码字段一律 `code`」。
// 反向 PortLink 的 `port.error` 字段仍叫 `error`（服务协议族按 `ok` 判别），其切换另立。

import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION as HOST_VERSION,
  createFrameDecoder as hostDecoder,
  encodeFrame as hostEncode,
} from '../wire.ts'
import type { OutboundMessage as HostOutbound } from '../wire.ts'
import {
  createFrameDecoder as clientDecoder,
  encodeFrame as clientEncode,
} from '../../client/frame.ts'
import { PROTOCOL_VERSION as CLIENT_VERSION } from '../../client/protocol.ts'
import type { OutboundMessage as ClientOutbound } from '../../client/protocol.ts'
import { KNOWN_OUTBOUND_KINDS } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

/** 联合若新增 kind 而列表未同步 → 编译失败；列表若多出联合没有的 kind → 编译失败。 */
type Exhaustive<T extends never> = T
type OutboundKind = HostOutbound['kind']
const UNION_KINDS: OutboundKind[] = [
  'accepted',
  'result',
  'list',
  'audits',
  'asset.ref',
  'asset.bytes',
  'secrets.ok',
  'state',
  'error',
  'event',
]
export type MissingFromList = Exhaustive<Exclude<OutboundKind, (typeof UNION_KINDS)[number]>>
export type ExtraInList = Exhaustive<Exclude<(typeof UNION_KINDS)[number], OutboundKind>>
/** 两端 OutboundMessage 联合必须逐 kind 相同（同一份协议的双实现）。 */
export type UnionDrift = Exhaustive<
  Exclude<OutboundKind, ClientOutbound['kind']> | Exclude<ClientOutbound['kind'], OutboundKind>
>

const MESSAGES: Json[] = [
  { v: '1', id: 'a', kind: 'accepted', run: 'r1' },
  {
    v: '1',
    kind: 'result',
    run: 'r1',
    status: 'ok',
    observations: [{ a: 1, b: [true, null, '中文'] }],
  },
  { v: '1', id: 'b', kind: 'error', code: 'bad_args', message: 'x' },
  { v: '1', id: 'c', kind: 'state', world_head: null, world_rev: 'h', loaded: [] },
  { v: '1', id: 'd', kind: 'asset.bytes', sha256: 'a'.repeat(64), size: 3, bytes: 'AAAA' },
  { v: '1', impl: 'ns', kind: 'event', topic: 't', payload: { n: 1 } },
]

describe('协议双实现一致性', () => {
  it('同一帧两端编码逐字节相同，且可互相解码', () => {
    for (const message of MESSAGES) {
      const host = Buffer.from(hostEncode(message))
      const client = Buffer.from(clientEncode(message))
      expect(host.equals(client)).toBe(true)
      expect(hostDecoder().push(Buffer.from(client))).toEqual([message])
      expect(clientDecoder().push(Buffer.from(host))).toEqual([message])
    }
  })

  it('协议版本一致', () => {
    expect(CLIENT_VERSION).toBe(HOST_VERSION)
  })

  it('出站 kind 白名单与联合逐项对齐', () => {
    expect([...KNOWN_OUTBOUND_KINDS].sort()).toEqual([...UNION_KINDS].sort())
  })

  it('错误帧错误码字段是 `code`（非 `error`）', () => {
    const decoded = clientDecoder().push(
      Buffer.from(hostEncode({ v: '1', id: 'e', kind: 'error', code: 'bad_args', message: 'm' })),
    )[0] as { [k: string]: Json }
    expect(decoded['code']).toBe('bad_args')
    expect('error' in decoded).toBe(false)
  })
})
