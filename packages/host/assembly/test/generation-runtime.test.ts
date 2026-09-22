// S5 世代跟随（A6）运行时测试：applyWorld 后数据热生效 / 代码换服务 / 依赖退役隔离 / 新身份装载。
// 直接打 startAssembly（不经入站面）：世界推进用内核 commit 在独占副本上构造。

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

const BOTH_MEMBERS = [
  { kind: 'execute', path: 'execute/' },
  { kind: 'term', path: 'terms/' },
]

function journalFile(root: string): string {
  return join(root, 'state', 'world', 'journal.jsonl')
}

function genOf(world: World, id: string, index: number): Gen {
  const gen = world.ids[id].gens[index]
  expect(gen).toBeDefined()
  return gen
}

describe('S5 世代跟随 applyWorld（A6）', () => {
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

  /** 两代同身份：先 seed v2、后 seed v1 ⇒ v1 active、v2 历史世代在案。 */
  function seedTwoGens(identity: string, specV2: object, specV1: object): World {
    const v2 = writeTempPackage(root, { identity, dir: `${identity}-v2`, ...specV2 })
    expect(runSeed(root, [{ name: identity, path: v2 }]).ok).toBe(true)
    const v1 = writeTempPackage(root, { identity, dir: `${identity}-v1`, ...specV1 })
    expect(runSeed(root, [{ name: identity, path: v1 }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    expect(anchor.world.ids[identity].gens).toHaveLength(2)
    return anchor.world
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

  /**
   * 换代失败夹具：先 seed 坏世代、再 seed 好世代（好世代 active），最后 seed 依赖者。
   * 坏 / 好世代的 execute 成员内容不同 ⇒ 判据 code ⇒ 走换服务路径；坏点由 `brokenSpec` 给。
   */
  function seedSwapFailureFixture(brokenSpec: object): {
    world: World
    head: Head
    okGen: Hash
    brokenGen: Hash
  } {
    const base = {
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
      start: 'node execute/main.js',
      members: [{ kind: 'execute', path: 'execute/' }],
    }
    const { files, ...overrides } = brokenSpec as { files?: Record<string, string> }
    const broken = writeTempPackage(root, {
      identity: 'toy-gen',
      dir: 'toy-gen-broken',
      ...base,
      files: { 'execute/extra.js': '// broken\n', ...(files ?? {}) },
      ...overrides,
    })
    expect(runSeed(root, [{ name: 'toy-gen', path: broken }]).ok).toBe(true)
    const ok = writeTempPackage(root, { identity: 'toy-gen', dir: 'toy-gen-ok', ...base })
    expect(runSeed(root, [{ name: 'toy-gen', path: ok }]).ok).toBe(true)
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.gen': 'toy-gen' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'x.json': JSON.stringify(['c', 1]) },
    })
    expect(runSeed(root, [{ name: 'toy-caller', path: caller }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    const gens = anchor.world.ids['toy-gen'].gens
    expect(gens).toHaveLength(2)
    return {
      world: anchor.world,
      head: anchor.head,
      brokenGen: gens[0].payload,
      okGen: gens[1].payload,
    }
  }

  it('数据换代（仅 term 变化）：reload/ack，进程不动、端点键换到新 gen', async () => {
    const identity = 'toy-gen'
    const base = {
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
      start: 'node execute/main.js',
      members: BOTH_MEMBERS,
    }
    const world = seedTwoGens(
      identity,
      { ...base, terms: { 'a.json': JSON.stringify(['c', 2]) } },
      { ...base, terms: { 'a.json': JSON.stringify(['c', 1]) } },
    )
    const head = loadAnchor(journalFile(root)).head
    const v1 = world.ids[identity].active as Hash
    const v2 = genOf(world, identity, 0).payload
    expect(v1).toBe(genOf(world, identity, 1).payload)

    const handle = await startWorld(world)
    const before = handle.endpoints.get(identity, v1, 'toy.gen', 'echo')
    expect(before).not.toBeNull()
    expect(isPidAlive(before!.pid)).toBe(true)
    const first = await before!.link.call('toy.gen', 'echo', {}, 2000)
    expect(first.ok).toBe(true)
    const servicePid = (first as unknown as { value: { pid: number } }).value.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: identity, active: v2 }))

    expect(handle.endpoints.get(identity, v1, 'toy.gen', 'echo')).toBeNull()
    const after = handle.endpoints.get(identity, v2, 'toy.gen', 'echo')
    expect(after).not.toBeNull()
    expect(after!.pid).toBe(before!.pid) // 宿主侧 pid（shell 包装）不动
    expect(after!.link).toBe(before!.link)
    expect(serviceStops(identity)).toEqual([])
    expect(handle.loaded()).toContainEqual({ id: identity, gen: v2, service: true })
    const response = await after!.link.call('toy.gen', 'echo', {}, 2000)
    expect(response.ok).toBe(true)
    expect((response as { value: Json }).value).toMatchObject({ pid: servicePid }) // 服务进程不动
  }, 15000)

  it('reload 不被确认（超时）→ 保守按代码换代：起新服务、旧服务 drain', async () => {
    const identity = 'toy-gen'
    const base = {
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
      start: 'node execute/main.js',
      members: BOTH_MEMBERS,
      serviceConfig: { reloadMode: 'silent' },
      restart: { policy: 'on-exit', backoff: 'none', max: 1, window_ms: 60000, drain_ms: 200 },
    }
    const world = seedTwoGens(
      identity,
      { ...base, terms: { 'a.json': JSON.stringify(['c', 2]) } },
      { ...base, terms: { 'a.json': JSON.stringify(['c', 1]) } },
    )
    const head = loadAnchor(journalFile(root)).head
    const v1 = world.ids[identity].active as Hash
    const v2 = genOf(world, identity, 0).payload

    const handle = await startWorld(world, { reloadTimeoutMs: 300 })
    const oldPid = handle.endpoints.get(identity, v1, 'toy.gen', 'echo')!.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: identity, active: v2 }))

    const row = handle.endpoints.get(identity, v2, 'toy.gen', 'echo')
    expect(row).not.toBeNull()
    expect(row!.pid).not.toBe(oldPid)
    await waitFor(() => !isPidAlive(oldPid), '旧服务排空退出', 5000)
    expect(serviceStops(identity)).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'exit',
        impl: identity,
        reason: 'superseded',
      }),
    )
  }, 15000)

  it('代码换代（execute 变化）：新服务原子接管、旧服务 drain 退出、依赖者不重装', async () => {
    const dep = 'toy-gen'
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.gen': dep },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'x.json': JSON.stringify(['c', 1]) },
    })
    const base = {
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
      start: 'node execute/main.js',
      members: BOTH_MEMBERS,
      terms: { 'a.json': JSON.stringify(['c', 1]) },
    }
    const world = seedTwoGens(dep, { ...base, files: { 'execute/extra.js': '// v2\n' } }, base)
    expect(runSeed(root, [{ name: 'toy-caller', path: caller }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    const v1 = anchor.world.ids[dep].active as Hash
    const v2 = genOf(anchor.world, dep, 0).payload

    const handle = await startWorld(anchor.world)
    const oldPid = handle.endpoints.get(dep, v1, 'toy.gen', 'echo')!.pid
    const callerGenBefore = handle.loaded().find((x) => x.id === 'toy-caller')!.gen

    await handle.applyWorld(step(anchor.world, anchor.head, 'set_active', { id: dep, active: v2 }))

    const row = handle.endpoints.get(dep, v2, 'toy.gen', 'echo')
    expect(row).not.toBeNull()
    expect(handle.endpoints.get(dep, v1, 'toy.gen', 'echo')).toBeNull()
    await waitFor(() => !isPidAlive(oldPid), '旧服务退出', 5000)
    expect(serviceStops(dep)).toContainEqual(
      expect.objectContaining({ event: 'exit', impl: dep, reason: 'superseded' }),
    )
    // 依赖换代不改发出者：caller 未隔离、世代未动、无 dep.stale / dep.retired 记录
    expect(handle.loaded().find((x) => x.id === 'toy-caller')!.gen).toBe(callerGenBefore)
    expect(records.some((r) => r.kind === 'dep' && r.impl === 'toy-caller')).toBe(false)
  }, 15000)

  it('依赖退役（retire）：反向可达发出者一并隔离，端点摘除、记 dep.retired', async () => {
    const dep = 'toy-gen'
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.gen': dep },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'x.json': JSON.stringify(['c', 1]) },
    })
    const depPkg = writeTempPackage(root, {
      identity: dep,
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
      start: 'node execute/main.js',
      members: [{ kind: 'execute', path: 'execute/' }],
      restart: { policy: 'on-exit', backoff: 'none', max: 1, window_ms: 60000, drain_ms: 200 },
    })
    expect(
      runSeed(root, [
        { name: dep, path: depPkg },
        { name: 'toy-caller', path: caller },
      ]).ok,
    ).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    const handle = await startWorld(anchor.world)
    const pid = handle.endpoints.get(
      dep,
      anchor.world.ids[dep].active as Hash,
      'toy.gen',
      'echo',
    )!.pid

    await handle.applyWorld(step(anchor.world, anchor.head, 'retire', { id: dep }))

    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toEqual([])
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'dep', event: 'retired', impl: dep }),
    )
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'dep', event: 'retired', impl: 'toy-caller' }),
    )
    await waitFor(() => !isPidAlive(pid), '退役后服务进程退出', 5000)
  }, 15000)

  it('新身份入世（active null → hash）：applyWorld 后按装配同路起服务', async () => {
    const world = loadAnchor(journalFile(root)).world
    const handle = await startWorld(world)
    expect(handle.loaded()).toEqual([])

    const extra = writeTempPackage(root, {
      identity: 'toy-extra',
      implements: ['toy.extra'],
      methods: { 'toy.extra': ['echo'] },
      start: 'node execute/main.js',
    })
    expect(runSeed(root, [{ name: 'toy-extra', path: extra }]).ok).toBe(true)
    const advanced = loadAnchor(journalFile(root)).world

    await handle.applyWorld(advanced)

    const gen = advanced.ids['toy-extra'].active as Hash
    const row = handle.endpoints.get('toy-extra', gen, 'toy.extra', 'echo')
    expect(row).not.toBeNull()
    expect(isPidAlive(row!.pid)).toBe(true)
    expect(handle.loaded()).toContainEqual({ id: 'toy-extra', gen, service: true })
  }, 15000)

  it('applyWorld 幂等：同世界重复调用不做任何事（无记录增长、无端点抖动）', async () => {
    const depPkg = writeTempPackage(root, {
      identity: 'toy-gen',
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
      start: 'node execute/main.js',
      members: [{ kind: 'execute', path: 'execute/' }],
    })
    expect(runSeed(root, [{ name: 'toy-gen', path: depPkg }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    const handle = await startWorld(anchor.world)
    const before = handle.endpoints.list().map((row) => `${row.gen}:${row.pid}`)
    const count = records.length

    await handle.applyWorld(anchor.world)
    await handle.applyWorld(anchor.world)

    expect(records.length).toBe(count)
    expect(handle.endpoints.list().map((row) => `${row.gen}:${row.pid}`)).toEqual(before)
  }, 15000)

  it('在途退避重启不得借换代复活：旧 gen 离开 active 后重启排程被拦', async () => {
    const depPkg = writeTempPackage(root, {
      identity: 'toy-gen',
      implements: ['toy.gen'],
      methods: { 'toy.gen': ['echo'] },
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
    expect(runSeed(root, [{ name: 'toy-gen', path: depPkg }]).ok).toBe(true)
    const anchor = loadAnchor(journalFile(root))
    const handle = await startWorld(anchor.world)
    const v1 = anchor.world.ids['toy-gen'].active as Hash
    const oldRow = handle.endpoints.get('toy-gen', v1, 'toy.gen', 'echo')
    expect(oldRow).not.toBeNull()

    // 杀旧进程触发退避重启窗口，随即退役（active → null）：排程不得复活旧 gen
    await killProcessTree(oldRow!.pid)
    await handle.applyWorld(step(anchor.world, anchor.head, 'retire', { id: 'toy-gen' }))
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(handle.endpoints.list()).toEqual([])
    expect(handle.loaded()).toEqual([])
    expect(records.some((r) => r.event === 'start_failed' && r.impl === 'toy-gen')).toBe(false)
  }, 15000)

  it('新 active 握手失败：新世代不激活，旧服务继续服务（失败只记日志、不隔离依赖者）', async () => {
    const { world, head, okGen, brokenGen } = seedSwapFailureFixture({
      serviceConfig: { manifest: { identity: 'toy-gen-wrong' } },
    })
    const handle = await startWorld(world)
    expect(handle.loaded()).toContainEqual({ id: 'toy-gen', gen: okGen, service: true })
    const oldPid = handle.endpoints.get('toy-gen', okGen, 'toy.gen', 'echo')!.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: 'toy-gen', active: brokenGen }))

    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'handshake',
        event: 'failed',
        impl: 'toy-gen',
        gen: brokenGen,
      }),
    )
    // 新世代不激活：旧进程仍在，端点行换到新世代键后仍可调用
    expect(isPidAlive(oldPid)).toBe(true)
    const row = handle.endpoints.get('toy-gen', brokenGen, 'toy.gen', 'echo')
    expect(row).not.toBeNull()
    expect(row!.pid).toBe(oldPid)
    expect((await row!.link.call('toy.gen', 'echo', {}, 2000)).ok).toBe(true)
    expect(handle.loaded()).toContainEqual({ id: 'toy-gen', gen: brokenGen, service: true })
    // 依赖者不受影响：不隔离、无 dep.stale、仍装载
    expect(records.some((r) => r.kind === 'dep' && r.event === 'stale')).toBe(false)
    expect(handle.loaded().some((x) => x.id === 'toy-caller')).toBe(true)
    expect(
      records.some((r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-gen'),
    ).toBe(false)
  }, 15000)

  it('新 active 进程起不来（start_failed）：新世代不激活，旧服务继续服务', async () => {
    const { world, head, okGen, brokenGen } = seedSwapFailureFixture({
      start: 'node execute/nope.js',
      files: { 'execute/nope.js': 'process.exit(1)\n' },
    })
    const handle = await startWorld(world)
    expect(handle.loaded()).toContainEqual({ id: 'toy-gen', gen: okGen, service: true })
    const oldPid = handle.endpoints.get('toy-gen', okGen, 'toy.gen', 'echo')!.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: 'toy-gen', active: brokenGen }))

    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'start_failed',
        impl: 'toy-gen',
        gen: brokenGen,
      }),
    )
    expect(isPidAlive(oldPid)).toBe(true)
    const row = handle.endpoints.get('toy-gen', brokenGen, 'toy.gen', 'echo')
    expect(row).not.toBeNull()
    expect(row!.pid).toBe(oldPid)
    expect(handle.loaded()).toContainEqual({ id: 'toy-gen', gen: brokenGen, service: true })
    expect(records.some((r) => r.kind === 'dep' && r.event === 'stale')).toBe(false)
  }, 15000)

  it('新 active 构建失败（deps_failed）：新世代不激活，旧服务继续服务', async () => {
    const { world, head, okGen, brokenGen } = seedSwapFailureFixture({
      build: [{ cmd: 'node', args: ['execute/build-fail.js'] }],
      files: { 'execute/build-fail.js': 'process.exit(1)\n' },
    })
    const handle = await startWorld(world)
    expect(handle.loaded()).toContainEqual({ id: 'toy-gen', gen: okGen, service: true })
    const oldPid = handle.endpoints.get('toy-gen', okGen, 'toy.gen', 'echo')!.pid

    await handle.applyWorld(step(world, head, 'set_active', { id: 'toy-gen', active: brokenGen }))

    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'start_failed',
        impl: 'toy-gen',
        gen: brokenGen,
        reason: 'deps_failed',
      }),
    )
    expect(isPidAlive(oldPid)).toBe(true)
    const row = handle.endpoints.get('toy-gen', brokenGen, 'toy.gen', 'echo')
    expect(row).not.toBeNull()
    expect(row!.pid).toBe(oldPid)
    expect(handle.loaded()).toContainEqual({ id: 'toy-gen', gen: brokenGen, service: true })
    expect(records.some((r) => r.kind === 'dep' && r.event === 'stale')).toBe(false)
  }, 15000)
})
