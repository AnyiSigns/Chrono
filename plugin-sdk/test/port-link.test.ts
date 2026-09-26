// 反向调用通道：port.call 出帧、按 id 结算、失败作数据、断连结算全部在途。

import { describe, expect, it } from 'vitest'

import { PortLink, settlePortLinks } from '../port-link.ts'
import type { Json, Rec } from '../json.ts'

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

  it('call 回带 call_id（有则带、无则省略）', async () => {
    const sent: Rec[] = []
    const link = new PortLink({ write: (message) => sent.push(message as Rec) })
    void link.call('model', 'complete', {}, { callId: 'call-7' })
    void link.call('model', 'complete', {})
    expect(sent[0]['call_id']).toBe('call-7')
    expect(sent[1]['call_id']).toBeUndefined()
  })

  it('单次 timeoutMs 覆盖通道缺省', async () => {
    const link = new PortLink({ write: () => {}, timeoutMs: 10_000 })
    const started = Date.now()
    const pending = link.call('input', 'clear', {}, { timeoutMs: 5 })
    expect(await pending).toEqual({
      ok: false,
      code: 'transport_failed',
      message: 'input.clear timeout',
    })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('多条链共存：各链只结算自己的 id，未命中不消费', () => {
    const first = new PortLink({ write: () => {}, idPrefix: 'a' })
    const second = new PortLink({ write: () => {}, idPrefix: 'b' })
    void first.call('input', 'clear', {})
    void second.call('input', 'clear', {})
    // b 链的应答不被 a 链吞并：a.settle 返回 false，b.settle 命中。
    expect(first.settle({ kind: 'port.result', id: 'b-1', value: 1 })).toBe(false)
    expect(second.settle({ kind: 'port.result', id: 'b-1', value: 1 })).toBe(true)
  })

  it('settlePortLinks 依次尝试多条链', () => {
    const first = new PortLink({ write: () => {}, idPrefix: 'a' })
    const second = new PortLink({ write: () => {}, idPrefix: 'b' })
    void second.call('input', 'clear', {})
    expect(settlePortLinks([first, second], { kind: 'port.result', id: 'b-1', value: 1 })).toBe(true)
    expect(settlePortLinks([first, second], { kind: 'result', id: 'x' })).toBe(false)
  })
})
