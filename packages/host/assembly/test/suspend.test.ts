// 运行期休眠 / 恢复（assembly 层）：停服务、摘端点、保留 loaded 与能力索引；不连坐依赖者；
// applyWorld 对休眠身份跳过换代启动，仅显式 resume 按其当前代码世代重启。
// 直接打 startAssembly（不经入站面）：世界推进用内核 commit 在独占副本上构造。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { startAssembly } from '../runtime.ts'
import type { AssemblyRuntimeHandle, StartAssemblyOptions } from '../runtime.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { cloneWorld, commit } from '../../../kernel/index.ts'
import type { Hash, Head, World } from '../../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import {
  FIXTURE_ALPHA,
  FIXTURE_BETA,
  isPidAlive,
  killProcessTree,
  waitFor,
  writeTempPackage,
} from '../../test/test-helpers-ext.ts'

type LifeRecord = {
  kind: string
  event: string
  impl?: string
  gen?: string
  reason?: string
}

function journalFile(root: string): string {
  return join(root, 'state', 'world', 'journal.jsonl')
}

describe('运行期休眠 / 恢复', () => {
  let root: string
  let records: LifeRecord[] = []
  const handles: AssemblyRuntimeHandle[] = []

  beforeEach(() => {
    root = createTempRoot()
    records = []
    handles.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      const pids = handle.endpoints.list().map((row) => row.pid)
      try {
        await handle.stop()
      } catch {
        // 尽力停机
      }
      for (const pid of pids) {
        await waitFor(() => !isPidAlive(pid), `停机后进程退出 pid=${pid}`, 3000).catch(() => {})
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  const log = (record: LifeRecord): void => {
    records.push(record)
  }

  async function startWorld(
    entries: Array<{ name: string; path?: string }>,
    opts: Partial<StartAssemblyOptions> = {},
  ): Promise<{ handle: AssemblyRuntimeHandle; world: World }> {
    const report = runSeed(root, entries)
    expect(report.ok).toBe(true)
    const world = loadAnchor(journalFile(root)).world
    const handle = await startAssembly({ root, world, log, ...opts })
    handles.push(handle)
    return { handle, world }
  }

  function setActive(world: World, head: Head, id: string, active: Hash): World {
    const next = cloneWorld(world)
    const outcome = commit(
      head,
      next,
      {
        id: `t-${id}`,
        op: 'set_active',
        target: { expect_pos: head.hash },
        args: { id, active },
        by: 'test',
      },
      Date.now(),
    )
    expect(outcome.verdict.ok).toBe(true)
    return next
  }

  it('休眠：停服务、摘端点、保留 loaded 与能力索引；不连坐显式 pins 依赖者', async () => {
    const { handle, world } = await startWorld([
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
    ])
    const alphaGen = world.ids['toy-alpha'].active as Hash
    const betaGen = world.ids['toy-beta'].active as Hash
    expect(handle.endpoints.get('toy-alpha', alphaGen, 'toy.alpha', 'echo')).not.toBeNull()

    expect(await handle.suspend('toy-alpha')).toEqual({ ok: true })
    expect(handle.suspendedIds().has('toy-alpha')).toBe(true)
    // 仍入 loaded（service:false），能力索引不变——休眠 = 保留索引的运行期隔离
    const loaded = handle.loaded()
    expect(loaded.find((entry) => entry.id === 'toy-alpha')?.service).toBe(false)
    expect(handle.endpoints.get('toy-alpha', alphaGen, 'toy.alpha', 'echo')).toBeNull()
    // 显式 pins 依赖者（toy-beta pins toy-alpha）不被连坐
    expect(loaded.find((entry) => entry.id === 'toy-beta')?.service).toBe(true)
    expect(handle.endpoints.get('toy-beta', betaGen, 'toy.beta', 'echo')).not.toBeNull()
    expect(
      records.some(
        (record) =>
          record.kind === 'dep' && record.event === 'suspended' && record.impl === 'toy-alpha',
      ),
    ).toBe(true)

    expect(await handle.resume('toy-alpha')).toEqual({ ok: true })
    expect(handle.suspendedIds().has('toy-alpha')).toBe(false)
    expect(handle.loaded().find((entry) => entry.id === 'toy-alpha')?.service).toBe(true)
    expect(handle.endpoints.get('toy-alpha', alphaGen, 'toy.alpha', 'echo')).not.toBeNull()
    expect(
      records.some(
        (record) =>
          record.kind === 'dep' && record.event === 'resumed' && record.impl === 'toy-alpha',
      ),
    ).toBe(true)
  }, 20000)

  it('幂等与 not_found：未知 / 已休眠 / 数据身份', async () => {
    const dataRoot = writeTempPackage(root, { identity: 'toy-data' })
    const { handle } = await startWorld([
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-data', path: dataRoot },
    ])

    expect(await handle.suspend('ghost')).toEqual({ ok: false, code: 'not_found' })
    expect(await handle.resume('ghost')).toEqual({ ok: false, code: 'not_found' })

    expect(await handle.suspend('toy-alpha')).toEqual({ ok: true })
    expect(await handle.suspend('toy-alpha')).toEqual({ ok: true })
    expect(await handle.resume('toy-alpha')).toEqual({ ok: true })
    expect(await handle.resume('toy-alpha')).toEqual({ ok: true })

    // 数据身份无服务：休眠 / 恢复幂等且不炸
    expect(await handle.suspend('toy-data')).toEqual({ ok: true })
    expect(await handle.resume('toy-data')).toEqual({ ok: true })
  }, 20000)

  it('休眠不因换代自动恢复；resume 按当前代码世代重启', async () => {
    // 两代同身份：先 seed v2、后 seed v1 ⇒ v1 active、v2 历史世代在案
    const v2 = writeTempPackage(root, {
      identity: 'toy-gen',
      dir: 'toy-gen-v2',
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
      start: 'node execute/main.js',
    })
    expect(runSeed(root, [{ name: 'toy-gen', path: v2 }]).ok).toBe(true)
    const v1 = writeTempPackage(root, {
      identity: 'toy-gen',
      dir: 'toy-gen-v1',
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
      start: 'node execute/main.js',
      files: { 'execute/extra.js': '// v1\n' },
    })
    expect(runSeed(root, [{ name: 'toy-gen', path: v1 }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    const gens = anchor.world.ids['toy-gen'].gens
    expect(gens).toHaveLength(2)
    const v2Gen = gens[0].payload
    const v1Gen = gens[1].payload

    const handle = await startAssembly({ root, world: anchor.world, log })
    handles.push(handle)
    expect(handle.endpoints.get('toy-gen', v1Gen, 'toy.gen', 'echo')).not.toBeNull()

    await handle.suspend('toy-gen')
    await handle.applyWorld(setActive(anchor.world, anchor.head, 'toy-gen', v2Gen))
    // 换代被跳过：仍休眠、无服务、新世代无端点
    expect(handle.suspendedIds().has('toy-gen')).toBe(true)
    expect(handle.loaded().find((entry) => entry.id === 'toy-gen')?.service).toBe(false)
    expect(handle.endpoints.get('toy-gen', v2Gen, 'toy.gen', 'echo')).toBeNull()

    // resume 按其当前代码世代（v2）重启
    await handle.resume('toy-gen')
    expect(handle.suspendedIds().has('toy-gen')).toBe(false)
    expect(handle.endpoints.get('toy-gen', v2Gen, 'toy.gen', 'echo')).not.toBeNull()
  }, 20000)

  it('已隔离身份：resume / suspend 据实报 isolated，不静默报成功', async () => {
    const pkg = writeTempPackage(root, {
      identity: 'toy-bad',
      implements: ['toy.bad'],
      methods: { 'toy.bad': ['echo'] },
      start: 'node execute/main.js',
      serviceConfig: { manifest: { identity: 'toy-bad-wrong' } },
    })
    const { handle, world } = await startWorld([{ name: 'toy-bad', path: pkg }])
    const gen = world.ids['toy-bad'].active as Hash
    // 装配期握手失败 → 已隔离：不在 loaded、无端点
    expect(handle.loaded().some((entry) => entry.id === 'toy-bad')).toBe(false)
    expect(handle.endpoints.get('toy-bad', gen, 'toy.bad', 'echo')).toBeNull()

    expect(await handle.resume('toy-bad')).toEqual({ ok: false, code: 'isolated' })
    expect(await handle.suspend('toy-bad')).toEqual({ ok: false, code: 'isolated' })
    // 未被误标休眠，也未起服务 / 挂端点
    expect(handle.suspendedIds().has('toy-bad')).toBe(false)
    expect(handle.loaded().some((entry) => entry.id === 'toy-bad')).toBe(false)
  }, 20000)

  it('resume 起服务失败：据实报 isolated，不与「未休眠」的幂等成功混淆', async () => {
    const broken = writeTempPackage(root, {
      identity: 'toy-r',
      dir: 'toy-r-broken',
      implements: ['toy.r'],
      methods: { 'toy.r': ['echo'] },
      start: 'node execute/main.js',
      serviceConfig: { manifest: { identity: 'toy-r-wrong' } },
    })
    expect(runSeed(root, [{ name: 'toy-r', path: broken }]).ok).toBe(true)
    const ok = writeTempPackage(root, {
      identity: 'toy-r',
      dir: 'toy-r-ok',
      implements: ['toy.r'],
      methods: { 'toy.r': ['echo'] },
      start: 'node execute/main.js',
    })
    expect(runSeed(root, [{ name: 'toy-r', path: ok }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    const brokenGen = anchor.world.ids['toy-r'].gens[0].payload
    const okGen = anchor.world.ids['toy-r'].gens[1].payload
    expect(anchor.world.ids['toy-r'].active).toBe(okGen)

    const handle = await startAssembly({ root, world: anchor.world, log })
    handles.push(handle)
    expect(handle.endpoints.get('toy-r', okGen, 'toy.r', 'echo')).not.toBeNull()

    expect(await handle.suspend('toy-r')).toEqual({ ok: true })
    // 休眠跳过换代：世界 active 已指向坏世代，resume 按其当前代码世代（坏）重启 → 失败
    await handle.applyWorld(setActive(anchor.world, anchor.head, 'toy-r', brokenGen))
    expect(handle.suspendedIds().has('toy-r')).toBe(true)

    expect(await handle.resume('toy-r')).toEqual({ ok: false, code: 'isolated' })
    expect(handle.suspendedIds().has('toy-r')).toBe(false)
    expect(handle.loaded().some((entry) => entry.id === 'toy-r')).toBe(false)
    expect(handle.endpoints.list()).toEqual([])
  }, 20000)

  it('退避窗口内 suspend：进程不复活、端点不重挂', async () => {
    const pkg = writeTempPackage(root, {
      identity: 'toy-backoff',
      implements: ['toy.backoff'],
      methods: { 'toy.backoff': ['echo'] },
      start: 'node execute/main.js',
      restart: {
        policy: 'on-exit',
        backoff: 'fixed',
        backoff_ms: 300,
        max: 3,
        window_ms: 60000,
        drain_ms: 200,
      },
    })
    const { handle, world } = await startWorld([{ name: 'toy-backoff', path: pkg }])
    const gen = world.ids['toy-backoff'].active as Hash
    const row = handle.endpoints.get('toy-backoff', gen, 'toy.backoff', 'echo')
    expect(row).not.toBeNull()

    // 杀进程 → 进入退避重启窗口（300ms）；窗口内 suspend，排程不得复活它
    await killProcessTree(row!.pid)
    await waitFor(
      () =>
        records.some(
          (record) =>
            record.kind === 'service' && record.event === 'exit' && record.impl === 'toy-backoff',
        ),
      '退避重启排程已建立',
    )
    expect(await handle.suspend('toy-backoff')).toEqual({ ok: true })

    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(handle.endpoints.list()).toEqual([])
    expect(handle.loaded().find((entry) => entry.id === 'toy-backoff')?.service).toBe(false)
    expect(
      records.some(
        (record) =>
          record.kind === 'service' &&
          record.event === 'start_failed' &&
          record.impl === 'toy-backoff',
      ),
    ).toBe(false)
  }, 20000)

  it('stop 追踪在途启动：停机等待启动任务落定，无残留端点 / 已装载', async () => {
    let releases = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const restore = (): Promise<void> => {
      releases += 1
      // 首次装配正常；后续（resume 触发的在途启动）卡在门后，制造 stop × 在途 start
      return releases === 1 ? Promise.resolve() : gate
    }
    const { handle } = await startWorld([{ name: 'toy-alpha', path: FIXTURE_ALPHA }], { restore })
    expect(await handle.suspend('toy-alpha')).toEqual({ ok: true })

    const pending = handle.resume('toy-alpha')
    await waitFor(() => releases >= 2, 'resume 进入在途启动')

    let stopResolved = false
    const stopPromise = handle.stop().then(() => {
      stopResolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const waitedForStart = !stopResolved
    release()
    await stopPromise
    await pending

    expect(waitedForStart).toBe(true)
    expect(handle.endpoints.list()).toEqual([])
    expect(handle.loaded()).toEqual([])
  }, 20000)
})
