// 换代换人序测试：声明独占资源的插件先 drain 旧再起新，缺省插件保持零空窗重叠序。
// 直接打 startAssembly（不经入站面）：世界推进用内核 commit 在独占副本上构造。
// 独占序把不占资源的准备阶段（物化 / 构建）提前到 drain 之前：注入 `restore`（构建钩子）读旧进程是否还活着——
// 重叠序与独占序下构建时旧进程都仍在跑；两序的分界移到 spawn 阶段（由 swap.test.ts 的调用序单测机械固化）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { startAssembly } from '../runtime.ts'
import type { AssemblyRuntimeHandle, StartAssemblyOptions } from '../runtime.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { commit, cloneWorld } from '../../../kernel/index.ts'
import type { Gen, Hash, Head, Json, World } from '../../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import {
  FIXTURE_SERVICE_MAIN,
  isPidAlive,
  waitFor,
  waitForQuiescence,
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

function genOf(world: World, id: string, index: number): Gen {
  const gen = world.ids[id].gens[index]
  expect(gen).toBeDefined()
  return gen
}

const BASE = {
  implements: ['toy.gen'],
  methods: { 'toy.gen': ['echo'] },
  start: 'node execute/main.js',
  members: [{ kind: 'execute', path: 'execute/' }],
}

