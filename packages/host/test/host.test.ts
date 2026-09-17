import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { startHost } from '../host.ts'
import { join } from 'node:path'
import { createTempRoot, createToyPlugin, cleanupTempRoot } from '../test/test-helpers.ts'
import { runSeed } from '../offline.ts'

describe('宿主 host', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
    createToyPlugin(root)
    const { writeFileSync } = require('node:fs')
    writeFileSync(join(root, 'state', 'plugins.json'), JSON.stringify([{ name: 'toy', path: join(root, 'pkg', 'toy') }]))
  })

  afterEach(async () => {
    try {
      const handle = await startHost({ root })
      await handle.stop()
    } catch {
      // 宿主未运行或已停止
    }
    cleanupTempRoot(root)
  })

  it('startHost 返回 HostHandle，含 root / socket / stop / emitEvent', async () => {
    const handle = await startHost({ root })
    expect(handle.root).toBe(root)
    expect(typeof handle.socket).toBe('string')
    expect(typeof handle.stop).toBe('function')
    expect(typeof handle.emitEvent).toBe('function')
    await handle.stop()
  })

  it('stop 停机后锁可被重新 acquire', async () => {
    const handle = await startHost({ root })
    await handle.stop()
    const handle2 = await startHost({ root })
    expect(handle2.root).toBe(root)
    await handle2.stop()
  })

  it('submit [write] → done 落账', async () => {
    const handle = await startHost({ root })
    const { connect } = require('../../client/index.ts')
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const result = await client.submit([{ kind: 'write', request: { id: 'w1', op: 'put', target: { expect_pos: null }, args: { body: { v: 1 } }, by: 'client' } }])
      expect(result.status).toBe('done')
    } finally {
      client.close()
      await handle.stop()
    }
  })

  it('submit [eval(missing)] → refused，reasons 含 missing_ref', async () => {
    const handle = await startHost({ root })
    const { connect } = require('../../client/index.ts')
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const result = await client.submit([{ kind: 'eval', entry: 'ghost'.repeat(16), args: null, ctx: null }])
      expect(result.status).toBe('refused')
    } finally {
      client.close()
      await handle.stop()
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

    const handle = await startHost({ root })
    const { connect } = require('../../client/index.ts')
    const client = await connect({ root, timeoutMs: 2000 })
    try {
      const journalFile = join(root, 'state', 'world', 'journal.jsonl')
      const beforeCount = readJournal(journalFile).length

      const result = await client.submit([{ kind: 'eval', entry: toyEffHash, args: null, ctx: null }])
      expect(result.status).toBe('refused')
      const lastObs = result.observations[result.observations.length - 1] as any
      expect(lastObs).toMatchObject({ kind: 'refused', reasons: expect.arrayContaining(['eff_error']) })

      const afterEntries = readJournal(journalFile)
      expect(afterEntries.length).toBe(beforeCount + 1)
      const newEntry = afterEntries[afterEntries.length - 1]
      expect(newEntry.op).toBe('put')
      expect(newEntry.by).toBe('client')
      expect(newEntry.ref).toBeUndefined()

      const auditHash = H(newEntry.args as any)
      const replayed = replayFull(afterEntries)
      expect(replayed.defs[auditHash]).toBeDefined()
    } finally {
      client.close()
      await handle.stop()
    }
  })
})
