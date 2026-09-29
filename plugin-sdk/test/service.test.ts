// 服务派发器：manifest 派生、能力 / 方法 / args 门禁、错误映射、事件、env 解析与拦截。

import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createService, pinsFromProcess } from '../service.ts'
import { PortLink } from '../port-link.ts'
import { BadArgsError, ServiceError } from '../types.ts'
import type { Json, Rec } from '../json.ts'
import type { Handler } from '../types.ts'

class ToyError extends ServiceError {
  constructor() {
    super('toy_failed', 'toy failed')
  }
}

function pluginRoot(extra: Rec = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-sdk-svc-'))
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      identity: 'toy',
      implements: ['toy'],
      methods: { toy: ['echo', 'boom', 'domain', 'blow'] },
      protocol: '1',
      state: 'recomputable',
      ...extra,
    }),
  )
  return dir
}

function build(root: string, overrides: Partial<Parameters<typeof createService>[0]> = {}) {
  const sent: Rec[] = []
  const handlers: Record<string, Handler> = {
    echo: (args) => ({ value: args, events: [] }),
    boom: () => {
      throw new BadArgsError('bad echo args')
    },
    domain: () => {
      throw new ToyError()
    },
    blow: () => {
      throw new Error('unexpected')
    },
  }
  const instance = createService({
    pluginRoot: root,
    capability: 'toy',
    handlers,
    emit: (message) => sent.push(message as Rec),
    ...overrides,
  })
  return { instance, sent }
}

function last(sent: Rec[]): Rec {
  return sent[sent.length - 1]
}

