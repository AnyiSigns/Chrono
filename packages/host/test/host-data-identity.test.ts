// G7 验收：数据身份的存放与读取（A1「同身份混合世代」）。
// ① 数据世代写入：不判 dep.stale、不隔离、不动服务；投影 `body` = 数据；
// ② 包未变再 seed → unchanged，active 与数据都不变（重启后仍可读）；
// ③ 数据世代存在时新代码世代：数据仍可见、服务按代码路径换代（旧 pid 退出 / 新 pid 生效）；
// ④ compact / verify / replay / loadAnchor 往返后以上语义不变。

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runCompact, runReplay, runSeed, runVerify } from '../offline.ts'
import { loadAnchor, readJournal, verifyFull } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { projectBaseOnly } from '../projection/index.ts'
import { H, worldRev } from '../../kernel/index.ts'
import type { Directive, Entry, Hash, Json, Op, World } from '../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot, createToyPlugin } from './test-helpers.ts'
import {
  FIXTURE_ALPHA,
  isPidAlive,
  readLifecycle,
  waitFor,
  writeTempPackage,
} from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

/** 命令入口：发一条 eff（审计留痕，回值带服务 pid）。 */
const RUN_TERM: Json = ['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]

const DATA_BODY: Json = { hello: 'data' }

type Projection = { ids: { [id: string]: { active: Hash | null; body: Json | null } } }

describe('G7 数据身份的存放与读取（A1 同身份混合世代）', () => {
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

  async function start(): Promise<HostHandle> {
    const handle = await startHost({ root })
    handles.push(handle)
    return handle
  }

  /** 纯数据包（createToyPlugin 的 toy）+ 读投影 body 的 reader（无服务）。 */
  function seedDataWorld(): void {
    createToyPlugin(root)
    const reader = writeTempPackage(root, {
      identity: 'toy-reader',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [{ name: 'toy-reader.body', entry: 'terms/body.json' }],
      terms: { 'body.json': JSON.stringify(['g', ['ids', 'toy', 'body']]) },
    })
    const report = runSeed(root, [
      { name: 'toy', path: join(root, 'pkg', 'toy') },
      { name: 'toy-reader', path: reader },
    ])
    expect(report.ok).toBe(true)
  }

  /** 客户端写数据：put(data) + add_gen(payload/sig = 该 def, pins={})（同一条原子 batch）。 */
  async function writeData(
    client: Awaited<ReturnType<typeof connect>>,
    id: string,
    body: Json,
    expectPos: Hash | null,
  ): Promise<Hash> {
    const dataDef = { body }
    const dataHash = H(dataDef as unknown as Json)
    const result = await client.submit([
      {
        kind: 'write',
        request: {
          id: `data-${randomUUID()}`,
          op: 'batch',
          target: { expect_pos: expectPos },
          args: {
            ops: [
              { op: 'put', args: dataDef },
              { op: 'add_gen', args: { id, payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
          by: 'client',
        },
      },
    ])
    expect(result.status).toBe('done')
    return dataHash
  }

  function noStale(): boolean {
    return readLifecycle(lifecycleFile()).some((r) => r.kind === 'dep' && r.event === 'stale')
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

  /** 末条审计 entry 的 result（取服务 pid 用）。 */
  function lastAuditResult(entries: Entry[]): Json | null {
    for (let i = entries.length - 1; i >= 0; i--) {
      const body = (entries[i].args as { body?: { request?: Json; result?: Json } }).body
      if (body?.request !== undefined) return body.result ?? null
    }
    return null
  }

  function lastServicePid(): number {
    const result = lastAuditResult(readJournal(journalFile())) as {
      value?: { pid?: number }
    } | null
    const pid = result?.value?.pid
    expect(typeof pid).toBe('number')
    return pid as number
  }

  /** 造一个 execute 内容变化的新 tree / commit（代码换代）。 */
  function craftNewCodeCommit(world: World, genHash: Hash): { ops: Json[]; commitHash: Hash } {
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
    const mainBody = world.defs[mainEntry.hash].body as string
    const blob = { body: `${mainBody}\n// v2\n` }
    const blobHash = H(blob as unknown as Json)
    const execTree = { body: { entries: [{ name: 'main.js', mode: 'file', hash: blobHash }] } }
    const execTreeHash = H(execTree as unknown as Json)
    const newRootEntries = rootEntries.map((e) =>
      (e as { name?: string }).name === 'execute' ? { ...(e as object), hash: execTreeHash } : e,
    )
    const rootTree = { body: { entries: newRootEntries } }
    const rootTreeHash = H(rootTree as unknown as Json)
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
      commitHash: H(commitArgs),
    }
  }

  it('① seed 纯数据包 → 客户端写数据：提交 done、无 dep.stale、仍装载、投影 body = 数据', async () => {
    seedDataWorld()
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const head = (await client.status()).world_head
      await writeData(client, 'toy', DATA_BODY, head.hash)

      expect((await client.status()).loaded.some((x) => x.id === 'toy')).toBe(true)
      expect(noStale()).toBe(false)

      const body = await client.command('toy-reader.body')
      expect(body.status).toBe('done')
      expect((body.observations[0] as { value: Json }).value).toEqual(DATA_BODY)
    } finally {
      client.close()
    }
  })

  it('② 包未变再 seed → unchanged，active 与数据都不变（重启后仍可读）', async () => {
    seedDataWorld()
    const handle = await start()
    const client = await connect({ root, timeoutMs: 3000 })
    let dataHash: Hash
    try {
      const head = (await client.status()).world_head
      dataHash = await writeData(client, 'toy', DATA_BODY, head.hash)
    } finally {
      client.close()
    }
    await handle.stop()

    const before = loadAnchor(journalFile())
    expect(before.world.ids['toy'].active).toBe(dataHash)
    const report = runSeed(root, [{ name: 'toy', path: join(root, 'pkg', 'toy') }])
    expect(report.items[0].status).toBe('unchanged')

    const after = loadAnchor(journalFile())
    expect(after.world.ids['toy'].active).toBe(dataHash)
    expect(after.head).toEqual(before.head)
    expect(
      (projectBaseOnly(after.world, after.head) as unknown as Projection).ids['toy'].body,
    ).toEqual(DATA_BODY)

    // 重启宿主：数据身份仍装载、body 仍是数据（active 仍指数据世代）
    await start()
    const client2 = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client2.status()).loaded.some((x) => x.id === 'toy')).toBe(true)
      const body = await client2.command('toy-reader.body')
      expect((body.observations[0] as { value: Json }).value).toEqual(DATA_BODY)
    } finally {
      client2.close()
    }
  })

  it('③ 数据世代存在时新代码世代：数据仍可见、服务按代码路径换代（旧 pid 退出 / 新 pid 生效）', async () => {
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.alpha': 'toy-alpha' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
      terms: { 'run.json': JSON.stringify(RUN_TERM) },
    })
    const reader = writeTempPackage(root, {
      identity: 'toy-reader',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [{ name: 'toy-reader.body', entry: 'terms/body.json' }],
      terms: { 'body.json': JSON.stringify(['g', ['ids', 'toy-alpha', 'body']]) },
    })
    expect(
      runSeed(root, [
        { name: 'toy-alpha', path: FIXTURE_ALPHA },
        { name: 'toy-caller', path: caller },
        { name: 'toy-reader', path: reader },
      ]).ok,
    ).toBe(true)

    const anchor = loadAnchor(journalFile())
    const codeGen1 = anchor.world.ids['toy-alpha'].active as Hash
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    let pid1 = 0
    try {
      expect((await client.command('toy-caller.run')).status).toBe('done')
      pid1 = lastServicePid()

      // 写数据：active 移到数据世代；服务不动、无隔离
      const head = (await client.status()).world_head
      await writeData(client, 'toy-alpha', { hello: 'mixed' }, head.hash)
      expect((await client.status()).loaded.some((x) => x.id === 'toy-alpha')).toBe(true)
      expect(noStale()).toBe(false)

      // 新代码世代：execute 内容变化 → 起新服务、旧服务 drain
      const code = craftNewCodeCommit(anchor.world, codeGen1)
      const applied = await client.submit([addGenBatch('toy-alpha', code.ops, code.commitHash)])
      expect(applied.status).toBe('done')
      await waitFor(() => !isPidAlive(pid1), '旧服务进程退出', 8000)
      expect((await client.command('toy-caller.run')).status).toBe('done')
      const pid2 = lastServicePid()
      expect(pid2).not.toBe(pid1)
      expect(isPidAlive(pid2)).toBe(true)
      expect((await client.status()).loaded).toContainEqual({
        id: 'toy-alpha',
        gen: code.commitHash,
      })
      expect(noStale()).toBe(false)

      // 数据仍可见（投影 body = 最近数据世代）
      const body = await client.command('toy-reader.body')
      expect(body.status).toBe('done')
      expect((body.observations[0] as { value: Json }).value).toEqual({ hello: 'mixed' })
    } finally {
      client.close()
    }
    expect(verifyFull(readJournal(journalFile())).ok).toBe(true)
  }, 30000)

  it('④ compact / verify / replay / loadAnchor 往返后数据与代码世代语义不变', async () => {
    seedDataWorld()
    const handle = await start()
    const client = await connect({ root, timeoutMs: 3000 })
    let dataHash: Hash
    try {
      const head = (await client.status()).world_head
      dataHash = await writeData(client, 'toy', DATA_BODY, head.hash)
    } finally {
      client.close()
    }
    await handle.stop()

    const compacted = runCompact(root)
    expect(compacted.snapshot.seq).toBeGreaterThan(0)
    expect(runVerify(root).ok).toBe(true)
    const replayed = runReplay(root)

    const anchor = loadAnchor(journalFile())
    expect(anchor.world.ids['toy'].active).toBe(dataHash)
    expect(replayed.worldRev).toBe(worldRev(anchor.world))
    expect(
      (projectBaseOnly(anchor.world, anchor.head) as unknown as Projection).ids['toy'].body,
    ).toEqual(DATA_BODY)

    // 压缩后重启宿主：仍装载、body 仍是数据
    await start()
    const client2 = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client2.status()).loaded.some((x) => x.id === 'toy')).toBe(true)
      const body = await client2.command('toy-reader.body')
      expect((body.observations[0] as { value: Json }).value).toEqual(DATA_BODY)
    } finally {
      client2.close()
    }
  })
})
