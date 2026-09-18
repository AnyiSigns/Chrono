import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import {
  acquireLock,
  headOf,
  loadAnchor,
  readJournal,
  releaseLock,
  verifyFull,
} from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { H, pos } from '../../kernel/index.ts'
import type { Entry, Json } from '../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { FIXTURE_ALPHA, waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

/** 命令入口：先发 eff，再返回 plan（plan 里带一条业务 put）。 */
const RUN_TERM: Json = [
  'call',
  ['c', { $ref: 'terms/plan.json' }],
  [['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]],
]

const PLAN_TERM: Json = [
  'c',
  {
    $directives: [{ kind: 'write', request: { op: 'put', args: { body: { done: true } } } }],
  },
]

const ARGS_SCHEMA: Json = {
  type: 'object',
  properties: { n: { type: 'integer' } },
  required: ['n'],
  additionalProperties: false,
}

describe('S4 效果：eff → 审计 → 回灌 → 落账', () => {
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

  function writeCaller(pins: Record<string, string>): string {
    return writeTempPackage(root, {
      identity: 'toy-caller',
      pins,
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [
        { name: 'toy-caller.run', entry: 'terms/run.json' },
        { name: 'toy-caller.gated', entry: 'terms/run.json', argsSchema: 'schema/args.json' },
        { name: 'toy-caller.echo', entry: 'terms/hello.json', argsSchema: 'schema/args.json' },
      ],
      terms: {
        'plan.json': JSON.stringify(PLAN_TERM),
        'run.json': JSON.stringify(RUN_TERM),
        'hello.json': JSON.stringify(['c', 'hello']),
      },
      files: { 'schema/args.json': JSON.stringify(ARGS_SCHEMA) },
    })
  }

  async function start(options: { callTimeoutMs?: number } = {}): Promise<HostHandle> {
    const handle = await startHost({ root, ...options })
    handles.push(handle)
    return handle
  }

  function seedDefault(): void {
    const report = runSeed(root, [
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-alpha' }) },
    ])
    expect(report.ok).toBe(true)
  }

  it('命令走 eff：审计先落、值回灌、plan 写带 ref、链完整可校验、status 与账本一致', async () => {
    seedDefault()
    const before = readJournal(journalFile()).length
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    let headMirror: { seq: number; hash: string | null } | undefined
    try {
      const result = await client.command('toy-caller.run')
      expect(result.status).toBe('done')
      expect(result.observations.map((o) => (o as { kind: string }).kind)).toEqual([
        'eval',
        'write',
      ])
      headMirror = (await client.status()).world_head
    } finally {
      client.close()
    }
    const entries = readJournal(journalFile())
    expect(verifyFull(entries).ok).toBe(true)
    // 宿主运行态链头与账本独立复算一致（不依赖内存 replay 与自身对比）
    expect(headMirror).toEqual(headOf(entries))
    const added = entries.slice(before)
    expect(added).toHaveLength(2)
    const audit = added[0]
    expect(audit.op).toBe('put')
    expect(audit.by).toBe('command')
    const auditHash = H(audit.args as Json)
    const auditBody = (audit.args as { body: { request: Json; result: Json } }).body
    expect(auditBody.request).toMatchObject({ port: 'toy.alpha', method: 'echo', args: { n: 1 } })
    expect(auditBody.result).toMatchObject({
      ok: true,
      value: { impl: 'toy-alpha', port: 'toy.alpha', method: 'echo' },
    })
    // 业务写指纹：ref 指审计 def、prev 接审计 entry、seq 连续
    const write = added[1]
    expect(write.ref).toBe(auditHash)
    expect(write.prev).toBe(pos([audit]))
    expect(write.seq).toBe(audit.seq + 1)
    // 从空世界重放：审计 def 与业务写 def 都可寻址（世界内容按条目重建）
    const replayed = loadAnchor(journalFile()).world
    expect(replayed.defs[auditHash]).toBeDefined()
    expect(replayed.defs[H(write.args as Json)]).toBeDefined()
  })

  it('refused 后继续提交：新写接在审计之后，链不分叉', async () => {
    const silent = writeTempPackage(root, {
      identity: 'toy-silent',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      serviceConfig: { callMode: 'silent' },
    })
    runSeed(root, [
      { name: 'toy-silent', path: silent },
      { name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-silent' }) },
    ])
    const before = readJournal(journalFile()).length
    await start({ callTimeoutMs: 300 })
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const refused = await client.command('toy-caller.run')
      expect(refused.status).toBe('refused')
      // 审计已落链（refused 轮的 head 必须回灌到宿主）
      const afterRefused = readJournal(journalFile())
      expect(afterRefused).toHaveLength(before + 1)
      const audit = afterRefused[afterRefused.length - 1]
      // 下一次提交：写必须续在审计 entry 之后，宿主 status 不能落后
      const next = await client.submit([
        {
          kind: 'write',
          request: {
            id: 'after-refused',
            op: 'put',
            target: { expect_pos: null },
            args: { body: { after: true } },
            by: 'client',
          },
        },
      ])
      expect(next.status).toBe('done')
      const status = await client.status()
      const entries = readJournal(journalFile())
      expect(verifyFull(entries).ok).toBe(true)
      expect(status.world_head).toEqual(headOf(entries))
      const write = entries[entries.length - 1]
      expect(write.prev).toBe(pos([audit]))
      expect(write.seq).toBe(audit.seq + 1)
    } finally {
      client.close()
    }
  })

  it('命令坏参 → bad_args：不跑 run、不落账（审计也没有）', async () => {
    seedDefault()
    const before = readJournal(journalFile()).length
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      // gated 命令入口会发 eff：若 exec/run 被误跑，journal 必增
      await expect(client.command('toy-caller.gated', {})).rejects.toMatchObject({
        code: 'bad_args',
      })
      await expect(client.command('toy-caller.gated', { n: 1, extra: true })).rejects.toMatchObject(
        { code: 'bad_args' },
      )
      expect(readJournal(journalFile()).length).toBe(before)
      const ok = await client.command('toy-caller.gated', { n: 1 })
      expect(ok.status).toBe('done')
      expect(readJournal(journalFile()).length).toBe(before + 2)
    } finally {
      client.close()
    }
  })

  it('extern 观测原样回流、不落账、不推进 head', async () => {
    seedDefault()
    const before = readJournal(journalFile()).length
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const headBefore = (await client.status()).world_head
      const result = await client.submit([{ kind: 'extern', payload: { x: 1 } }])
      expect(result.status).toBe('done')
      expect(result.observations).toEqual([{ kind: 'extern', payload: { x: 1 } }])
      const headAfter = (await client.status()).world_head
      expect(headAfter).toEqual(headBefore)
    } finally {
      client.close()
    }
    expect(readJournal(journalFile()).length).toBe(before)
  })

  it('A1 失败码落审计：依赖不声明能力类 → not_loaded；依赖退役 → stale', async () => {
    const noncap = writeTempPackage(root, { identity: 'toy-noncap', start: '' })
    runSeed(root, [
      { name: 'toy-noncap', path: noncap },
      { name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-noncap' }) },
    ])
    const before = readJournal(journalFile()).length
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const first = await client.command('toy-caller.run')
      expect(first.status).toBe('refused')
      let entries = readJournal(journalFile())
      expect(entries).toHaveLength(before + 1)
      expect(auditResult(entries[entries.length - 1])).toEqual({ ok: false, error: 'not_loaded' })

      const retired = await client.submit([
        {
          kind: 'write',
          request: {
            id: 'retire-noncap',
            op: 'retire',
            target: { expect_pos: null },
            args: { id: 'toy-noncap' },
            by: 'client',
          },
        },
      ])
      expect(retired.status).toBe('done')
      entries = readJournal(journalFile())
      const mark = entries.length

      const second = await client.command('toy-caller.run')
      expect(second.status).toBe('refused')
      entries = readJournal(journalFile())
      expect(entries).toHaveLength(mark + 1)
      expect(auditResult(entries[entries.length - 1])).toEqual({ ok: false, error: 'stale' })
    } finally {
      client.close()
    }
  })

  it('argsSchema 白名单外关键词 → 入世 bad_args_schema 整包拒、世界分文未动', async () => {
    const badRoot = writeTempPackage(root, {
      identity: 'toy-badschema',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [
        { name: 'toy-badschema.cmd', entry: 'terms/h.json', argsSchema: 'schema/args.json' },
      ],
      terms: { 'h.json': JSON.stringify(['c', 1]) },
      files: { 'schema/args.json': JSON.stringify({ type: 'object', oneOf: [] }) },
    })
    const report = runSeed(root, [{ name: 'toy-badschema', path: badRoot }])
    expect(report.ok).toBe(false)
    expect(report.items[0].status).toBe('failed')
    expect(report.items[0].reasons.some((r) => r.startsWith('bad_args_schema'))).toBe(true)
    expect(loadAnchor(journalFile()).world.ids['toy-badschema']).toBeUndefined()
  })

  it('换 toy 服务实现（改 pins 指向）不改调用方 term：值来自新实现', async () => {
    const impl2 = writeTempPackage(root, {
      identity: 'toy-alpha-2',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
    })
    seedDefault()
    expect(runSeed(root, [{ name: 'toy-alpha-2', path: impl2 }]).ok).toBe(true)

    // 第一世代：pins → toy-alpha
    let before = readJournal(journalFile()).length
    await start()
    let client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-caller.run')).status).toBe('done')
    } finally {
      client.close()
    }
    let added = readJournal(journalFile()).slice(before)
    expect(auditImpl(added)).toBe('toy-alpha')

    // 换代：同一 term 源，只改 pins 指向 toy-alpha-2，重新入世
    const callerV2 = writeCaller({ 'toy.alpha': 'toy-alpha-2' })
    expect(readFileSync(join(callerV2, 'terms', 'run.json'), 'utf8')).toBe(JSON.stringify(RUN_TERM))
    await handles[handles.length - 1].stop()
    expect(runSeed(root, [{ name: 'toy-caller', path: callerV2 }]).ok).toBe(true)

    before = readJournal(journalFile()).length
    await start()
    client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-caller.run')).status).toBe('done')
    } finally {
      client.close()
    }
    added = readJournal(journalFile()).slice(before)
    expect(auditImpl(added)).toBe('toy-alpha-2')
  }, 30000)

  it('服务回 error → 数据回灌；静默超时 → transport_failed 且 refused', async () => {
    const denied = writeTempPackage(root, {
      identity: 'toy-denied',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      serviceConfig: { callMode: 'error', callErrorCode: 'toy.denied', callErrorMessage: 'nope' },
    })
    const silent = writeTempPackage(root, {
      identity: 'toy-silent',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      serviceConfig: { callMode: 'silent' },
    })
    expect(
      runSeed(root, [
        { name: 'toy-denied', path: denied },
        { name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-denied' }) },
      ]).ok,
    ).toBe(true)
    const deniedBefore = readJournal(journalFile()).length
    await start({ callTimeoutMs: 500 })
    let client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-caller.run')).status).toBe('done')
    } finally {
      client.close()
    }
    let added = readJournal(journalFile()).slice(deniedBefore)
    expect(added).toHaveLength(2)
    expect(auditResult(added[0])).toEqual({
      ok: true,
      value: { error: 'toy.denied', message: 'nope' },
    })

    // 静默：调用超时 → 传输层失败，整轮 refused，无业务写
    await handles[handles.length - 1].stop()
    expect(
      runSeed(root, [
        { name: 'toy-silent', path: silent },
        { name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-silent' }) },
      ]).ok,
    ).toBe(true)
    const before = readJournal(journalFile()).length
    await start({ callTimeoutMs: 400 })
    client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.run')
      expect(result.status).toBe('refused')
      expect(result.observations[result.observations.length - 1]).toMatchObject({
        kind: 'refused',
        reasons: ['eff_error'],
      })
    } finally {
      client.close()
    }
    added = readJournal(journalFile()).slice(before)
    // 只有审计（无业务写）
    expect(added).toHaveLength(1)
    expect(auditResult(added[0])).toEqual({ ok: false, error: 'transport_failed' })
  }, 30000)

  it('并发提交串行化：两条写同链、无 pos_conflict', async () => {
    seedDefault()
    const before = readJournal(journalFile()).length
    await start()
    const first = await connect({ root, timeoutMs: 3000 })
    const second = await connect({ root, timeoutMs: 3000 })
    try {
      const [r1, r2] = await Promise.all([
        first.submit([
          {
            kind: 'write',
            request: {
              id: 'c1',
              op: 'put',
              target: { expect_pos: null },
              args: { body: { concurrent: 1 } },
              by: 'client',
            },
          },
        ]),
        second.submit([
          {
            kind: 'write',
            request: {
              id: 'c2',
              op: 'put',
              target: { expect_pos: null },
              args: { body: { concurrent: 2 } },
              by: 'client',
            },
          },
        ]),
      ])
      expect(r1.status).toBe('done')
      expect(r2.status).toBe('done')
    } finally {
      first.close()
      second.close()
    }
    const entries = readJournal(journalFile())
    expect(entries.length).toBe(before + 2)
    expect(verifyFull(entries).ok).toBe(true)
    expect(entries[entries.length - 1].prev).toBe(pos(entries.slice(0, entries.length - 1)))
  })

  it('stop 与在途提交：等在途落账后再停机，锁可再抢', async () => {
    const delayed = writeTempPackage(root, {
      identity: 'toy-delayed',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      serviceConfig: { callDelayMs: 1500 },
    })
    runSeed(root, [
      { name: 'toy-delayed', path: delayed },
      { name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-delayed' }) },
    ])
    const before = readJournal(journalFile()).length
    await start({ callTimeoutMs: 5000 })
    const worker = await connect({ root, timeoutMs: 3000 })
    const stopper = await connect({ root, timeoutMs: 3000 })
    let result: { status: string } | undefined
    try {
      const pending = worker.command('toy-caller.run')
      // 留足余量让命令帧先被宿主受理（stop 之前已在途），再下发停机
      await new Promise((resolve) => setTimeout(resolve, 250))
      await stopper.stop()
      result = await pending
    } finally {
      worker.close()
      stopper.close()
    }
    expect(result?.status).toBe('done')
    // 在途提交的审计 + 业务写都落账后才停机
    const added = readJournal(journalFile()).slice(before)
    expect(added).toHaveLength(2)
    // 停机完成后锁可再抢
    const lockFile = hostPaths(root).lockFile
    await waitFor(
      () => {
        const lock = acquireLock(lockFile, Date.now())
        if (!lock.ok) return false
        releaseLock(lockFile)
        return true
      },
      '停机后锁可再抢',
      10000,
    )
  }, 30000)
})

/** 审计 entry 的 result；非审计返回 null。 */
function auditResult(entry: Entry): Json | null {
  const body = (entry.args as { body?: { result?: Json } }).body
  return body?.result ?? null
}

/** 从新增 entries 里取审计 result 的被调实现名。 */
function auditImpl(entries: Entry[]): string | null {
  for (const entry of entries) {
    const result = auditResult(entry) as { value?: { impl?: string } } | null
    if (typeof result?.value?.impl === 'string') return result.value.impl
  }
  return null
}
