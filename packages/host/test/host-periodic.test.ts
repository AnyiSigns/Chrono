// H6 定时触发：宿主按插件 schema 的 `periodic` 声明起周期 run——
// 命令条目按入口 term 起 run，方法条目直接调服务方法并落账其计划值。
// 单测覆盖声明解析；E2E 覆盖两条触发路径都广播宿主 run 生命周期事件。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { PeriodicScheduler, readPeriodicEntries } from '../periodic.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { waitFor, waitForLifecycle, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'
import type { Json, World } from '../../kernel/index.ts'

const TICK_TERM: Json = [
  'c',
  { $directives: [{ kind: 'write', request: { op: 'put', args: { body: { tick: true } } } }] },
]

function worldWithSchema(id: string, schema: Json): World {
  return {
    defs: { s1: { body: schema } as unknown as Json },
    ids: {
      [id]: {
        id,
        schema: 's1',
        gens: [{ seq: 0, payload: 's1' }],
        active: 's1',
        born: { at: 0, by: 'test' },
      },
    },
  } as unknown as World
}

describe('H6 定时触发', () => {
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

  it('readPeriodicEntries：解析 command / method / reads；非法声明只记 invalid', () => {
    const world = worldWithSchema('p', {
      periodic: [
        { command: 'p.tick', every_ms: 100, reads: { config: ['ids', 'config', 'body'] } },
        { method: 'sync', every_ms: 200 },
        { method: 'sync' },
        { command: 'p.tick', method: 'sync', every_ms: 1 },
        { command: 'p.tick', every_ms: 0 },
        { method: 'sync', every_ms: 1, reads: { ['__proto__']: ['ids', 'p'] } },
      ],
    })
    const { entries, invalid } = readPeriodicEntries(world)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ identity: 'p', command: 'p.tick', everyMs: 100 })
    expect(entries[0].reads).toEqual([{ key: 'config', path: ['ids', 'config', 'body'] }])
    expect(entries[1]).toMatchObject({ identity: 'p', method: 'sync', everyMs: 200 })
    expect(invalid.map((item) => item.reason)).toEqual([
      'bad_every_ms',
      'bad_target',
      'bad_every_ms',
      'bad_reads',
    ])
  })

  it('命令条目：按周期起 run（宿主 run 生命周期事件，thread=null）', async () => {
    const pkg = writeTempPackage(root, {
      identity: 'toy-periodic-cmd',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'tick.json': JSON.stringify(TICK_TERM) },
      commands: [{ name: 'toy-periodic-cmd.tick', entry: 'terms/tick.json' }],
      schema: {
        type: 'object',
        periodic: [{ command: 'toy-periodic-cmd.tick', every_ms: 60 }],
      },
    })
    expect(runSeed(root, [{ name: 'toy-periodic-cmd', path: pkg }]).ok).toBe(true)
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.impl === 'host' &&
              event.topic === 'run.finished' &&
              (event.payload as { thread?: string | null }).thread === null &&
              (event.payload as { status?: string }).status === 'done',
          ),
        'periodic command run.finished(done)',
      )
      const started = events.find(
        (event) =>
          event.impl === 'host' &&
          event.topic === 'run.started' &&
          (event.payload as { thread?: string | null }).thread === null,
      )
      expect(started).toBeDefined()
    } finally {
      client.close()
    }
  })

  it('方法条目：直接调服务方法并落账其计划值（宿主 run 生命周期事件）', async () => {
    const cmd = writeTempPackage(root, {
      identity: 'toy-periodic-cmd',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'tick.json': JSON.stringify(TICK_TERM) },
      commands: [{ name: 'toy-periodic-cmd.tick', entry: 'terms/tick.json' }],
      schema: { type: 'object' },
    })
    const svc = writeTempPackage(root, {
      identity: 'toy-periodic-method',
      implements: ['toy.periodic'],
      methods: { 'toy.periodic': ['tick'] },
      start: 'node execute/main.js',
      serviceConfig: {
        callValue: {
          $directives: [{ kind: 'write', request: { op: 'put', args: { body: { tick: true } } } }],
        },
      },
      schema: {
        type: 'object',
        periodic: [
          { method: 'tick', every_ms: 60, reads: { config: ['ids', 'toy-periodic-cmd', 'body'] } },
        ],
      },
    })
    expect(
      runSeed(root, [
        { name: 'toy-periodic-cmd', path: cmd },
        { name: 'toy-periodic-method', path: svc },
      ]).ok,
    ).toBe(true)
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.impl === 'host' &&
              event.topic === 'run.finished' &&
              (event.payload as { thread?: string | null }).thread === null &&
              (event.payload as { status?: string }).status === 'done',
          ),
        'periodic method run.finished(done)',
      )
    } finally {
      client.close()
    }
  })

  it('非法周期声明：只记运维日志 dep.periodic_invalid，不阻断宿主启动', async () => {
    const pkg = writeTempPackage(root, {
      identity: 'toy-periodic-bad',
      start: '',
      schema: { type: 'object', periodic: [{ method: 'tick' }] },
    })
    expect(runSeed(root, [{ name: 'toy-periodic-bad', path: pkg }]).ok).toBe(true)
    const handle = await startHost({ root })
    handles.push(handle)
    const logFile = join(root, 'state', 'lifecycle.log')
    const records = await waitForLifecycle(
      logFile,
      (entry) => entry.kind === 'dep' && entry.event === 'periodic_invalid',
      'periodic_invalid log',
    )
    expect(records.some((entry) => entry.impl === 'toy-periodic-bad')).toBe(true)
  })

  it('方法返回非法计划值：fail-closed 拒（run.finished status=refused）', async () => {
    const svc = writeTempPackage(root, {
      identity: 'toy-periodic-badplan',
      implements: ['toy.periodic'],
      methods: { 'toy.periodic': ['tick'] },
      start: 'node execute/main.js',
      serviceConfig: { callValue: { $directives: [{ kind: 'bogus' }] } },
      schema: { type: 'object', periodic: [{ method: 'tick', every_ms: 60 }] },
    })
    expect(runSeed(root, [{ name: 'toy-periodic-badplan', path: svc }]).ok).toBe(true)
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.impl === 'host' &&
              event.topic === 'run.finished' &&
              (event.payload as { thread?: string | null }).thread === null &&
              (event.payload as { status?: string }).status === 'refused',
          ),
        'periodic bad plan refused',
      )
    } finally {
      client.close()
    }
  })

  it('PeriodicScheduler.stop：停机后 sync 不复活计时器', async () => {
    const world = worldWithSchema('p', { periodic: [{ method: 'tick', every_ms: 20 }] })
    let fired = 0
    const scheduler = new PeriodicScheduler({ onFire: () => void (fired += 1) })
    scheduler.sync(world)
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(fired).toBeGreaterThan(0)
    scheduler.stop()
    const afterStop = fired
    // 停机后再次 sync（模拟在途 run 收尾触发的 applyWorld）不得复活
    scheduler.sync(world)
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(fired).toBe(afterStop)
  })
})
