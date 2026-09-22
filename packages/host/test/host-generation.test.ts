// S5 世代跟随 E2E（A6 换代 / 退役隔离 + A8 单写者）：
// 入站面提交 add_gen / set_active / retire → 宿主在同一提交返回前完成跟随；
// 数据变化进程不动、代码变化旧服务排空退出；依赖换代只重解析路由；依赖退役隔离发出者。
// 诊断经运维日志 / status.loaded / 审计 result 取值；链逐字节可校验。

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runReplay, runSeed, runVerify } from '../offline.ts'
import { loadAnchor, readJournal, verifyFull } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { getBlob, isBlobPointer, putBlob } from '../blobs.ts'
import { H } from '../../kernel/index.ts'
import type { Directive, Entry, Hash, Json, Op, World } from '../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import {
  FIXTURE_ALPHA,
  FIXTURE_SERVICE_MAIN,
  isPidAlive,
  readLifecycle,
  waitFor,
  writeTempPackage,
} from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

/** 命令入口：发一条 eff（审计即留痕；无业务写）。 */
const RUN_TERM: Json = ['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]

/** 同一身份两代实现的公共声明（execute 成员；两代源码不同）。 */
const IMPL_DECL = {
  implements: ['toy.alpha'],
  methods: { 'toy.alpha': ['echo'] },
  start: 'node execute/main.js',
  members: [{ kind: 'execute', path: 'execute/' }],
}

describe('S5 世代跟随（A6）与单写者（A8）', () => {
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

  function lifecycleFile(): string {
    return hostPaths(root).lifecycleFile
  }

  function writeCaller(pins: Record<string, string>): string {
    return writeTempPackage(root, {
      identity: 'toy-caller',
      pins,
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
      terms: { 'run.json': JSON.stringify(RUN_TERM) },
    })
  }

  /** 末条审计 entry 的 result。 */
  function lastAuditResult(entries: Entry[]): Json | null {
    for (let i = entries.length - 1; i >= 0; i--) {
      const body = (entries[i].args as { body?: { request?: Json; result?: Json } }).body
      if (body?.request !== undefined) return body.result ?? null
    }
    return null
  }

  /** 末条审计 result 的 value.pid（默认回值带 pid）。 */
  function lastServicePid(): number {
    const result = lastAuditResult(readJournal(journalFile())) as {
      value?: { pid?: number }
    } | null
    const pid = result?.value?.pid
    expect(typeof pid).toBe('number')
    return pid as number
  }

  async function start(): Promise<HostHandle> {
    const handle = await startHost({ root })
    handles.push(handle)
    return handle
  }

  interface Crafted {
    ops: Json[]
    commitArgs: Json
    commitHash: Hash
  }

  /** 造一个复用现有 tree 的新 commit（数据换代：成员内容不变）。 */
  function craftSameTreeCommit(world: World, genHash: Hash): Crafted {
    const tree = (world.defs[genHash].body as { tree: Hash }).tree
    const commitArgs = {
      body: { tree, meta: { name: 'toy-alpha', version: '9.9.9' } },
    } as unknown as Json
    return { ops: [{ op: 'put', args: commitArgs }], commitArgs, commitHash: H(commitArgs) }
  }

  /** 造一个 execute 内容变化的新 tree / commit（代码换代）。 */
  function craftNewCodeCommit(world: World, genHash: Hash): Crafted {
    const tree = (world.defs[genHash].body as { tree: Hash }).tree
    const rootEntries = (world.defs[tree].body as { entries: Json[] }).entries
    const execEntry = rootEntries.find((e) => (e as { name?: string }).name === 'execute') as {
      name: string
      mode: string
      hash: Hash
    }
    const execEntries = (world.defs[execEntry.hash].body as { entries: Json[] }).entries
    const mainEntry = execEntries.find((e) => (e as { name?: string }).name === 'main.js') as {
      name: string
      mode: string
      hash: Hash
    }
    // 新形态是 pointer（经 CAS 读字节），旧形态是 inline 字符串；两者都支持
    const blobsDir = hostPaths(root).blobsDir
    const mainBody = world.defs[mainEntry.hash].body
    let original: Buffer
    if (isBlobPointer(mainBody)) {
      const read = getBlob(blobsDir, mainBody)
      if (!read.ok) throw new Error('main.js blob missing')
      original = read.bytes
    } else {
      original = Buffer.from(mainBody as string, 'utf8')
    }
    const put = putBlob(blobsDir, Buffer.concat([original, Buffer.from('\n// v2\n', 'utf8')]))
    if (!put.ok) throw new Error('bad blob')
    const blob = { body: put.pointer }
    const blobHash = H(blob)
    const execTree = { body: { entries: [{ name: 'main.js', mode: 'file', hash: blobHash }] } }
    const execTreeHash = H(execTree)
    const newRootEntries = rootEntries.map((e) =>
      (e as { name?: string }).name === 'execute' ? { ...(e as object), hash: execTreeHash } : e,
    )
    const rootTree = { body: { entries: newRootEntries } }
    const rootTreeHash = H(rootTree)
    const commitArgs = {
      body: { tree: rootTreeHash, meta: { name: 'toy-alpha', version: '9.9.10' } },
    } as unknown as Json
    return {
      ops: [
        { op: 'put', args: blob },
        { op: 'put', args: execTree },
        { op: 'put', args: rootTree },
        { op: 'put', args: commitArgs },
      ],
      commitArgs,
      commitHash: H(commitArgs),
    }
  }

  function writeDirective(id: string, op: Op, args: Json): Directive {
    return {
      kind: 'write',
      request: { id, op, target: { expect_pos: null }, args, by: 'client' },
    }
  }

  function addGenBatch(id: string, ops: Json[], payload: Hash): Directive {
    return writeDirective(`ag-${randomUUID()}`, 'batch', {
      ops: [...ops, { op: 'add_gen', args: { id, payload, sig: payload, pins: {} } }],
    })
  }

  it('add_gen 入世即激活：数据变化 reload（进程不动）→ 代码变化起新服务（旧进程退出）', async () => {
    expect(
      runSeed(root, [
        { name: 'toy-alpha', path: FIXTURE_ALPHA },
        { name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-alpha' }) },
      ]).ok,
    ).toBe(true)
    const anchor = loadAnchor(journalFile())
    const originalGen = anchor.world.ids['toy-alpha'].active as Hash
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    let dataPid = 0
    let codePid = 0
    try {
      const first = await client.command('toy-caller.run')
      expect(first.status).toBe('done')
      dataPid = lastServicePid()

      // ① 数据换代：新 commit 复用同 tree → 成员内容不变 → reload/ack，进程不动
      const data = craftSameTreeCommit(anchor.world, originalGen)
      const put = await client.submit([writeDirective('d1', 'put', data.commitArgs)])
      expect(put.status).toBe('done')
      const dataApplied = await client.submit([addGenBatch('toy-alpha', [], data.commitHash)])
      expect(dataApplied.status).toBe('done')
      expect((await client.status()).loaded).toContainEqual({
        id: 'toy-alpha',
        gen: data.commitHash,
      })
      const reloaded = await client.command('toy-caller.run')
      expect(reloaded.status).toBe('done')
      expect(lastServicePid()).toBe(dataPid)
      expect(
        readLifecycle(lifecycleFile()).some(
          (r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-alpha',
        ),
      ).toBe(false)

      // ② 代码换代：新 tree 的 execute/main.js 变化 → 起新服务、旧进程 drain 退出
      const code = craftNewCodeCommit(anchor.world, originalGen)
      const applied = await client.submit([addGenBatch('toy-alpha', code.ops, code.commitHash)])
      expect(applied.status).toBe('done')
      await waitFor(() => !isPidAlive(dataPid), '旧服务进程退出', 8000)
      const swapped = await client.command('toy-caller.run')
      expect(swapped.status).toBe('done')
      codePid = lastServicePid()
      expect(codePid).not.toBe(dataPid)
      expect(isPidAlive(codePid)).toBe(true)
      expect((await client.status()).loaded).toContainEqual({
        id: 'toy-alpha',
        gen: code.commitHash,
      })
      expect(
        readLifecycle(lifecycleFile()).some(
          (r) =>
            r.kind === 'service' &&
            r.event === 'exit' &&
            r.impl === 'toy-alpha' &&
            r.reason === 'superseded',
        ),
      ).toBe(true)
    } finally {
      client.close()
    }
    // 链完整可校验（宿主持锁，离线 verify 不可用）
    expect(verifyFull(readJournal(journalFile())).ok).toBe(true)
  }, 30000)

  it('set_active 换代：代码变化换服务、回滚再换回；旧服务排空退出', async () => {
    const v2 = writeTempPackage(root, {
      identity: 'toy-alpha',
      dir: 'toy-alpha-v2',
      ...IMPL_DECL,
      files: { 'execute/version.js': '// v2\n' },
    })
    expect(runSeed(root, [{ name: 'toy-alpha', path: v2 }]).ok).toBe(true)
    const v1 = writeTempPackage(root, {
      identity: 'toy-alpha',
      dir: 'toy-alpha-v1',
      ...IMPL_DECL,
    })
    expect(runSeed(root, [{ name: 'toy-alpha', path: v1 }]).ok).toBe(true)
    expect(
      runSeed(root, [{ name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-alpha' }) }]).ok,
    ).toBe(true)
    const anchor = loadAnchor(journalFile())
    const gens = anchor.world.ids['toy-alpha'].gens
    const v2Gen = gens[0].payload
    const v1Gen = gens[1].payload
    expect(anchor.world.ids['toy-alpha'].active).toBe(v1Gen)

    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    const pids: number[] = []
    try {
      expect((await client.command('toy-caller.run')).status).toBe('done')
      pids.push(lastServicePid())

      const toV2 = await client.submit([
        writeDirective('to-v2', 'set_active', { id: 'toy-alpha', active: v2Gen }),
      ])
      expect(toV2.status).toBe('done')
      await waitFor(() => !isPidAlive(pids[0]), 'v1 旧服务退出', 8000)
      expect((await client.status()).loaded).toContainEqual({
        id: 'toy-alpha',
        gen: v2Gen,
      })
      expect((await client.command('toy-caller.run')).status).toBe('done')
      pids.push(lastServicePid())
      expect(pids[1]).not.toBe(pids[0])

      const back = await client.submit([
        writeDirective('back-v1', 'set_active', { id: 'toy-alpha', active: v1Gen }),
      ])
      expect(back.status).toBe('done')
      await waitFor(() => !isPidAlive(pids[1]), 'v2 旧服务退出', 8000)
      expect((await client.command('toy-caller.run')).status).toBe('done')
      pids.push(lastServicePid())
      expect(pids[2]).not.toBe(pids[1])
      expect((await client.status()).loaded).toContainEqual({
        id: 'toy-alpha',
        gen: v1Gen,
      })
    } finally {
      client.close()
    }
    expect(verifyFull(readJournal(journalFile())).ok).toBe(true)
  }, 30000)

  it('plan 内 write(set_active) 与后续 eval 不共轮：换代在下一轮之前落地，后续 eff 打到新服务', async () => {
    const v2 = writeTempPackage(root, {
      identity: 'toy-alpha',
      dir: 'toy-alpha-v2',
      ...IMPL_DECL,
      serviceConfig: { callValue: { version: 'v2' } },
      files: { 'execute/version.js': '// v2\n' },
    })
    expect(runSeed(root, [{ name: 'toy-alpha', path: v2 }]).ok).toBe(true)
    const v1 = writeTempPackage(root, {
      identity: 'toy-alpha',
      dir: 'toy-alpha-v1',
      ...IMPL_DECL,
      serviceConfig: { callValue: { version: 'v1' } },
    })
    expect(runSeed(root, [{ name: 'toy-alpha', path: v1 }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile())
    const v2Gen = anchor.world.ids['toy-alpha'].gens[0].payload

    // plan：先 write set_active 到 v2，再 eval 一条 eff（下一轮）；若换代未在轮间落地，eff 会 not_loaded
    const planTerm: Json = [
      'c',
      {
        $directives: [
          {
            kind: 'write',
            request: { op: 'set_active', args: { id: 'toy-alpha', active: v2Gen } },
          },
          { kind: 'eval', entry: { $ref: 'terms/eff.json' } },
        ],
      },
    ]
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      dir: 'toy-caller-plan',
      pins: { 'toy.alpha': 'toy-alpha' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [{ name: 'toy-caller.plan', entry: 'terms/plan.json' }],
      terms: {
        'plan.json': JSON.stringify(planTerm),
        'eff.json': JSON.stringify(RUN_TERM),
      },
    })
    expect(runSeed(root, [{ name: 'toy-caller', path: caller }]).ok).toBe(true)

    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.plan')
      expect(result.status).toBe('done')
      expect(result.observations.map((o) => (o as { kind: string }).kind)).toEqual([
        'eval',
        'write',
        'eval',
      ])
      // 后续 eval 的 eff 回灌值来自 v2 服务（换代在轮间已落地、端点已挂新 gen）
      expect(lastAuditResult(readJournal(journalFile()))).toMatchObject({
        ok: true,
        value: { version: 'v2' },
      })
      expect((await client.status()).world_head.seq).toBeGreaterThan(anchor.head.seq)
    } finally {
      client.close()
    }
    expect(verifyFull(readJournal(journalFile())).ok).toBe(true)
  }, 30000)

  it('依赖换代不重装发出者：caller 世代不动、无隔离记录；路由重解析到新 active（记 dep.drift）', async () => {
    const v2 = writeTempPackage(root, {
      identity: 'toy-alpha',
      dir: 'toy-alpha-v2',
      ...IMPL_DECL,
      serviceConfig: { callValue: { version: 'v2' } },
      files: { 'execute/version.js': '// v2\n' },
    })
    expect(runSeed(root, [{ name: 'toy-alpha', path: v2 }]).ok).toBe(true)
    const v1 = writeTempPackage(root, {
      identity: 'toy-alpha',
      dir: 'toy-alpha-v1',
      ...IMPL_DECL,
      serviceConfig: { callValue: { version: 'v1' } },
    })
    expect(runSeed(root, [{ name: 'toy-alpha', path: v1 }]).ok).toBe(true)
    // 发出者（caller）带自己的服务：启动时把 pid 写进物化目录，供「进程不动」取证
    const callerPkg = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.alpha': 'toy-alpha' },
      start: 'node execute/main.js',
      members: [
        { kind: 'execute', path: 'execute/' },
        { kind: 'term', path: 'terms/' },
      ],
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
      terms: { 'run.json': JSON.stringify(RUN_TERM) },
      files: {
        'execute/main.js': `require('node:fs').writeFileSync('caller.pid', String(process.pid))\n${FIXTURE_SERVICE_MAIN}`,
      },
    })
    expect(runSeed(root, [{ name: 'toy-caller', path: callerPkg }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile())
    const v2Gen = anchor.world.ids['toy-alpha'].gens[0].payload
    const callerGen = anchor.world.ids['toy-caller'].active as Hash
    const callerPidFile = join(hostPaths(root).materializedDir, callerGen, 'caller.pid')

    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-caller.run')).status).toBe('done')
      expect(lastAuditResult(readJournal(journalFile()))).toMatchObject({
        ok: true,
        value: { version: 'v1' },
      })
      await waitFor(() => {
        try {
          return readFileSync(callerPidFile, 'utf8').length > 0
        } catch {
          return false
        }
      }, 'caller 服务启动并写 pid')
      const callerPid = readFileSync(callerPidFile, 'utf8')

      const swap = await client.submit([
        writeDirective('dep-to-v2', 'set_active', { id: 'toy-alpha', active: v2Gen }),
      ])
      expect(swap.status).toBe('done')
      expect((await client.command('toy-caller.run')).status).toBe('done')
      expect(lastAuditResult(readJournal(journalFile()))).toMatchObject({
        ok: true,
        value: { version: 'v2' },
      })

      // 发出者（caller）自身不动：进程未重启（pid 文件不变）、无 dep.stale / dep.retired、世代仍是原 payload
      expect(readFileSync(callerPidFile, 'utf8')).toBe(callerPid)
      expect(isPidAlive(Number.parseInt(callerPid, 10))).toBe(true)
      const records = readLifecycle(lifecycleFile())
      expect(
        records.some((r) => r.kind === 'dep' && r.impl === 'toy-caller' && r.event !== 'drift'),
      ).toBe(false)
      expect((await client.status()).loaded).toContainEqual({
        id: 'toy-caller',
        gen: callerGen,
      })
      // pin 哈希 ≠ 依赖 active：一条去重的漂移证据
      expect(
        records.filter(
          (r) =>
            r.kind === 'dep' && r.event === 'drift' && r.impl === 'toy-caller' && r.gen === v2Gen,
        ),
      ).toHaveLength(1)
    } finally {
      client.close()
    }
  }, 30000)

  it('依赖退役：运行期 fail-closed 隔离发出者；后续调用 stale 不回落；dep.retired 落运维日志', async () => {
    expect(
      runSeed(root, [
        { name: 'toy-alpha', path: FIXTURE_ALPHA },
        { name: 'toy-caller', path: writeCaller({ 'toy.alpha': 'toy-alpha' }) },
      ]).ok,
    ).toBe(true)
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-caller.run')).status).toBe('done')
      const servicePid = lastServicePid()

      const retired = await client.submit([
        writeDirective('retire-alpha', 'retire', { id: 'toy-alpha' }),
      ])
      expect(retired.status).toBe('done')
      // 退役：依赖者（caller）随之隔离，两者都从 loaded 消失；服务进程退出
      expect((await client.status()).loaded).toEqual([])
      await waitFor(() => !isPidAlive(servicePid), '退役后服务进程退出', 8000)
      const records = readLifecycle(lifecycleFile())
      expect(records).toContainEqual(
        expect.objectContaining({ kind: 'dep', event: 'retired', impl: 'toy-alpha' }),
      )
      expect(records).toContainEqual(
        expect.objectContaining({ kind: 'dep', event: 'retired', impl: 'toy-caller' }),
      )

      // 后续调用：路由 stale（绝不回落旧世代），审计照落、业务不落
      const before = readJournal(journalFile()).length
      const stale = await client.command('toy-caller.run')
      expect(stale.status).toBe('refused')
      expect(stale.observations[stale.observations.length - 1]).toMatchObject({
        kind: 'refused',
        reasons: ['eff_error'],
      })
      const entries = readJournal(journalFile())
      expect(entries).toHaveLength(before + 1)
      expect(lastAuditResult(entries)).toEqual({ ok: false, error: 'stale' })
    } finally {
      client.close()
    }
    // 停机后链仍可校验（退役写已全部落链）
    await handles[handles.length - 1].stop()
    expect(runVerify(root).ok).toBe(true)
  }, 30000)

  it('双写者被拒：宿主在跑时第二个 startHost / verify / replay 均 writer_busy；停机后恢复', async () => {
    expect(runSeed(root, [{ name: 'toy-alpha', path: FIXTURE_ALPHA }]).ok).toBe(true)
    const host = await start()
    expect(host.root).toBe(root)
    await expect(startHost({ root })).rejects.toThrow('writer_busy')
    expect(() => runVerify(root)).toThrow('writer_busy')
    expect(() => runReplay(root)).toThrow('writer_busy')
    await host.stop()
    expect(runVerify(root).ok).toBe(true)
  }, 15000)
})
