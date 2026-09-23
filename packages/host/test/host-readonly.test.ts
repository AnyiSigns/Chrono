// 只读命令：执行不广播 run 生命周期事件（读不得成为回合信号），不写审计 / 不推进 head；
// 产出 write（直接或经 plan）即 refused readonly_violation，不落账。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal } from '../ledger/index.ts'
import { refusedReasons } from '../effect/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

/** 挂起 eff 到不存在的端口：非只读会落一条审计，只读则连审计也不写。 */
const EFF_TERM: Json = ['eff', 'toy.missing', 'echo', ['c', 1]]
/** 纯值 term：产出 write 计划。 */
const PLAN_WRITE_TERM: Json = [
  'c',
  { $directives: [{ kind: 'write', request: { op: 'put', args: { body: { planned: true } } } }] },
]

function isRunEvent(event: EventMessage): boolean {
  return event.impl === 'host' && (event.topic === 'run.started' || event.topic === 'run.finished')
}

describe('只读命令', () => {
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

  function journalFile(): string {
    return join(root, 'state', 'world', 'journal.jsonl')
  }

  function seed(): void {
    const pkg = writeTempPackage(root, {
      identity: 'toy-ro',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: {
        'read.json': JSON.stringify(EFF_TERM),
        'write.json': JSON.stringify(EFF_TERM),
        'plan.json': JSON.stringify(PLAN_WRITE_TERM),
      },
      commands: [
        { name: 'toy-ro.read', entry: 'terms/read.json', readonly: true },
        { name: 'toy-ro.write', entry: 'terms/write.json' },
        { name: 'toy-ro.plan', entry: 'terms/plan.json', readonly: true },
      ],
    })
    expect(runSeed(root, [{ name: 'toy-ro', path: pkg }]).ok).toBe(true)
  }

  it('只读命令：不广播 run 事件、不写审计 / 不推进 head，结果帧照常回', async () => {
    seed()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const before = (await client.status()).world_head
      const journalBefore = readJournal(journalFile()).length
      const result = await client.command('toy-ro.read')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(result.status).toBe('refused')
      expect(events.filter(isRunEvent)).toEqual([])
      expect(readJournal(journalFile()).length).toBe(journalBefore)
      expect((await client.status()).world_head).toEqual(before)
    } finally {
      client.close()
    }
  })

  it('非只读命令：照常广播 run 事件（origin=command）并落审计推进 head', async () => {
    seed()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const before = (await client.status()).world_head
      const result = await client.command('toy-ro.write')
      await waitFor(
        () => events.some((event) => isRunEvent(event) && event.topic === 'run.finished'),
        'command run.finished',
      )
      expect(result.status).toBe('refused')
      const started = events.find((event) => event.topic === 'run.started')
      const finished = events.find((event) => event.topic === 'run.finished')
      expect((started?.payload as { origin?: string }).origin).toBe('command')
      expect((finished?.payload as { origin?: string }).origin).toBe('command')
      expect((await client.status()).world_head).not.toEqual(before)
    } finally {
      client.close()
    }
  })

  it('只读命令产出 write 计划：refused readonly_violation，不落账、不推进 head', async () => {
    seed()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const before = (await client.status()).world_head
      const journalBefore = readJournal(journalFile()).length
      const result = await client.command('toy-ro.plan')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(result.status).toBe('refused')
      expect(refusedReasons(result.observations)).toContain('readonly_violation')
      expect(readJournal(journalFile()).length).toBe(journalBefore)
      expect((await client.status()).world_head).toEqual(before)
      expect(events.filter(isRunEvent)).toEqual([])
    } finally {
      client.close()
    }
  })
})