describe('换代换人序（独占资源声明）', () => {
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

  /** 在独占世界副本上应用一条写并返回新世界（供 applyWorld 用）。 */
  function step(world: World, head: Head, op: 'set_active' | 'retire', args: Json): World {
    const next = cloneWorld(world)
    const outcome = commit(
      head,
      next,
      { id: `t-${op}`, op, target: { expect_pos: head.hash }, args, by: 'test' },
      Date.now(),
    )
    expect(outcome.verdict.ok).toBe(true)
    return next
  }

  /** 两代同身份且 execute 内容不同（判据 code）：先 seed v2、后 seed v1 ⇒ v1 active、v2 在案。 */
  function seedTwoGens(
    identity: string,
    v2: Record<string, unknown>,
    v1: Record<string, unknown>,
  ): { world: World; head: Head; v1: Hash; v2: Hash } {
    const v2Root = writeTempPackage(root, {
      identity,
      dir: `${identity}-v2`,
      ...BASE,
      files: { 'execute/extra.js': '// v2\n' },
      ...v2,
    })
    expect(runSeed(root, [{ name: identity, path: v2Root }]).ok).toBe(true)
    const v1Root = writeTempPackage(root, { identity, dir: `${identity}-v1`, ...BASE, ...v1 })
    expect(runSeed(root, [{ name: identity, path: v1Root }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    const gens = anchor.world.ids[identity].gens
    expect(gens).toHaveLength(2)
    return {
      world: anchor.world,
      head: anchor.head,
      v1: anchor.world.ids[identity].active as Hash,
      v2: gens[0].payload,
    }
  }

  async function startWorld(
    world: World,
    opts: Partial<StartAssemblyOptions> = {},
  ): Promise<AssemblyRuntimeHandle> {
    const handle = await startAssembly({ root, world, log, ...opts })
    handles.push(handle)
    return handle
  }

  function serviceStops(impl: string): LifeRecord[] {
    return records.filter((r) => r.kind === 'service' && r.event === 'exit' && r.impl === impl)
  }

  it('声明独占资源 → 准备（构建）提前到旧实例仍在服务时，完成后才 drain 并 spawn', async () => {
    const identity = 'toy-excl'
    const { world, head, v1, v2 } = seedTwoGens(
      identity,
      { exclusive: ['port'] },
      { exclusive: ['port'] },
    )
    let oldPid = -1
    let oldAliveAtPrepare: boolean | null = null
    const restore = async (cwd: string): Promise<void> => {
      if (cwd.endsWith(v2)) oldAliveAtPrepare = isPidAlive(oldPid)
    }
    const handle = await startWorld(world, { restore })
    oldPid = handle.endpoints.get(identity, v1, 'toy.gen', 'echo')!.pid
    expect(isPidAlive(oldPid)).toBe(true)

    await handle.applyWorld(step(world, head, 'set_active', { id: identity, active: v2 }))

    // 构建不占独占资源：准备阶段旧进程仍在服务；drain 与 spawn 的先后由 swap.test.ts 的调用序单测固化
    expect(oldAliveAtPrepare).toBe(true)
    await waitFor(() => !isPidAlive(oldPid), '旧服务 drain 后退出', 5000)
    const row = handle.endpoints.get(identity, v2, 'toy.gen', 'echo')
    expect(row).not.toBeNull()
    expect(isPidAlive(row!.pid)).toBe(true)
    expect(handle.endpoints.get(identity, v1, 'toy.gen', 'echo')).toBeNull()
    // 旧服务退出记账不变：恰一条 service.exit，reason=superseded
    expect(serviceStops(identity)).toHaveLength(1)
    expect(serviceStops(identity)[0].reason).toBe('superseded')
    expect(handle.loaded()).toContainEqual({ id: identity, gen: v2, service: true })
  }, 15000)

  it('缺省（无独占声明）→ 保持先起新后 drain：新世代构建时旧进程仍在跑', async () => {
    const identity = 'toy-overlap'
    const { world, head, v1, v2 } = seedTwoGens(identity, {}, {})
    let oldPid = -1
    let oldAliveAtBuild: boolean | null = null
    const restore = async (cwd: string): Promise<void> => {
      if (cwd.endsWith(v2)) oldAliveAtBuild = isPidAlive(oldPid)
    }
    const handle = await startWorld(world, { restore })
    oldPid = handle.endpoints.get(identity, v1, 'toy.gen', 'echo')!.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: identity, active: v2 }))

    // 重叠序：新服务在旧服务仍活着时构建并起好，端点切新后才 drain 旧
    expect(oldAliveAtBuild).toBe(true)
    expect(handle.endpoints.get(identity, v2, 'toy.gen', 'echo')).not.toBeNull()
    await waitFor(() => !isPidAlive(oldPid), '旧服务随后被 drain', 5000)
    expect(serviceStops(identity)[0].reason).toBe('superseded')
  }, 15000)

  it('独占序下准备阶段失败：旧实例仍在服务，端点换新世代键，不 drain 不重试', async () => {
    const identity = 'toy-exclprep'
    const { world, head, v1, v2 } = seedTwoGens(
      identity,
      { exclusive: ['port'] },
      { exclusive: ['port'] },
    )
    const restore = async (cwd: string): Promise<void> => {
      if (cwd.endsWith(v2)) throw new Error('transient build failure')
    }
    const handle = await startWorld(world, { restore })
    const oldPid = handle.endpoints.get(identity, v1, 'toy.gen', 'echo')!.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: identity, active: v2 }))

    // 新世代未激活、旧实例未退场：端点行换到新世代键，仍指向旧进程
    expect(isPidAlive(oldPid)).toBe(true)
    const row = handle.endpoints.get(identity, v2, 'toy.gen', 'echo')
    expect(row).not.toBeNull()
    expect(row!.pid).toBe(oldPid)
    expect(handle.endpoints.get(identity, v1, 'toy.gen', 'echo')).toBeNull()
    expect(handle.loaded()).toContainEqual({ id: identity, gen: v2, service: true })
    // 未 drain：无 service.exit；未转重试：无 restart_exhausted
    expect(serviceStops(identity)).toHaveLength(0)
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'start_failed',
        impl: identity,
        gen: v2,
        reason: 'deps_failed',
      }),
    )
    expect(records.some((r) => r.event === 'restart_exhausted')).toBe(false)
  }, 15000)

  it('独占序下 spawn 阶段瞬时失败：无服务但保留世代，按 restart 重试新世代成功', async () => {
    const identity = 'toy-exclretry'
    const restart = {
      policy: 'on-exit',
      backoff: 'fixed',
      backoff_ms: 600,
      max: 3,
      window_ms: 60000,
      drain_ms: 200,
    }
    // v2 首次 spawn 写标记并退出 1（spawn 阶段瞬时失败），重试时标记已在则正常握手。
    // 用 IIFE 隔离变量名：fixture 服务脚本自身也声明 fs / path，顶层重复声明会直接语法错。
    const spawnFailOnce = [
      ';(() => {',
      "  const fs = require('node:fs');",
      "  const path = require('node:path');",
      "  const marker = path.join(process.env.CHRONO_PLUGIN_STATE, 'spawn-failed-once');",
      "  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(1); }",
      '})();',
      '',
    ].join('\n')
    const { world, head, v1, v2 } = seedTwoGens(
      identity,
      {
        exclusive: ['port'],
        restart,
        files: { 'execute/main.js': spawnFailOnce + FIXTURE_SERVICE_MAIN },
      },
      { exclusive: ['port'], restart },
    )
    const handle = await startWorld(world)
    const oldPid = handle.endpoints.get(identity, v1, 'toy.gen', 'echo')!.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: identity, active: v2 }))

    // 旧服务已 drain（不复活）：该身份转入「无服务但保留世代」，端点缺席
    expect(isPidAlive(oldPid)).toBe(false)
    expect(
      records.some(
        (r) =>
          r.kind === 'service' &&
          r.event === 'start_failed' &&
          r.impl === identity &&
          r.gen === v2 &&
          (r.reason === 'closed' || r.reason?.startsWith('exited')),
      ),
    ).toBe(true)
    expect(handle.loaded()).toContainEqual({ id: identity, gen: v2, service: false })
    expect(handle.endpoints.get(identity, v2, 'toy.gen', 'echo')).toBeNull()
    expect(handle.endpoints.get(identity, v1, 'toy.gen', 'echo')).toBeNull()

    // 退避到点后按新世代重试并成功：端点重挂、身份回到有服务
    await waitFor(
      () => {
        const row = handle.endpoints.get(identity, v2, 'toy.gen', 'echo')
        return row !== null && isPidAlive(row.pid)
      },
      '重试后新世代端点重挂',
      8000,
    )
    expect(handle.loaded()).toContainEqual({ id: identity, gen: v2, service: true })
  }, 15000)

  it('独占序下 spawn 阶段持续失败：重试超限 → restart_exhausted + 分支隔离', async () => {
    const identity = 'toy-exclfail'
    const restart = {
      policy: 'on-exit',
      backoff: 'none',
      max: 2,
      window_ms: 60000,
      drain_ms: 200,
    }
    const { world, head, v1, v2 } = seedTwoGens(
      identity,
      { exclusive: ['port'], restart, start: 'node execute/missing-service.js' },
      { exclusive: ['port'], restart },
    )
    const handle = await startWorld(world)
    const oldPid = handle.endpoints.get(identity, v1, 'toy.gen', 'echo')!.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: identity, active: v2 }))

    await waitFor(
      () =>
        records.some(
          (r) => r.kind === 'service' && r.event === 'restart_exhausted' && r.impl === identity,
        ),
      '独占序重试超限',
      8000,
    )
    await waitForQuiescence(() => records, '独占序失败分支隔离落地')
    expect(isPidAlive(oldPid)).toBe(false)
    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toHaveLength(0)
    // 旧服务只退场一次（superseded），不因新世代失败被复活
    expect(serviceStops(identity)).toHaveLength(1)
    expect(serviceStops(identity)[0].reason).toBe('superseded')
  }, 15000)
})
