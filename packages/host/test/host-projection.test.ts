// S4.6 投影（A14）：eval 的 ctx 缺省 ⇒ base_only 投影、显式 ⇒ 原样透传（客户端 / 命令 / plan 三路同规）；
// 投影只读：不写链、不推进 head、不参与哈希（eval 轮无 entry）。
// 词表：命令读投影的固定路径（["g", path] 静态字面路径，缺失由内核抛 missing_path）。

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { loadAnchor, readJournal } from '../ledger/index.ts'
import { worldRev } from '../../kernel/index.ts'
import type { Directive, Json } from '../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { FIXTURE_ALPHA, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

const READ_HEAD: Json = ['g', ['head', 'seq']]
const READ_REV: Json = ['g', ['world_rev']]
const READ_ACTIVE: Json = ['g', ['ids', 'toy-caller', 'active']]
const READ_BODY: Json = ['g', ['ids', 'toy-alpha', 'body']]
const READ_GENS: Json = ['g', ['ids', 'toy-alpha', 'gens', 0, 'payload']]
const READ_MARKER: Json = ['g', ['marker']]
const READ_GHOST: Json = ['g', ['ids', 'ghost', 'body']]
const READ_ADOPTED: Json = ['g', ['ids', 'toy-alpha', 'gens', 0, 'adopted']]
const READ_PINS: Json = ['g', ['ids', 'toy-caller', 'pins']]

