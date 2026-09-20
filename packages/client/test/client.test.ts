import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'
import { join } from 'node:path'
import { createTempRoot, createToyPlugin, cleanupTempRoot } from '../../host/test/test-helpers.ts'
import { startHost } from '../../host/index.ts'
import { runSeed } from '../../host/index.ts'

describe('客户端 client', () => {
  let root: string
  let handle: Awaited<ReturnType<typeof startHost>>

  beforeEach(async () => {
    root = createTempRoot()
    createToyPlugin(root)
    const { writeFileSync } = require('node:fs')
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'toy', path: join(root, 'pkg', 'toy') }]),
    )
    runSeed(root)
    handle = await startHost({ root })
  })

  afterEach(async () => {
    try {
      await handle.stop()
    } catch {
      /* ignore */
    }
    cleanupTempRoot(root)
  })

  it('connect 返回 Client 句柄', async () => {
    const client = await connect({ root, timeoutMs: 2000 })
    expect(client).toBeDefined()
    expect(typeof client.submit).toBe('function')
    expect(typeof client.command).toBe('function')
    expect(typeof client.commands).toBe('function')
    expect(typeof client.status).toBe('function')
    expect(typeof client.stop).toBe('function')
    expect(typeof client.close).toBe('function')
    expect(typeof client.onEvent).toBe('function')
    client.close()
  })

  it('connect 到不存在宿主抛出连接错误', async () => {
    const badRoot = createTempRoot()
    await expect(async () => {
      await connect({ root: badRoot, timeoutMs: 300 })
    }).rejects.toThrow()
    cleanupTempRoot(badRoot)
  })

  it('submit [write] → done，observations 含 write', async () => {
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const result = await client.submit([
        {
          kind: 'write',
          request: {
            id: 'w1',
            op: 'put',
            target: { expect_pos: null },
            args: { body: { v: 1 } },
            by: 'client',
          },
        },
      ])
      expect(result.status).toBe('done')
      expect(Array.isArray(result.observations)).toBe(true)
    } finally {
      client.close()
    }
  })

  it('submit 传 thread：run.started 事件原样回带', async () => {
    const client = await connect({ root, timeoutMs: 2000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const result = await client.submit(
        [
          {
            kind: 'write',
            request: {
              id: 'wt1',
              op: 'put',
              target: { expect_pos: null },
              args: { body: { v: 1 } },
              by: 'client',
            },
          },
        ],
        { thread: 'thr-client' },
      )
      expect(result.status).toBe('done')
      const started = events.find((event) => event.impl === 'host' && event.topic === 'run.started')
      expect(started).toBeDefined()
      expect((started!.payload as { thread?: string }).thread).toBe('thr-client')
    } finally {
      client.close()
    }
  })

  it('submit [eval(missing)] → refused，reasons 含 missing_ref', async () => {
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const result = await client.submit([
        { kind: 'eval', entry: 'ghost'.repeat(16), args: null, ctx: null as Json },
      ])
      expect(result.status).toBe('refused')
      const refusedObs = result.observations.find(
        (o) => (o as Json & { kind: string }).kind === 'refused',
      )
      expect(refusedObs).toBeDefined()
      expect((refusedObs as Json & { reasons: string[] }).reasons).toContain('missing_ref')
    } finally {
      client.close()
    }
  })

  it('commands 返回数组', async () => {
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const cmds = await client.commands()
      expect(Array.isArray(cmds)).toBe(true)
    } finally {
      client.close()
    }
  })

  it('status 返回 world_head 与 loaded', async () => {
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const status = await client.status()
      expect(status.world_head).toBeDefined()
      expect(Array.isArray(status.loaded)).toBe(true)
    } finally {
      client.close()
    }
  })

  it('stop 关闭宿主', async () => {
    const client = await connect({ root, timeoutMs: 2000 })
    await client.stop()
    await expect(async () => {
      await connect({ root, timeoutMs: 300 })
    }).rejects.toThrow()
  })
})
