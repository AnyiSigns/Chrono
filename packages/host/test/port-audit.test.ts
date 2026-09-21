// 端口审计原语：args 顶层 env 值脱敏（键名排序、确定性）+ 有界环形缓冲。

import { describe, expect, it } from 'vitest'
import { PORT_AUDIT_CAPACITY, PortAuditRing, redactPortArgs } from '../port-audit.ts'
import type { Json } from '../../kernel/index.ts'

describe('端口审计原语', () => {
  it('redactPortArgs：env 值替换为 {redacted, keys}，键名排序，其余 args 原样', () => {
    const args = { env: { secret: 's', apiKey: 'k' }, n: 7, nested: { keep: true } }
    const redacted = redactPortArgs(args) as { env: Json; n: number; nested: Json }
    expect(redacted.env).toEqual({ redacted: true, keys: ['apiKey', 'secret'] })
    expect(redacted.n).toBe(7)
    expect(redacted.nested).toEqual({ keep: true })
    // 原 args 不被改动（脱敏只作用于审计副本）
    expect(args.env).toEqual({ secret: 's', apiKey: 'k' })
  })

  it('redactPortArgs：无 env / 非对象 args 原样；非对象 env 整体替换', () => {
    expect(redactPortArgs({ n: 1 })).toEqual({ n: 1 })
    expect(redactPortArgs(null)).toBeNull()
    expect(redactPortArgs('plain')).toBe('plain')
    expect(redactPortArgs({ env: 'plain' })).toEqual({ env: { redacted: true, keys: [] } })
  })

  it('PortAuditRing：容量有界，满即覆盖最旧', () => {
    const ring = new PortAuditRing(2)
    const record = (at: number) => ({
      at,
      from: 'a',
      target: 'b',
      port: 'p',
      method: 'm',
      args: null,
      run: null,
      thread: null,
    })
    ring.record(record(1))
    ring.record(record(2))
    ring.record(record(3))
    expect(ring.records().map((item) => item.at)).toEqual([2, 3])
    expect(PORT_AUDIT_CAPACITY).toBe(256)
  })
})
