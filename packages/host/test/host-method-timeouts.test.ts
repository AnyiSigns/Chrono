// 方法级调用超时：目标身份 schema 顶层 `method_timeouts` 覆盖进程级等待上限——
// 正向效果调用与反向 `port.call` 转发同规；声明非法只记运维日志、按无覆盖处理。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { REVERSE_SERVICE_MAIN, waitForLifecycle, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

const ECHO_TERM: Json = ['eff', 'toy.slow', 'echo', ['c', { n: 1 }]]
const ORIGIN_TERM: Json = ['eff', 'toy.origin', 'echo', ['c', { n: 1 }]]

describe('H17 方法级调用超时', () => {
  let root: string
  const handles: HostHandle[] = []

  beforeEach(() => {
    root = createTempRoot()
    handles.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 兜底停机
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  /** 静默服务（永不回 call）+ 调用方命令；schema 用于挂 `method_timeouts` 声明。 */
  function seedCaller(schema: Record<string, unknown>): void {
    const slow = writeTempPackage(root, {
      identity: 'toy-slow',
      implements: ['toy.slow'],
      methods: { 'toy.slow': ['echo'] },
      start: 'node execute/main.js',
      serviceConfig: { callMode: 'silent' },
      schema,
    })
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.slow': 'toy-slow' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'run.json': JSON.stringify(ECHO_TERM) },
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'toy-slow', path: slow },
        { name: 'toy-caller', path: caller },
      ]).ok,
    ).toBe(true)
  }

  /** 起宿主跑一次命令，返回状态与耗时（毫秒）。 */
  async function runTimed(callTimeoutMs: number): Promise<{ status: string; elapsed: number }> {
    const handle = await startHost({ root, callTimeoutMs })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const begin = Date.now()
      const result = await client.command('toy-caller.run')
      return { status: result.status, elapsed: Date.now() - begin }
    } finally {
      client.close()
    }
  }

  it('方法级覆盖生效：进程级 5000ms，方法级 200ms 先到', async () => {
    seedCaller({ type: 'object', method_timeouts: { 'toy.slow.echo': 200 } })
    const { status, elapsed } = await runTimed(5000)
    expect(status).toBe('refused')
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(3000)
  }, 20000)

  it('进程级仍是缺省：方法级只声明其它方法时，echo 走进程级 300ms', async () => {
    seedCaller({ type: 'object', method_timeouts: { 'toy.slow.other': 5000 } })
    const { status, elapsed } = await runTimed(300)
    expect(status).toBe('refused')
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(elapsed).toBeLessThan(3000)
  }, 20000)

  it('非法声明只记 dep.method_timeout_invalid，按无覆盖处理', async () => {
    seedCaller({ type: 'object', method_timeouts: { 'toy.slow.echo': 'nope' } })
    const handle = await startHost({ root, callTimeoutMs: 300 })
    handles.push(handle)
    const logFile = join(root, 'state', 'lifecycle.log')
    const records = await waitForLifecycle(
      logFile,
      (entry) => entry.kind === 'dep' && entry.event === 'method_timeout_invalid',
      'method_timeout_invalid log',
    )
    expect(
      records.some((entry) => entry.impl === 'toy-slow' && entry.reason === 'bad_timeout_ms'),
    ).toBe(true)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const begin = Date.now()
      const result = await client.command('toy-caller.run')
      expect(result.status).toBe('refused')
      expect(Date.now() - begin).toBeGreaterThanOrEqual(200)
    } finally {
      client.close()
    }
  }, 20000)

  it('方法级值超计时器上限（1e300）按非法处理：回落进程级而非溢出成 1ms', async () => {
    seedCaller({ type: 'object', method_timeouts: { 'toy.slow.echo': 1e300 } })
    const handle = await startHost({ root, callTimeoutMs: 300 })
    handles.push(handle)
    const logFile = join(root, 'state', 'lifecycle.log')
    const records = await waitForLifecycle(
      logFile,
      (entry) => entry.kind === 'dep' && entry.event === 'method_timeout_invalid',
      'method_timeout_invalid log',
    )
    expect(
      records.some((entry) => entry.impl === 'toy-slow' && entry.reason === 'bad_timeout_ms'),
    ).toBe(true)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const begin = Date.now()
      const result = await client.command('toy-caller.run')
      expect(result.status).toBe('refused')
      // 溢出会立即超时（< 100ms）；回落进程级 300ms 才是正确行为
      expect(Date.now() - begin).toBeGreaterThanOrEqual(200)
    } finally {
      client.close()
    }
  }, 20000)

  it('反向 port.call 也按目标方法级声明覆盖', async () => {
    const target = writeTempPackage(root, {
      identity: 'toy-target',
      implements: ['toy.target'],
      methods: { 'toy.target': ['echo'] },
      start: 'node execute/main.js',
      serviceConfig: { callMode: 'silent' },
      schema: { type: 'object', method_timeouts: { 'toy.target.echo': 200 } },
    })
    const origin = writeTempPackage(root, {
      identity: 'toy-origin',
      implements: ['toy.origin'],
      methods: { 'toy.origin': ['echo'] },
      pins: { 'toy.target': 'toy-target' },
      start: 'node execute/main.js',
      serviceConfig: { reversePort: 'toy.target', reverseMethod: 'echo', reverseArgs: { n: 1 } },
      files: { 'execute/main.js': REVERSE_SERVICE_MAIN },
    })
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.origin': 'toy-origin' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'run.json': JSON.stringify(ORIGIN_TERM) },
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'toy-target', path: target },
        { name: 'toy-origin', path: origin },
        { name: 'toy-caller', path: caller },
      ]).ok,
    ).toBe(true)
    const handle = await startHost({ root, callTimeoutMs: 5000 })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const begin = Date.now()
      const result = await client.command('toy-caller.run')
      const elapsed = Date.now() - begin
      expect(result.status).toBe('done')
      const value = (result.observations[0] as { value: Json }).value as {
        forwarded: { error?: string }
      }
      // 目标静默 → 反向调用按方法级 200ms 超时（远早于进程级 5000ms）
      expect(value.forwarded.error).toBe('transport_failed')
      expect(elapsed).toBeLessThan(3000)
    } finally {
      client.close()
    }
  }, 20000)
})