describe('服务派发器', () => {
  it('hello 回 manifest，派生自 plugin.json', async () => {
    const root = pluginRoot()
    try {
      const { instance, sent } = build(root)
      instance.receive({ id: 'h', kind: 'hello', impl: 'toy', gen: 'g' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(last(sent)).toEqual({
        id: 'h',
        kind: 'manifest',
        v: '1',
        identity: 'toy',
        implements: ['toy'],
        methods: { toy: ['echo', 'boom', 'domain', 'blow'] },
        protocol: '1',
        state: 'recomputable',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('probe → pong / reload → ack / drain → bye 并触发 onDrain', async () => {
    const root = pluginRoot()
    try {
      let drained = 0
      const { instance, sent } = build(root, {
        onDrain: () => {
          drained += 1
        },
      })
      instance.receive({ id: 'p', kind: 'probe' })
      instance.receive({ id: 'r', kind: 'reload', gen: 'g2' })
      instance.receive({ id: 'd', kind: 'drain', deadline_ms: 100 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(sent.map((message) => message['kind'])).toEqual(['pong', 'ack', 'bye'])
      expect(drained).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('能力 / 方法 / args 门禁与错误映射', async () => {
    const root = pluginRoot()
    try {
      const { instance, sent } = build(root)
      instance.receive({ v: '1', id: 'c1', kind: 'call', port: 'nope', method: 'echo', args: {} })
      instance.receive({ v: '1', id: 'c2', kind: 'call', port: 'toy', method: 'nope', args: {} })
      instance.receive({ v: '1', id: 'c3', kind: 'call', port: 'toy', method: 'echo', args: 'x' })
      instance.receive({ v: '1', id: 'c4', kind: 'call', port: 'toy', method: 'boom', args: {} })
      instance.receive({ v: '1', id: 'c5', kind: 'call', port: 'toy', method: 'domain', args: {} })
      instance.receive({ v: '1', id: 'c6', kind: 'call', port: 'toy', method: 'blow', args: {} })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(sent.map((message) => [message['kind'], message['code']])).toEqual([
        ['error', 'unresolved_cap'],
        ['error', 'unknown_method'],
        ['error', 'bad_args'],
        ['error', 'bad_args'],
        ['error', 'toy_failed'],
        ['error', 'internal'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('call 命中处理器：args 与 env 传入，events 先于 result 且带前缀', async () => {
    const root = pluginRoot()
    try {
      let seenArgs: Json = null
      let seenEnv: Rec | null = null
      const { instance, sent } = build(root, {
        eventIdPrefix: 'toy-evt',
        handlers: {
          echo: (args, env) => {
            seenArgs = args
            seenEnv = env as unknown as Rec
            return { value: { ok: true }, events: [{ topic: 't', payload: { n: 1 } }] }
          },
        },
      })
      instance.receive({
        v: '1',
        id: 'c',
        kind: 'call',
        port: 'toy',
        method: 'echo',
        args: { a: 1 },
        env: { run: 'run-1', thread: 'th', now: 1_700_000_000_000, emitter: 'caller' },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(seenArgs).toEqual({ a: 1 })
      expect(seenEnv).toEqual({
        run: 'run-1',
        thread: 'th',
        now: 1_700_000_000_000,
        emitter: 'caller',
      })
      expect(sent.map((message) => message['kind'])).toEqual(['event', 'result'])
      expect(sent[0]['id']).toBe('toy-evt-1')
      expect(sent[1]['value']).toEqual({ ok: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('env.now 非有限回落 0，绝不自取时钟', async () => {
    const root = pluginRoot()
    try {
      let seen: Rec | null = null
      const { instance } = build(root, {
        handlers: {
          echo: (_args, env) => {
            seen = env as unknown as Rec
            return { value: null, events: [] }
          },
        },
      })
      instance.receive({
        v: '1',
        id: 'c',
        kind: 'call',
        port: 'toy',
        method: 'echo',
        args: {},
        env: { now: Number.NaN },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(seen).not.toBeNull()
      expect((seen as unknown as Rec)['now']).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('intercept 消费的帧不进入派发（反向应答结算）', async () => {
    const root = pluginRoot()
    try {
      const consumed: Rec[] = []
      const { instance, sent } = build(root, {
        intercept: (message) => {
          if (message['kind'] === 'port.result') {
            consumed.push(message)
            return true
          }
          return false
        },
      })
      instance.receive({ v: '1', id: 'pr', kind: 'port.result', ok: true, value: 1 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(consumed).toHaveLength(1)
      expect(sent).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('call 身份上下文：callId / port / method / env 传入处理器', async () => {
    const root = pluginRoot()
    try {
      let seen: Rec | null = null
      const { instance } = build(root, {
        handlers: {
          echo: (args, env, call) => {
            seen = { args, env, call } as unknown as Rec
            return { value: null, events: [] }
          },
        },
      })
      instance.receive({
        v: '1',
        id: 'call-9',
        kind: 'call',
        port: 'toy',
        method: 'echo',
        args: { a: 1 },
        env: { run: 'r', thread: null, now: 5, emitter: 'caller' },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(seen).not.toBeNull()
      const call = (seen as unknown as Rec)['call'] as Rec
      expect(call['callId']).toBe('call-9')
      expect(call['port']).toBe('toy')
      expect(call['method']).toBe('echo')
      expect((call['env'] as Rec)['run']).toBe('r')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('多能力类门禁：按帧内 port 取各自声明的方法集', async () => {
    const root = pluginRoot({
      implements: ['alpha', 'beta'],
      methods: { alpha: ['a'], beta: ['b'] },
    })
    try {
      const sent: Rec[] = []
      const instance = createService({
        pluginRoot: root,
        capability: 'alpha',
        emit: (message) => sent.push(message as Rec),
        handlers: {
          a: () => ({ value: 'a', events: [] }),
          b: () => ({ value: 'b', events: [] }),
        },
      })
      instance.receive({ v: '1', id: 'c1', kind: 'call', port: 'beta', method: 'b', args: {} })
      instance.receive({ v: '1', id: 'c2', kind: 'call', port: 'alpha', method: 'b', args: {} })
      instance.receive({ v: '1', id: 'c3', kind: 'call', port: 'beta', method: 'a', args: {} })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(sent.map((message) => [message['kind'], message['value'] ?? message['code']])).toEqual(
        [
          ['result', 'b'],
          ['error', 'unknown_method'],
          ['error', 'unknown_method'],
        ],
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('concurrent_methods 脱链派发：长调用挂起时并发方法仍可完成', async () => {
    const root = pluginRoot({ methods: { toy: ['echo', 'slow'] } })
    try {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const sent: Rec[] = []
      const instance = createService({
        pluginRoot: root,
        capability: 'toy',
        concurrentMethods: ['echo'],
        emit: (message) => sent.push(message as Rec),
        handlers: {
          slow: async () => {
            await gate
            return { value: 'slow', events: [] }
          },
          echo: () => ({ value: 'echo', events: [] }),
        },
      })
      // slow 排串行链并挂起；echo 声明并发，应立即完成而不等 slow。
      instance.receive({ v: '1', id: 's', kind: 'call', port: 'toy', method: 'slow', args: {} })
      instance.receive({ v: '1', id: 'e', kind: 'call', port: 'toy', method: 'echo', args: {} })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(sent.map((message) => message['id'])).toEqual(['e'])
      release()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(sent.map((message) => message['id']).sort()).toEqual(['e', 's'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('portLinks 自动结算反向应答，并在 drain / close 时 failAll', async () => {
    const root = pluginRoot()
    try {
      const frames: Rec[] = []
      const link = new PortLink({
        write: (message) => frames.push(message as Rec),
        idPrefix: 'toy',
      })
      const { instance } = build(root, { portLinks: [link] })
      const pending = link.call('dep', 'ping', {})
      const frameId = frames[0]['id'] as string
      instance.receive({ v: '1', kind: 'port.result', id: frameId, ok: true, value: 1 })
      expect(await pending).toEqual({ ok: true, value: 1 })
      const held = link.call('dep', 'ping', {})
      instance.receive({ v: '1', id: 'd', kind: 'drain', deadline_ms: 100 })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(await held).toEqual({ ok: false, code: 'transport_failed', message: 'link closed' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('有效 pins：stdio spawn env 解析', () => {
  const KEY = 'CHRONO_PLUGIN_PINS'
  const saved = process.env[KEY]

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  })

  it('有效 JSON 映射 → 原样解析', () => {
    process.env[KEY] = JSON.stringify({ title: 'provider', host: 'host' })
    expect(pinsFromProcess()).toEqual({ title: 'provider', host: 'host' })
  })

  it('未注入 → undefined', () => {
    delete process.env[KEY]
    expect(pinsFromProcess()).toBeUndefined()
  })

  it('坏 JSON / 非字符串映射 → undefined，不抛', () => {
    process.env[KEY] = '{not json'
    expect(pinsFromProcess()).toBeUndefined()
    process.env[KEY] = JSON.stringify({ title: 1 })
    expect(pinsFromProcess()).toBeUndefined()
    process.env[KEY] = JSON.stringify('nope')
    expect(pinsFromProcess()).toBeUndefined()
  })
})
