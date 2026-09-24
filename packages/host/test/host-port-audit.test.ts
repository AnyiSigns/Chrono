// H19 反向调用端口审计：目标服务照收 args 顶层 env 原值；宿主侧端口审计记录把 env 值
// 替换为 `{redacted:true, keys:[…]}`（键名排序）；端口审计不进世界、不写链。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal } from '../ledger/index.ts'
import { createTempRoot, cleanupTempRoot, readAuditRecords } from './test-helpers.ts'
import { REVERSE_SERVICE_MAIN, waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'
import type { PortAuditRecord } from '../port-audit.ts'
import type { Json } from '../../kernel/index.ts'

const SECRET = 's3cr3t-value'
const ORIGIN_TERM: Json = ['eff', 'toy.origin', 'echo', ['c', { n: 1 }]]

describe('H19 反向调用端口审计（env 值脱敏）', () => {
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

  /** 反向服务（origin）把带密钥的 env 经 `port.call` 下传目标；targetConfig 覆写目标行为。 */
  function seedReverse(targetConfig?: Record<string, unknown>): void {
    const target = writeTempPackage(root, {
      identity: 'toy-target',
      implements: ['toy.target'],
      methods: { 'toy.target': ['echo'] },
      start: 'node execute/main.js',
      ...(targetConfig === undefined ? {} : { serviceConfig: targetConfig }),
    })
    const origin = writeTempPackage(root, {
      identity: 'toy-origin',
      implements: ['toy.origin'],
      methods: { 'toy.origin': ['echo'] },
      pins: { 'toy.target': 'toy-target' },
      start: 'node execute/main.js',
      serviceConfig: {
        reversePort: 'toy.target',
        reverseMethod: 'echo',
        reverseArgs: { env: { secret: SECRET, apiKey: 'zzz' }, n: 7 },
      },
      files: { 'execute/main.js': REVERSE_SERVICE_MAIN },
    })
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.origin': 'toy-origin' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'run.json': JSON.stringify(ORIGIN_TERM) },
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'toy-target', path: target },
        { name: 'toy-origin', path: origin },
        { name: 'toy-caller', path: caller },
      ]).ok,
    ).toBe(true)
  }

  it('目标照收原始 env；端口审计记录里 env 值脱敏、键名排序、其余 args 未动', async () => {
    seedReverse()
    const captured: PortAuditRecord[] = []
    const handle = await startHost({
      root,
      portAuditSink: { record: (record) => captured.push(record) },
    })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const result = await client.command('toy-caller.run', null, { thread: 'thr-r' })
      expect(result.status).toBe('done')
      const value = (result.observations[0] as { value: Json }).value as {
        forwarded: { args: Json }
        argsEnv: Json
      }
      // 目标收到的是原始 env 值：脱敏只发生在本机端口审计记录里
      expect(value.forwarded.args).toEqual({ env: { secret: SECRET, apiKey: 'zzz' }, n: 7 })
      // 发起服务自身入站 args 无 env，证明转发的是反向调用 args
      expect(value.argsEnv).toBeNull()

      await waitFor(() => captured.length > 0, 'port audit record')
      const record = captured[0]
      expect(record.from).toBe('toy-origin')
      expect(record.target).toBe('toy-target')
      expect(record.port).toBe('toy.target')
      expect(record.method).toBe('echo')
      expect(record.args).toEqual({ env: { redacted: true, keys: ['apiKey', 'secret'] }, n: 7 })
      expect(record.thread).toBe('thr-r')
      const started = events.find(
        (event) =>
          event.impl === 'host' &&
          event.topic === 'run.started' &&
          (event.payload as { thread?: string }).thread === 'thr-r',
      )
      expect(record.run).toBe((started?.payload as { run?: string }).run)
    } finally {
      client.close()
    }
  }, 20000)

  it('端口审计不进世界：本次 run 只多一条 effect_audit，journal 无脱敏标记', async () => {
    // 目标不回显 args：本次 run 的世界记录里不应出现 env 值，便于断言端口审计没有旁路写链
    seedReverse({ callValue: { ok: true } })
    const before = readJournal(journalFile()).length
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.run')
      expect(result.status).toBe('done')
    } finally {
      client.close()
    }
    // 反向调用只记宿主侧端口审计：journal 不变，正向效果审计进旁路侧存
    expect(readJournal(journalFile()).length).toBe(before)
    const audits = readAuditRecords(root)
    expect(audits).toHaveLength(1)
    const body = audits[0].body as { kind?: string; port?: string }
    expect(body.kind).toBe('effect_audit')
    expect(body.port).toBe('toy.origin')
    const text = JSON.stringify(audits)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('"redacted"')
  }, 20000)

  it('缺省环形缓冲可经 HostHandle.portAuditRecords 只读快照读取（无需注入 sink）', async () => {
    seedReverse()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.run')
      expect(result.status).toBe('done')
      await waitFor(() => handle.portAuditRecords().length > 0, 'port audit snapshot')
      const record = handle.portAuditRecords()[0]
      expect(record.from).toBe('toy-origin')
      expect(record.target).toBe('toy-target')
      expect(record.args).toEqual({ env: { redacted: true, keys: ['apiKey', 'secret'] }, n: 7 })
      // 只读快照：改动返回值不影响缓冲本体
      handle.portAuditRecords().length = 0
      expect(handle.portAuditRecords().length).toBe(1)
    } finally {
      client.close()
    }
  }, 20000)

  it('注入 sink 抛错不打断反向转发，宿主快照仍记录', async () => {
    seedReverse()
    const handle = await startHost({
      root,
      portAuditSink: {
        record: () => {
          throw new Error('sink boom')
        },
      },
    })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.run')
      expect(result.status).toBe('done')
      const value = (result.observations[0] as { value: Json }).value as { forwarded: { args: Json } }
      expect(value.forwarded.args).toEqual({ env: { secret: SECRET, apiKey: 'zzz' }, n: 7 })
      expect(handle.portAuditRecords().length).toBe(1)
    } finally {
      client.close()
    }
  }, 20000)
})
