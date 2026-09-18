// G5 F8 只读审计面验收：按回合（run）/ 身份（emitter）/ 结局（outcome）查询；
// 只读（不写链、不推进）；limit + truncated；重启后由 journal 重建索引。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal } from '../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { FIXTURE_ALPHA, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

const RUN_TERM: Json = ['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]

function bodyOf(record: { body: Json }): { [k: string]: Json } {
  return record.body as { [k: string]: Json }
}

describe('G5 F8 只读审计面（audit）', () => {
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
    const silent = writeTempPackage(root, {
      identity: 'toy-silent',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      serviceConfig: { callMode: 'silent' },
    })
    const caller = (identity: string, pin: string): string =>
      writeTempPackage(root, {
        identity,
        pins: { 'toy.alpha': pin },
        start: '',
        members: [{ kind: 'term', path: 'terms/' }],
        terms: { 'run.json': JSON.stringify(RUN_TERM) },
        commands: [{ name: `${identity}.run`, entry: 'terms/run.json' }],
      })
    const report = runSeed(root, [
      { name: 'toy-silent', path: silent },
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-caller-ok', path: caller('toy-caller-ok', 'toy-alpha') },
      { name: 'toy-caller-slow', path: caller('toy-caller-slow', 'toy-silent') },
    ])
    expect(report.ok).toBe(true)
  }

  async function start(callTimeoutMs?: number): Promise<HostHandle> {
    const handle =
      callTimeoutMs === undefined
        ? await startHost({ root })
        : await startHost({ root, callTimeoutMs })
    handles.push(handle)
    return handle
  }

  async function submitRun(
    client: Awaited<ReturnType<typeof connect>>,
    commandName: string,
  ): Promise<{ run: string; status: string }> {
    const entry = (await client.commands()).find((item) => item.name === commandName)!.entry
    let run = ''
    const result = await client.submit([{ kind: 'eval', entry, args: null, ctx: null }], {
      onAccepted: (id) => (run = id),
    })
    return { run, status: result.status }
  }

  it('按 run / emitter / outcome 过滤；seq 降序；limit + truncated；坏过滤 bad_directive', async () => {
    seed()
    await start(400)
    const client = await connect({ root, timeoutMs: 5000 })
    try {
      const ok = await submitRun(client, 'toy-caller-ok.run')
      expect(ok.status).toBe('done')
      const slow = await submitRun(client, 'toy-caller-slow.run')
      expect(slow.status).toBe('refused')

      const all = await client.audit()
      expect(all.truncated).toBe(false)
      expect(all.records.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < all.records.length; i++) {
        expect(all.records[i - 1].seq).toBeGreaterThan(all.records[i].seq)
      }
      // 最新一条 = 慢调用（transport_failed），并带 run / emitter / outcome / port / method
      expect(bodyOf(all.records[0])).toMatchObject({
        kind: 'effect_audit',
        port: 'toy.alpha',
        method: 'echo',
        outcome: 'transport_failed',
        emitter: 'toy-caller-slow',
        run: slow.run,
      })
      expect(typeof all.records[0].by).toBe('string')

      const byEmitter = await client.audit({ emitter: 'toy-caller-ok' })
      expect(byEmitter.records).toHaveLength(1)
      expect(bodyOf(byEmitter.records[0])).toMatchObject({ outcome: 'ok', run: ok.run })

      const byRun = await client.audit({ run: ok.run })
      expect(byRun.records).toHaveLength(1)
      expect(bodyOf(byRun.records[0])['emitter']).toBe('toy-caller-ok')

      const byOutcome = await client.audit({ outcome: 'transport_failed' })
      expect(byOutcome.records).toHaveLength(1)

      const limited = await client.audit({ limit: 1 })
      expect(limited.records).toHaveLength(1)
      expect(limited.truncated).toBe(true)

      await expect(client.audit({ outcome: 'nope' })).rejects.toMatchObject({
        code: 'bad_directive',
      })
      await expect(client.audit({ port: 'toy.alpha' } as never)).rejects.toMatchObject({
        code: 'bad_directive',
      })
    } finally {
      client.close()
    }
  })

  it('重启后由 journal 重建索引；查询只读（不写链）', async () => {
    seed()
    const handle = await start()
    const client = await connect({ root, timeoutMs: 5000 })
    const ok = await submitRun(client, 'toy-caller-ok.run')
    client.close()
    const before = readJournal(journalFile()).length
    await handle.stop()

    await start()
    const client2 = await connect({ root, timeoutMs: 5000 })
    try {
      const report = await client2.audit({ run: ok.run })
      expect(report.records).toHaveLength(1)
      expect(bodyOf(report.records[0])).toMatchObject({
        emitter: 'toy-caller-ok',
        outcome: 'ok',
      })
      // 只读：查询不改 journal、不推进 head
      expect(readJournal(journalFile()).length).toBe(before)
      expect((await client2.status()).world_head.hash).not.toBeNull()
    } finally {
      client2.close()
    }
  })
})
