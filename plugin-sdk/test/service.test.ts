// 服务派发器：manifest 派生、能力 / 方法 / args 门禁、错误映射、事件、env 解析与拦截。

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createService } from '../service.ts'
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
      const { instance, sent } = build(root, { onDrain: () => (drained += 1) })
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
})