describe('S4.6 投影：term 经 ctx 读世界投影（只读）', () => {
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

  function seedDefault(): void {
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      start: '',
      pins: { 'toy.alpha': 'toy-alpha' },
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [
        { name: 'toy-caller.head', entry: 'terms/head.json' },
        { name: 'toy-caller.pins', entry: 'terms/pins.json' },
        { name: 'toy-caller.rev', entry: 'terms/rev.json' },
        { name: 'toy-caller.active', entry: 'terms/active.json' },
        { name: 'toy-caller.body', entry: 'terms/body.json' },
        { name: 'toy-caller.gens', entry: 'terms/gens.json' },
        { name: 'toy-caller.marker', entry: 'terms/marker.json' },
        { name: 'toy-caller.ghost', entry: 'terms/ghost.json' },
        { name: 'toy-caller.adopted', entry: 'terms/adopted.json' },
        { name: 'toy-caller.probe', entry: 'terms/probe.json' },
        { name: 'toy-caller.plan', entry: 'terms/plan.json' },
      ],
      terms: {
        'head.json': JSON.stringify(READ_HEAD),
        'rev.json': JSON.stringify(READ_REV),
        'active.json': JSON.stringify(READ_ACTIVE),
        'body.json': JSON.stringify(READ_BODY),
        'gens.json': JSON.stringify(READ_GENS),
        'marker.json': JSON.stringify(READ_MARKER),
        'ghost.json': JSON.stringify(READ_GHOST),
        'adopted.json': JSON.stringify(READ_ADOPTED),
        'pins.json': JSON.stringify(READ_PINS),
        'probe.json': JSON.stringify(READ_ACTIVE),
        'plan.json': JSON.stringify([
          'c',
          { $directives: [{ kind: 'eval', entry: { $ref: 'terms/probe.json' } }] },
        ]),
      },
    })
    const report = runSeed(root, [
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-caller', path: caller },
    ])
    expect(report.ok).toBe(true)
  }

  async function start(): Promise<HostHandle> {
    const handle = await startHost({ root })
    handles.push(handle)
    return handle
  }

  it('命令 eval 缺省 ctx 读到当前世界投影；投影只读：journal / head / worldRev 不变', async () => {
    seedDefault()
    const anchor = loadAnchor(journalFile())
    const before = readJournal(journalFile()).length
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const head = await client.command('toy-caller.head')
      expect(head.status).toBe('done')
      expect((head.observations[0] as { value: Json }).value).toBe(anchor.head.seq)

      const rev = await client.command('toy-caller.rev')
      expect(rev.status).toBe('done')
      expect((rev.observations[0] as { value: Json }).value).toBe(worldRev(anchor.world))

      const active = await client.command('toy-caller.active')
      expect(active.status).toBe('done')
      expect((active.observations[0] as { value: Json }).value).toBe(
        anchor.world.ids['toy-caller'].active,
      )

      const body = await client.command('toy-caller.body')
      expect(body.status).toBe('done')
      expect((body.observations[0] as { value: Json }).value).toEqual(
        anchor.world.defs[anchor.world.ids['toy-alpha'].active as string].body,
      )

      // gens 投影为 {seq,payload}：payload 可读，履历（adopted/born）不可达
      const gens = await client.command('toy-caller.gens')
      expect(gens.status).toBe('done')
      expect((gens.observations[0] as { value: Json }).value).toBe(
        anchor.world.ids['toy-alpha'].gens[0].payload,
      )
      // pins = 当前代码世代声明里的表（名 → 被依赖身份名）；toy-alpha 无 pins 声明 → {}
      const pins = await client.command('toy-caller.pins')
      expect(pins.status).toBe('done')
      expect((pins.observations[0] as { value: Json }).value).toEqual({ 'toy.alpha': 'toy-alpha' })

      const adopted = await client.command('toy-caller.adopted')
      expect(adopted.status).toBe('refused')
      expect(adopted.observations[adopted.observations.length - 1]).toMatchObject({
        kind: 'refused',
        reasons: ['missing_path'],
      })

      // 投影里不存在的身份 / 路径：内核 missing_path（fail-closed，不报宿主错）
      const ghost = await client.command('toy-caller.ghost')
      expect(ghost.status).toBe('refused')
      expect(ghost.observations[ghost.observations.length - 1]).toMatchObject({
        kind: 'refused',
        reasons: ['missing_path'],
      })

      // 只读：eval 轮无 entry、不推进 head、不参与哈希
      expect((await client.status()).world_head).toEqual(anchor.head)
    } finally {
      client.close()
    }
    expect(readJournal(journalFile())).toHaveLength(before)
    expect(worldRev(loadAnchor(journalFile()).world)).toBe(worldRev(anchor.world))
  })

  it('三路同规（submit）：缺省填投影、显式 null 透传、显式对象透传', async () => {
    seedDefault()
    const anchor = loadAnchor(journalFile())
    const before = readJournal(journalFile()).length
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const commands = await client.commands()
      const entryOf = (name: string): string => {
        const found = commands.find((cmd) => cmd.name === name)
        expect(found).toBeDefined()
        return (found as { entry: string }).entry
      }

      // 缺省 ⇒ 投影：与命令同规，读 world_rev 得摘要
      const filled = await client.submit([
        { kind: 'eval', entry: entryOf('toy-caller.rev') } as unknown as Directive,
      ])
      expect(filled.status).toBe('done')
      expect((filled.observations[0] as { value: Json }).value).toBe(worldRev(anchor.world))

      // 显式 null ⇒ 透传：term 读 world_rev 时 ctx=null → 内核 missing_path（若错填投影会 done）
      const nulled = await client.submit([
        { kind: 'eval', entry: entryOf('toy-caller.rev'), args: null, ctx: null },
      ])
      expect(nulled.status).toBe('refused')
      expect(nulled.observations[nulled.observations.length - 1]).toMatchObject({
        kind: 'refused',
        reasons: ['missing_path'],
      })

      // 缺省 ⇒ 投影：投影没有 marker 键 → missing_path（证明换过 ctx）
      const projected = await client.submit([
        { kind: 'eval', entry: entryOf('toy-caller.marker') } as unknown as Directive,
      ])
      expect(projected.status).toBe('refused')
      expect(projected.observations[projected.observations.length - 1]).toMatchObject({
        kind: 'refused',
        reasons: ['missing_path'],
      })

      // 显式对象 ⇒ 透传：term 读到客户端给的值
      const mine = await client.submit([
        { kind: 'eval', entry: entryOf('toy-caller.marker'), args: null, ctx: { marker: 'mine' } },
      ])
      expect(mine.status).toBe('done')
      expect((mine.observations[0] as { value: Json }).value).toBe('mine')

      expect((await client.status()).world_head).toEqual(anchor.head)
    } finally {
      client.close()
    }
    expect(readJournal(journalFile())).toHaveLength(before)
  })

  it('三路同规（plan）：plan 条目缺省 ctx ⇒ 宿主投影；probe 读到 active', async () => {
    seedDefault()
    const anchor = loadAnchor(journalFile())
    const before = readJournal(journalFile()).length
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const commands = await client.commands()
      const probeEntry = commands.find((cmd) => cmd.name === 'toy-caller.probe')
      expect(probeEntry).toBeDefined()

      const result = await client.command('toy-caller.plan')
      expect(result.status).toBe('done')
      const probe = result.observations.find(
        (o) => (o as { kind: string; entry?: string }).entry === probeEntry?.entry,
      ) as { value: Json } | undefined
      expect(probe).toBeDefined()
      expect(probe?.value).toBe(anchor.world.ids['toy-caller'].active)
      expect((await client.status()).world_head).toEqual(anchor.head)
    } finally {
      client.close()
    }
    expect(readJournal(journalFile())).toHaveLength(before)
  })
})
