// G2 真取消验收（入站协议 cancel{run}）：
// - 在途取消：立即以 cancelled 收口，审计 outcome=cancelled（result 记 cancelled），剩余轮（含 plan）丢弃；
// - 排队取消：轮到该 run 时不执行、不落账；
// - 未知 run：fail-closed（unknown_run）。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal, verifyFull } from '../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

const RUN_TERM: Json = ['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]

/** 服务 30s 才答：取消若未生效，用例必在断言窗口外超时失败。 */
const SLOW_MS = 30_000

describe('G2 真取消（cancel{run}）', () => {
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
    const slow = writeTempPackage(root, {
      identity: 'toy-slow',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      serviceConfig: { callDelayMs: SLOW_MS, callValue: { done: true } },
    })
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.alpha': 'toy-slow' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'run.json': JSON.stringify(RUN_TERM) },
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
    })
    const report = runSeed(root, [
      { name: 'toy-slow', path: slow },
      { name: 'toy-caller', path: caller },
    ])
    expect(report.ok).toBe(true)
  }

  async function entryOf(client: Awaited<ReturnType<typeof connect>>): Promise<string> {
    const commands = await client.commands()
    const command = commands.find((item) => item.name === 'toy-caller.run')
    expect(command).toBeDefined()
    return command!.entry
  }

  it('在途取消：cancelled 收口 + 审计 outcome=cancelled + 剩余 write 不落账', async () => {
    seed()
    const before = readJournal(journalFile()).length
    const handle = await startHost({ root, callTimeoutMs: 60_000 })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 5000 })
    try {
      const entry = await entryOf(client)
      let runId = ''
      const pending = client.submit(
        [
          { kind: 'eval', entry, args: null, ctx: null },
          {
            kind: 'write',
            request: {
              id: 'after-cancel',
              op: 'put',
              target: { expect_pos: null },
              args: { body: { should: 'not-land' } },
              by: 'client',
            },
          },
        ],
        { onAccepted: (run) => (runId = run) },
      )
      await waitFor(() => runId.length > 0, 'accepted')
      const begin = Date.now()
      await client.cancel(runId)
      const result = await pending
      const elapsed = Date.now() - begin
      expect(result.status).toBe('cancelled')
      expect(elapsed).toBeLessThan(2000)

      const entries = readJournal(journalFile())
      expect(verifyFull(entries).ok).toBe(true)
      const added = entries.slice(before)
      expect(added).toHaveLength(1)
      const body = (added[0].args as unknown as { body: { result: Json; outcome: string } }).body
      expect(body.result).toEqual({ ok: false, error: 'cancelled' })
      expect(body.outcome).toBe('cancelled')
      expect(added[0].by).toBe('client')
    } finally {
      client.close()
    }
  })

  it('排队取消：轮到该 run 时不执行、不落账，仅回 cancelled', async () => {
    seed()
    const before = readJournal(journalFile()).length
    const handle = await startHost({ root, callTimeoutMs: 60_000 })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 5000 })
    try {
      const entry = await entryOf(client)
      const runIds: string[] = []
      const first = client.submit([{ kind: 'eval', entry, args: null, ctx: null }], {
        onAccepted: (run) => runIds.push(run),
      })
      const second = client.submit([{ kind: 'eval', entry, args: null, ctx: null }], {
        onAccepted: (run) => runIds.push(run),
      })
      await waitFor(() => runIds.length === 2, 'accepted both')
      await client.cancel(runIds[1])
      await client.cancel(runIds[0])
      expect((await first).status).toBe('cancelled')
      expect((await second).status).toBe('cancelled')
      const added = readJournal(journalFile()).slice(before)
      // 只有第一个 run 的在途审计；排队的第二个 run 分文未动
      expect(added).toHaveLength(1)
      const body = (added[0].args as unknown as { body: { outcome: string } }).body
      expect(body.outcome).toBe('cancelled')
    } finally {
      client.close()
    }
  })

  it('未知 / 已结束的 run：fail-closed（unknown_run）', async () => {
    seed()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      await expect(client.cancel('not-a-run')).rejects.toMatchObject({ code: 'unknown_run' })
    } finally {
      client.close()
    }
  })
})
