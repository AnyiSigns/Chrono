// G2 真取消验收（入站协议 cancel{run}）：
// - 在途取消：立即以 cancelled 收口，审计 outcome=cancelled（result 记 cancelled），剩余轮（含 plan）丢弃；
// - 并发取消：多个 run 同时推进（run 级并发），各自取消后都不落业务写，仅各留一条 cancelled 审计；
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

/** 先落一条业务写、再发慢 eff：写落链即可证明 command run 已在途（随后进入慢调用）。 */
const PLAN_THEN_EFF: Json = [
  'c',
  {
    $directives: [
      { kind: 'write', request: { op: 'put', args: { body: { stage: 'pre' } } } },
      { kind: 'eval', entry: { $ref: 'terms/run.json' } },
    ],
  },
]

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
      terms: {
        'run.json': JSON.stringify(RUN_TERM),
        'planThenEff.json': JSON.stringify(PLAN_THEN_EFF),
      },
      commands: [
        { name: 'toy-caller.run', entry: 'terms/run.json' },
        { name: 'toy-caller.run.slow', entry: 'terms/planThenEff.json' },
      ],
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

  it('并发取消：两个 run 同时推进、各自取消后不落业务写，仅各留一条 cancelled 审计', async () => {
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
      // run 级并发：两个 run 都在等待慢服务，取消各自在途调用
      await client.cancel(runIds[1])
      await client.cancel(runIds[0])
      expect((await first).status).toBe('cancelled')
      expect((await second).status).toBe('cancelled')
      const entries = readJournal(journalFile())
      expect(verifyFull(entries).ok).toBe(true)
      const added = entries.slice(before)
      // 两个 run 各留一条 cancelled 审计；无业务写
      expect(added).toHaveLength(2)
      for (const item of added) {
        const body = (item.args as unknown as { body: { outcome: string } }).body
        expect(body.outcome).toBe('cancelled')
      }
    } finally {
      client.close()
    }
  })

  it('command run 登记在册：停机 abort 覆盖，不耗在慢服务上', async () => {
    seed()
    const before = readJournal(journalFile()).length
    const handle = await startHost({ root, callTimeoutMs: 60_000 })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 5000 })
    const pending = client.command('toy-caller.run.slow')
    try {
      // plan 的业务写先落链：command run 已在途（随后进入 30s 慢 eff）
      await waitFor(() => readJournal(journalFile()).length > before, 'command plan write')
      const begin = Date.now()
      await handle.stop()
      // 未覆盖 command run 时停机要等慢调用（30s）；abort 生效则立即收敛
      expect(Date.now() - begin).toBeLessThan(3000)
    } finally {
      client.close()
    }
    // 停机可能先于 result 帧到达就断连：两种收口都算，不允许长时间挂起
    await pending.catch(() => undefined)
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
