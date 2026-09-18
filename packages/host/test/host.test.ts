import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createTempRoot, createToyPlugin, cleanupTempRoot } from '../test/test-helpers.ts'
import { runSeed } from '../offline.ts'

describe('宿主 host', () => {
  let root: string
  const handles: HostHandle[] = []

  beforeEach(() => {
    root = createTempRoot()
    createToyPlugin(root)
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'toy', path: join(root, 'pkg', 'toy') }]),
    )
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 尽力停机
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  async function start(): Promise<HostHandle> {
    const handle = await startHost({ root })
    handles.push(handle)
    return handle
  }

  it('startHost 返回 HostHandle，含 root / socket / stop / emitEvent', async () => {
    const handle = await start()
    expect(handle.root).toBe(root)
    expect(typeof handle.socket).toBe('string')
    expect(typeof handle.stop).toBe('function')
    expect(typeof handle.emitEvent).toBe('function')
    await handle.stop()
  })

  it('stop 停机后锁可被重新 acquire', async () => {
    const handle = await start()
    await handle.stop()
    const handle2 = await start()
    expect(handle2.root).toBe(root)
    await handle2.stop()
  })

  it('submit [write] → done 落账', async () => {
    await start()
    const { connect } = require('../../client/index.ts')
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
    } finally {
      client.close()
    }
  })

  it('submit [eval(missing)] → refused，reasons 含 missing_ref 且不落账', async () => {
    await start()
    const { connect } = require('../../client/index.ts')
    const { readJournal } = require('../ledger/index.ts')
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const result = await client.submit([
        { kind: 'eval', entry: 'ghost'.repeat(16), args: null, ctx: null },
      ])
      expect(result.status).toBe('refused')
      expect(result.observations[result.observations.length - 1]).toMatchObject({
        kind: 'refused',
        reasons: expect.arrayContaining(['missing_ref']),
      })
      expect(readJournal(join(root, 'state', 'world', 'journal.jsonl'))).toEqual([])
    } finally {
      client.close()
    }
  })

  it('submit [eval(toy-eff)] → refused:eff_error，且 journal 文件真实多一条审计 entry（ref 留空）', async () => {
    const report = runSeed(root)
    expect(report.ok).toBe(true)

    const { loadAnchor, readJournal, replayFull } = require('../ledger/index.ts')
    const { listCommands } = require('../assembly/index.ts')
    const { H } = require('../../kernel/index.ts')
    const anchor = loadAnchor(join(root, 'state', 'world', 'journal.jsonl'))
    const commands = listCommands(anchor.world)
    const toyEff = commands.find((c: any) => c.name === 'toy.eff')
    expect(toyEff).toBeDefined()
    const toyEffHash = toyEff!.entry

    await start()
    const { connect } = require('../../client/index.ts')
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const journalFile = join(root, 'state', 'world', 'journal.jsonl')
      const beforeCount = readJournal(journalFile).length

      const result = await client.submit([
        { kind: 'eval', entry: toyEffHash, args: null, ctx: null },
      ])
      expect(result.status).toBe('refused')
      const lastObs = result.observations[result.observations.length - 1] as any
      expect(lastObs).toMatchObject({
        kind: 'refused',
        reasons: expect.arrayContaining(['eff_error']),
      })

      const afterEntries = readJournal(journalFile)
      expect(afterEntries.length).toBe(beforeCount + 1)
      const newEntry = afterEntries[afterEntries.length - 1]
      expect(newEntry.op).toBe('put')
      expect(newEntry.by).toBe('client')
      expect(newEntry.ref).toBeUndefined()
      // S4：toy-eff 无 pins → A1 路由归 unresolved_cap，内核归 eff_error
      const auditBody = (newEntry.args as { body: { result: { ok: boolean; error: string } } }).body
      expect(auditBody.result).toEqual({ ok: false, error: 'unresolved_cap' })

      const auditHash = H(newEntry.args as any)
      const replayed = replayFull(afterEntries)
      expect(replayed.defs[auditHash]).toBeDefined()
    } finally {
      client.close()
    }
  })
})
