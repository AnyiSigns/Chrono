// 起服务阶段拆分单测：准备（物化 + 构建）与 spawn（起进程 + 握手）可分别调用、分别失败且分类正确；
// 准备产物 cwd 交给 spawn 复用，物化只发生一次。物化计数用透传桩（计算与原函数一致，仅累加）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const counters = vi.hoisted(() => ({ materialize: 0 }))

vi.mock('../materialize.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../materialize.ts')
  return {
    ...actual,
    materializeCommit: (...args: Parameters<typeof actual.materializeCommit>) => {
      counters.materialize += 1
      return actual.materializeCommit(...args)
    },
  }
})

import { launchService, prepareService, spawnService } from '../service-launcher.ts'
import type { PreparedService, ServiceLauncherDeps } from '../service-launcher.ts'
import { classifyStartFailure, stopChild, waitForExit } from '../supervision.ts'
import type { ServiceRuntime, StartFailure } from '../supervision.ts'
import { readPluginDecl } from '../decl.ts'
import type { PluginDecl } from '../decl.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Hash, World } from '../../../kernel/index.ts'

/** 拒绝后按宿主口径分类；未拒绝则测试失败。 */
async function classifyRejection(promise: Promise<unknown>): Promise<StartFailure> {
  let error: unknown
  try {
    await promise
  } catch (err) {
    error = err
  }
  expect(error).toBeDefined()
  return classifyStartFailure(error)
}

describe('起服务阶段拆分', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
    counters.materialize = 0
  })

  afterEach(() => cleanupTempRoot(root))

  function deps(world: World, overrides: Partial<ServiceLauncherDeps> = {}): ServiceLauncherDeps {
    return {
      world,
      materializedDir: hostPaths(root).materializedDir,
      blobsDir: hostPaths(root).blobsDir,
      handshakeTimeoutMs: 3000,
      onExtraDropped: () => {},
      onChannelClosed: () => {},
      onExit: () => {},
      ...overrides,
    }
  }

  function seedOne(identity: string): { world: World; gen: Hash; decl: PluginDecl } {
    const pkg = writeTempPackage(root, {
      identity,
      implements: ['toy.split'],
      methods: { 'toy.split': ['echo'] },
      start: 'node execute/main.js',
    })
    expect(runSeed(root, [{ name: identity, path: pkg }]).ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const read = readPluginDecl(world, identity, hostPaths(root).blobsDir)
    expect(read).not.toBeNull()
    return { world, gen: world.ids[identity].active as Hash, decl: read!.decl }
  }

  async function stopService(service: ServiceRuntime): Promise<void> {
    stopChild(service.proc, service.link)
    await waitForExit(service.proc, 2000)
  }

  it('一次性入口 launchService：准备 + spawn 只物化一次', async () => {
    const { world, gen, decl } = seedOne('toy-split')
    const service = await launchService(deps(world), 'toy-split', gen, decl)
    try {
      expect(counters.materialize).toBe(1)
      expect(service.pid).toBeGreaterThan(0)
    } finally {
      await stopService(service)
    }
  })

  it('拆分入口：准备一次物化，spawn 复用 cwd 不重复物化', async () => {
    const { world, gen, decl } = seedOne('toy-split')
    const prepared: PreparedService = await prepareService(deps(world), 'toy-split', gen, decl)
    expect(prepared.cwd.endsWith(gen)).toBe(true)
    expect(counters.materialize).toBe(1)

    const service = await spawnService(deps(world), 'toy-split', gen, decl, prepared)
    try {
      expect(counters.materialize).toBe(1)
      expect(service.pid).toBeGreaterThan(0)
    } finally {
      await stopService(service)
    }
  })

  it('准备阶段失败分类：物化失败 → materialize_failed', async () => {
    const { world, decl } = seedOne('toy-split')
    const missing = '0'.repeat(64) as Hash
    expect(await classifyRejection(prepareService(deps(world), 'toy-split', missing, decl))).toEqual({
      event: 'service',
      reason: 'materialize_failed',
    })
  })

  it('准备阶段失败分类：构建失败 → deps_failed', async () => {
    const { world, gen, decl } = seedOne('toy-split')
    const restore = async (): Promise<void> => {
      throw new Error('build exploded')
    }
    expect(await classifyRejection(prepareService(deps(world, { restore }), 'toy-split', gen, decl))).toEqual({
      event: 'service',
      reason: 'deps_failed',
    })
  })

  it('准备阶段失败分类：资产直拷失败 → deps_failed', async () => {
    const { world, gen, decl } = seedOne('toy-split')
    const copyAssets = (): void => {
      throw new Error('copy exploded')
    }
    expect(await classifyRejection(prepareService(deps(world, { copyAssets }), 'toy-split', gen, decl))).toEqual(
      {
        event: 'service',
        reason: 'deps_failed',
      },
    )
  })

  it('spawn 阶段失败分类：进程先死 → service 失败（closed / exited，准备成功也拦得住）', async () => {
    const { world, gen, decl } = seedOne('toy-split')
    const prepared = await prepareService(deps(world), 'toy-split', gen, decl)
    writeFileSync(join(prepared.cwd, 'fail.js'), 'process.exit(1)\n')
    const failDecl = { ...decl, start: 'node fail.js' } as PluginDecl
    const failure = await classifyRejection(
      spawnService(deps(world), 'toy-split', gen, failDecl, prepared),
    )
    // 进程先死时通道 close 与 exit 竞速，二者都归 spawn 阶段 service 失败（不是准备阶段的 deps_failed）
    expect(failure.event).toBe('service')
    if (failure.event === 'service') {
      expect(['closed', 'exited:1']).toContain(failure.reason)
    }
  })

  it('spawn 阶段失败分类：握手超时 → timeout', async () => {
    const { world, gen, decl } = seedOne('toy-split')
    const prepared = await prepareService(deps(world), 'toy-split', gen, decl)
    writeFileSync(join(prepared.cwd, 'hang.js'), 'setTimeout(() => {}, 60000)\n')
    const hangDecl = { ...decl, start: 'node hang.js' } as PluginDecl
    expect(
      await classifyRejection(
        spawnService(
          deps(world, { handshakeTimeoutMs: 300 }),
          'toy-split',
          gen,
          hangDecl,
          prepared,
        ),
      ),
    ).toEqual({ event: 'service', reason: 'timeout' })
  })
})
