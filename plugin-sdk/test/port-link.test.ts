// 反向调用通道：port.call 出帧、按 id 结算、失败作数据、断连结算全部在途。

import { describe, expect, it } from 'vitest'

import { PortLink } from '../port-link.ts'
import type { Json } from '../json.ts'

describe('PortLink', () => {
  it('call 发 port.call 并按 id 结算 port.result', async () => {
    const sent: Json[] = []
    const link = new PortLink({ write: (message) => sent.push(message), idPrefix: 'session' })
    const pending = link.call('input', 'clear', { thread_id: 't' })
    expect(sent).toEqual([
      {
        v: '1',
        id: 'session-1',
        kind: 'port.call',
        port: 'input',
        method: 'clear',
        args: { thread_id: 't' },
      },
    ])
    expect(link.settle({ kind: 'port.result', id: 'session-1', value: { ok: true } })).toBe(true)
    expect(await pending).toEqual({ ok: true, value: { ok: true } })
  })

  it('port.error 映射为失败数据（错误码字段为 error）', async () => {
    const link = new PortLink({ write: () => {}, idPrefix: 'session' })
    const pending = link.call('input', 'clear', {})
    link.settle({ kind: 'port.error', id: 'session-1', error: 'unresolved_cap', message: 'no pin' })
    expect(await pending).toEqual({ ok: false, code: 'unresolved_cap', message: 'no pin' })
  })

  it('非反向帧不被消费', () => {
    const link = new PortLink({ write: () => {} })
    expect(link.settle({ kind: 'result', id: 'x' })).toBe(false)
  })

  it('failAll 结算全部在途为失败数据', async () => {
    const link = new PortLink({ write: () => {} })
    const pending = link.call('input', 'clear', {})
    link.failAll()
    expect(await pending).toEqual({ ok: false, code: 'transport_failed', message: 'link closed' })
  })

  it('等待超时回落 transport_failed', async () => {
    const link = new PortLink({ write: () => {}, timeoutMs: 5 })
    const pending = link.call('input', 'clear', {})
    expect(await pending).toEqual({
      ok: false,
      code: 'transport_failed',
      message: 'input.clear timeout',
    })
  })
})
