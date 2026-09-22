import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startAssembly } from '../runtime.ts'
import type { AssemblyRuntimeHandle, StartAssemblyOptions } from '../runtime.ts'
import type { PluginDecl } from '../decl.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import {
  FIXTURE_ALPHA,
  FIXTURE_BETA,
  FIXTURE_SERVICE_MAIN,
  isPidAlive,
  killProcessTree,
  waitFor,
  waitForQuiescence,
  writeTempPackage,
} from '../../test/test-helpers-ext.ts'
import { H } from '../../../kernel/index.ts'
import type { Gen, Hash, Identity, Json, World } from '../../../kernel/index.ts'

type LifeRecord = {
  kind: string
  event: string
  impl?: string
  reason?: string
  caps?: string[]
}

describe('装配运行时 startAssembly', () => {
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
        await waitFor(() => !isPidAlive(pid), `停机后进程退出 pid=${pid}`, 3000).catch(() => {
          // 尽力等待；进程退出是异步的，不影响断言
        })
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  const log = (r: LifeRecord): void => {
    records.push(r)
  }

  async function startWorld(
    entries: Array<{ name: string; path?: string }>,
    opts: Partial<StartAssemblyOptions> = {},
  ): Promise<{ handle: AssemblyRuntimeHandle; world: World }> {
    const report = runSeed(root, entries)
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const handle = await startAssembly({ root, world, log, ...opts })
    handles.push(handle)
    return { handle, world }
  }

  it('跨 pins 拓扑启动序：被依赖者先起；端点行按 impl+gen+cap+method 建', async () => {
    const { handle, world } = await startWorld([
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
    ])
    expect(handle.order).toEqual(['toy-alpha', 'toy-beta'])
    const loaded = handle.loaded()
    expect(loaded.map((x) => x.id).sort()).toEqual(['toy-alpha', 'toy-beta'])
    expect(loaded.every((x) => x.service === true)).toBe(true)

    const alphaGen = world.ids['toy-alpha'].active as Hash
    const betaGen = world.ids['toy-beta'].active as Hash
    const rowA = handle.endpoints.get('toy-alpha', alphaGen, 'toy.alpha', 'echo')
    expect(rowA).not.toBeNull()
    expect(rowA!.transport).toBe('stdio')
    expect(rowA!.pid).toBeGreaterThan(0)
    expect(rowA!.link).toBeTruthy()
    const rowB = handle.endpoints.get('toy-beta', betaGen, 'toy.beta', 'echo')
    expect(rowB).not.toBeNull()
    expect(handle.endpoints.get('toy-alpha', alphaGen, 'toy.alpha', 'ghost')).toBeNull()
    expect(handle.endpoints.get('toy-alpha', alphaGen, 'toy.ghost', 'echo')).toBeNull()
    expect(handle.endpoints.list()).toHaveLength(2)
  }, 15000)

  it("start:'' 数据身份装载、无服务、无端点行", async () => {
    const dataRoot = writeTempPackage(root, { identity: 'toy-data' })
    const { handle } = await startWorld([
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-data', path: dataRoot },
    ])
    const data = handle.loaded().find((x) => x.id === 'toy-data')
    expect(data).toBeDefined()
    expect(data!.service).toBe(false)
    expect(handle.endpoints.list().every((row) => row.impl !== 'toy-data')).toBe(true)
  }, 15000)

  it('pins 成环 → dep.cycle 隔离环成员及依赖者，其余照起', async () => {
    const dataRoot = writeTempPackage(root, { identity: 'toy-data' })
    const report = runSeed(root, [
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
      { name: 'toy-data', path: dataRoot },
    ])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world

    // 在内存世界注入环：toy-cyc pins toy-alpha，且 toy-alpha 反向 pins toy-cyc。
    const alpha = world.ids['toy-alpha']
    const alphaGen = alpha.gens.find((g) => g.payload === alpha.active) as Gen
    const alphaTree = (world.defs[alphaGen.payload] as { body: { tree: string } }).body.tree
    const cycPayload = H({
      body: { tree: alphaTree, meta: { name: 'toy-cyc', version: '0.0.0' } },
    } as unknown as Json)
    const cycSig = H({ body: 'toy-cyc-sig' } as unknown as Json)
    world.defs[cycPayload] = {
      body: { tree: alphaTree, meta: { name: 'toy-cyc', version: '0.0.0' } },
    }
    world.defs[cycSig] = { body: null }
    world.ids['toy-cyc'] = {
      id: 'toy-cyc',
      schema: alpha.schema,
      gens: [
        {
          seq: 0,
          payload: cycPayload,
          pins: { alpha: alphaGen.payload },
          sig: cycSig,
          adopted: { at: 0, by: '', write: '' },
        },
      ],
      active: cycPayload,
      born: { at: 0, by: '' },
    }
    alphaGen.pins = { cyc: cycPayload }

    const handle = await startAssembly({ root, world, log })
    handles.push(handle)

    expect(handle.order).toEqual(['toy-data'])
    const loaded = handle.loaded()
    expect(loaded.map((x) => x.id)).toEqual(['toy-data'])
    expect(loaded[0].service).toBe(false)
    expect(handle.endpoints.list()).toHaveLength(0)
    expect(
      records
        .filter((r) => r.kind === 'dep' && r.event === 'cycle')
        .map((r) => r.impl)
        .sort(),
    ).toEqual(['toy-alpha', 'toy-beta', 'toy-cyc'])
  })

  it('依赖握手失败 → 依赖者 dep.stale 且跳过；独立身份照常起', async () => {
    const badRoot = writeTempPackage(root, {
      identity: 'toy-bad',
      start: 'node execute/main.js',
      implements: ['toy.bad'],
      serviceConfig: { manifest: { protocol: '9' } },
    })
    const fanRoot = writeTempPackage(root, {
      identity: 'toy-fan',
      start: 'node execute/main.js',
      implements: ['toy.fan'],
      pins: { dep: 'toy-bad' },
    })
    const { handle } = await startWorld([
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-bad', path: badRoot },
      { name: 'toy-fan', path: fanRoot },
    ])
    expect(handle.loaded().map((x) => x.id)).toEqual(['toy-alpha'])
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'handshake', event: 'failed', impl: 'toy-bad' }),
    )
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'dep', event: 'stale', impl: 'toy-fan' }),
    )
    expect(records.some((r) => r.impl === 'toy-fan' && r.event === 'exit')).toBe(false)
  }, 15000)

  it('manifest 形态/语义不符（identity/protocol/state/implements/methods/v）→ handshake.failed 各自隔离', async () => {
    const cases: Array<{ identity: string; manifest: Record<string, unknown> }> = [
      { identity: 'toy-w-ident', manifest: { identity: 'other.identity' } },
      { identity: 'toy-w-proto', manifest: { protocol: '9' } },
      { identity: 'toy-w-state', manifest: { state: 'durable' } },
      { identity: 'toy-w-impl', manifest: { implements: [] } },
      { identity: 'toy-w-meth', manifest: { methods: {} } },
      { identity: 'toy-w-v', manifest: { v: '2' } },
    ]
    const entries: Array<{ name: string; path: string }> = []
    for (const c of cases) {
      const pkgRoot = writeTempPackage(root, {
        identity: c.identity,
        start: 'node execute/main.js',
        implements: [c.identity.replace('toy-w-', 'toy.')],
        serviceConfig: { manifest: c.manifest },
      })
      entries.push({ name: c.identity, path: pkgRoot })
    }
    const { handle } = await startWorld(entries)
    expect(handle.loaded()).toEqual([])
    for (const c of cases) {
      expect(records).toContainEqual(
        expect.objectContaining({ kind: 'handshake', event: 'failed', impl: c.identity }),
      )
    }
  }, 15000)

  it('多余 cap → handshake.extra_dropped，且不登记多余端点行', async () => {
    const extraRoot = writeTempPackage(root, {
      identity: 'toy-extra',
      start: 'node execute/main.js',
      implements: ['toy.extra'],
      serviceConfig: { manifest: { implements: ['toy.extra', 'toy.unused'] } },
    })
    const { handle, world } = await startWorld([{ name: 'toy-extra', path: extraRoot }])
    expect(handle.loaded().map((x) => x.id)).toEqual(['toy-extra'])
    const extra = records.find((r) => r.kind === 'handshake' && r.event === 'extra_dropped')
    expect(extra).toBeDefined()
    expect(extra!.impl).toBe('toy-extra')
    expect(extra!.caps).toEqual(['toy.unused'])
    const gen = world.ids['toy-extra'].active as Hash
    expect(handle.endpoints.get('toy-extra', gen, 'toy.extra', 'echo')).not.toBeNull()
    expect(handle.endpoints.get('toy-extra', gen, 'toy.unused', 'echo')).toBeNull()
    expect(handle.endpoints.list()).toHaveLength(1)
  }, 15000)

  it('握手超时 → service.start_failed，身份不装载', async () => {
    const silentRoot = writeTempPackage(root, {
      identity: 'toy-silent',
      start: 'node execute/main.js',
      implements: ['toy.silent'],
      serviceConfig: { helloMode: 'silent' },
    })
    const { handle } = await startWorld([{ name: 'toy-silent', path: silentRoot }], {
      // 超时给足 1.5s：确保 node 进程已完全启动后再判超时（Windows 上 shell 包装的
      // 子进程若在未调度时被杀，可能在清理后才启动并报 MODULE_NOT_FOUND 噪音）
      handshakeTimeoutMs: 1500,
    })
    expect(handle.loaded()).toEqual([])
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'start_failed',
        impl: 'toy-silent',
        reason: 'timeout',
      }),
    )
  }, 15000)

  it('probe 超时 → service.exit health_timeout + 自动重启（端点摘除后重挂、pid 更新）', async () => {
    const probeRoot = writeTempPackage(root, {
      identity: 'toy-probe',
      start: 'node execute/main.js',
      implements: ['toy.probe'],
      health: { probe: 'toy.probe.echo', interval_ms: 100, timeout_ms: 100 },
      restart: { policy: 'on-exit', backoff: 'none', max: 5, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { probeFailTotal: 2 },
    })
    const { handle, world } = await startWorld([{ name: 'toy-probe', path: probeRoot }])
    const gen = world.ids['toy-probe'].active as Hash
    const firstRow = handle.endpoints.get('toy-probe', gen, 'toy.probe', 'echo')
    expect(firstRow).not.toBeNull()
    const firstPid = firstRow!.pid
    await waitFor(
      () =>
        records.filter(
          (r) =>
            r.kind === 'service' &&
            r.event === 'exit' &&
            r.impl === 'toy-probe' &&
            r.reason === 'health_timeout',
        ).length >= 2,
      '健康探针超时至少触发两次 service.exit（证明重启发生）',
      8000,
    )
    // 进程退出即摘除该 gen 端点行，重启成功后重挂：有界等待重挂且 pid 与首次不同
    await waitFor(
      () => {
        const row = handle.endpoints.get('toy-probe', gen, 'toy.probe', 'echo')
        return row !== null && row.pid !== firstPid
      },
      'toy-probe 重启后端点重挂且 pid 更新',
      8000,
    )
    expect(handle.loaded().map((x) => x.id)).toContain('toy-probe')
  }, 15000)

  it('服务退出即摘除该 gen 端点行，重启成功后再挂（重启窗口内该行缺席）', async () => {
    const endpointRoot = writeTempPackage(root, {
      identity: 'toy-endpoint',
      start: 'node execute/main.js',
      implements: ['toy.endpoint'],
      health: { probe: 'toy.endpoint.echo', interval_ms: 100, timeout_ms: 100 },
      // fixed 退避 400ms：退出到重挂之间有确定的可观测窗口
      restart: {
        policy: 'on-exit',
        backoff: 'fixed',
        backoff_ms: 400,
        max: 3,
        window_ms: 60000,
        drain_ms: 200,
      },
      serviceConfig: { probeFailTotal: 1 },
    })
    const { handle, world } = await startWorld([{ name: 'toy-endpoint', path: endpointRoot }])
    const gen = world.ids['toy-endpoint'].active as Hash
    const firstPid = handle.endpoints.get('toy-endpoint', gen, 'toy.endpoint', 'echo')!.pid
    await waitFor(
      () =>
        records.some(
          (r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-endpoint',
        ),
      'toy-endpoint 健康超时退出',
      8000,
    )
    // 摘除与 exit 记录在同一同步路径：观察到记录时该行必已不存在，且退避窗口内保持缺席
    expect(handle.endpoints.get('toy-endpoint', gen, 'toy.endpoint', 'echo')).toBeNull()
    await waitFor(
      () => {
        const row = handle.endpoints.get('toy-endpoint', gen, 'toy.endpoint', 'echo')
        return row !== null && row.pid !== firstPid
      },
      'toy-endpoint 重启后端点重挂且 pid 更新',
      8000,
    )
    expect(handle.loaded().map((x) => x.id)).toContain('toy-endpoint')
  }, 15000)

  it('探针无 pong（超时）→ 按退出处理；超限 → service.restart_exhausted 并隔离', async () => {
    const silentRoot = writeTempPackage(root, {
      identity: 'toy-silentprobe',
      start: 'node execute/main.js',
      implements: ['toy.silentprobe'],
      health: { probe: 'toy.silentprobe.echo', interval_ms: 100, timeout_ms: 100 },
      restart: { policy: 'on-exit', backoff: 'none', max: 1, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { probeMode: 'silent' },
    })
    const { handle } = await startWorld([{ name: 'toy-silentprobe', path: silentRoot }])
    await waitFor(
      () =>
        records.filter(
          (r) =>
            r.kind === 'service' &&
            r.event === 'exit' &&
            r.impl === 'toy-silentprobe' &&
            r.reason === 'health_timeout',
        ).length >= 2,
      '探针无 pong 超时两次（证明中途重启过一次）',
      8000,
    )
    await waitForQuiescence(() => records, 'toy-silentprobe 重启环落地（超限隔离）')
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'restart_exhausted',
        impl: 'toy-silentprobe',
      }),
    )
    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toHaveLength(0)
  }, 15000)

  it('杀掉服务进程 → service.exit + 自动重启（轮询新 pid / loaded 仍含它）', async () => {
    const { handle, world } = await startWorld([
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
    ])
    const gen = world.ids['toy-alpha'].active as Hash
    const row = handle.endpoints.get('toy-alpha', gen, 'toy.alpha', 'echo')
    expect(row).not.toBeNull()
    const oldPid = row!.pid
    expect(isPidAlive(oldPid)).toBe(true)

    await killProcessTree(oldPid)
    await waitFor(
      () => {
        const current = handle.endpoints.get('toy-alpha', gen, 'toy.alpha', 'echo')
        return current !== null && current.pid !== oldPid
      },
      'toy-alpha 服务重启后端点 pid 更新',
      8000,
    )
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'service', event: 'exit', impl: 'toy-alpha' }),
    )
    expect(
      handle
        .loaded()
        .map((x) => x.id)
        .sort(),
    ).toEqual(['toy-alpha', 'toy-beta'])
    const current = handle.endpoints.get('toy-alpha', gen, 'toy.alpha', 'echo')
    expect(current).not.toBeNull()
    expect(isPidAlive(current!.pid)).toBe(true)
  }, 15000)

  it('持续崩溃超 restart.max → service.restart_exhausted + 分支隔离（依赖者停、端点移除）', async () => {
    const crashRoot = writeTempPackage(root, {
      identity: 'toy-crash',
      start: 'node execute/main.js',
      implements: ['toy.crash'],
      restart: { policy: 'on-exit', backoff: 'none', max: 1, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { exitAfterMs: 40, crashLimit: 2 },
    })
    const depRoot = writeTempPackage(root, {
      identity: 'toy-dependent',
      start: 'node execute/main.js',
      implements: ['toy.dependent'],
      pins: { crash: 'toy-crash' },
    })
    const { handle, world } = await startWorld([
      { name: 'toy-crash', path: crashRoot },
      { name: 'toy-dependent', path: depRoot },
    ])
    await waitFor(
      () =>
        records.some(
          (r) => r.kind === 'service' && r.event === 'restart_exhausted' && r.impl === 'toy-crash',
        ),
      'toy-crash 重启超限',
      8000,
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'exit',
        impl: 'toy-dependent',
        reason: 'isolated',
      }),
    )
    expect(handle.loaded()).toEqual([])
    const crashGen = world.ids['toy-crash'].active as Hash
    const depGen = world.ids['toy-dependent'].active as Hash
    expect(handle.endpoints.get('toy-crash', crashGen, 'toy.crash', 'echo')).toBeNull()
    expect(handle.endpoints.get('toy-dependent', depGen, 'toy.dependent', 'echo')).toBeNull()
    expect(handle.endpoints.list()).toHaveLength(0)
  }, 15000)

  it('window_ms 复位语义：稳定窗口内运行后崩溃 → attempts 归零，不触发 restart_exhausted', async () => {
    const winRoot = writeTempPackage(root, {
      identity: 'toy-window',
      start: 'node execute/main.js',
      implements: ['toy.window'],
      restart: { policy: 'on-exit', backoff: 'none', max: 2, window_ms: 30, drain_ms: 200 },
      serviceConfig: { exitAfterMs: 50, crashLimit: 3 },
    })
    const { handle } = await startWorld([{ name: 'toy-window', path: winRoot }])
    await waitFor(
      () =>
        records.filter((r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-window')
          .length >= 3,
      'toy-window 至少重启两次（attempts 每次归零则不超限）',
      8000,
    )
    await waitForQuiescence(() => records, 'toy-window 重启环落地')
    expect(
      records.some(
        (r) => r.kind === 'service' && r.event === 'restart_exhausted' && r.impl === 'toy-window',
      ),
    ).toBe(false)
  }, 15000)

  it('stop() 停机：全部服务进程退出、端点清空', async () => {
    const { handle } = await startWorld([
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
    ])
    const pids = handle.endpoints.list().map((row) => row.pid)
    expect(pids).toHaveLength(2)
    await handle.stop()
    expect(handle.endpoints.list()).toHaveLength(0)
    await waitFor(() => pids.every((pid) => !isPidAlive(pid)), '停机后服务进程全部退出', 5000)
  }, 10000)

  it('服务上行 event 经 onEvent 回调上报', async () => {
    const eventRoot = writeTempPackage(root, {
      identity: 'toy-event',
      start: 'node execute/main.js',
      implements: ['toy.event'],
      health: { probe: 'toy.event.echo', interval_ms: 100, timeout_ms: 200 },
      serviceConfig: { eventTopic: 'ping', eventPayload: { n: 1 }, eventOnProbe: true },
    })
    const events: Array<{ impl: string; topic: string; payload: Json }> = []
    const report = runSeed(root, [{ name: 'toy-event', path: eventRoot }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const handle = await startAssembly({
      root,
      world,
      log,
      onEvent: (impl, topic, payload) => events.push({ impl, topic, payload }),
    })
    handles.push(handle)
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.impl === 'toy-event' && e.topic === 'ping' && (e.payload as { n: number }).n === 1,
        ),
      'onEvent 收到 toy-event 的 ping 事件',
      8000,
    )
  }, 15000)

  it("restart.policy='never'：单身份退出 → 恰一条 service.exit（真实退出码）、不重启、无 restart_exhausted、该身份隔离", async () => {
    const neverRoot = writeTempPackage(root, {
      identity: 'toy-never',
      start: 'node execute/main.js',
      implements: ['toy.never'],
      restart: { policy: 'never', backoff: 'none', max: 3, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { exitAfterMs: 60, crashLimit: 1 },
    })
    const { handle, world } = await startWorld([{ name: 'toy-never', path: neverRoot }])
    await waitFor(
      () =>
        records.some((r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-never'),
      'toy-never 退出并隔离',
      8000,
    )
    await waitForQuiescence(() => records, 'toy-never 隔离落地')
    const exits = records.filter(
      (r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-never',
    )
    expect(exits).toHaveLength(1)
    expect(exits[0].reason).toBe('exit:1')
    expect(
      records.some(
        (r) => r.kind === 'service' && r.event === 'restart_exhausted' && r.impl === 'toy-never',
      ),
    ).toBe(false)
    expect(handle.loaded().map((x) => x.id)).not.toContain('toy-never')
    const gen = world.ids['toy-never'].active as Hash
    expect(handle.endpoints.get('toy-never', gen, 'toy.never', 'echo')).toBeNull()
    expect(handle.endpoints.list()).toHaveLength(0)
  }, 15000)

  it("restart.policy='never'：运行中的依赖者随分支隔离（service.exit isolated、端点移除、loaded 不含）", async () => {
    const neverRoot = writeTempPackage(root, {
      identity: 'toy-neverdep',
      start: 'node execute/main.js',
      implements: ['toy.neverdep'],
      restart: { policy: 'never', backoff: 'none', max: 3, window_ms: 60000, drain_ms: 200 },
    })
    const fanRoot = writeTempPackage(root, {
      identity: 'toy-neverfan',
      start: 'node execute/main.js',
      implements: ['toy.neverfan'],
      pins: { dep: 'toy-neverdep' },
    })
    const { handle, world } = await startWorld([
      { name: 'toy-neverdep', path: neverRoot },
      { name: 'toy-neverfan', path: fanRoot },
    ])
    // startWorld 返回时两者都已握手装载；此刻由测试侧杀掉 never 服务（taskkill /T），
    // 隔离必然发生在依赖者运行中（service.exit isolated 才有机会产生）
    expect(
      handle
        .loaded()
        .map((x) => x.id)
        .sort(),
    ).toEqual(['toy-neverdep', 'toy-neverfan'])
    const gen = world.ids['toy-neverdep'].active as Hash
    const row = handle.endpoints.get('toy-neverdep', gen, 'toy.neverdep', 'echo')
    expect(row).not.toBeNull()
    await killProcessTree(row!.pid)
    await waitFor(
      () =>
        records.some(
          (r) =>
            r.kind === 'service' &&
            r.event === 'exit' &&
            r.impl === 'toy-neverfan' &&
            r.reason === 'isolated',
        ),
      'toy-neverfan 被随分支隔离',
      8000,
    )
    await waitForQuiescence(() => records, 'never 分支隔离落地')
    const seedExits = records.filter(
      (r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-neverdep',
    )
    expect(seedExits).toHaveLength(1)
    expect(seedExits[0].reason).toMatch(/^exit:\d+$/)
    expect(records.some((r) => r.kind === 'service' && r.event === 'restart_exhausted')).toBe(false)
    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toHaveLength(0)
  }, 15000)

  it('health.probe 填任意字符串（含空串）不影响装载与健康判定（判定走协议级 probe/pong）', async () => {
    const hpRoot = writeTempPackage(root, {
      identity: 'toy-healthprobe',
      start: 'node execute/main.js',
      implements: ['toy.healthprobe'],
      health: { probe: '', interval_ms: 100, timeout_ms: 100 },
      restart: { policy: 'on-exit', backoff: 'none', max: 3, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { probeFailTotal: 1 },
    })
    const { handle } = await startWorld([{ name: 'toy-healthprobe', path: hpRoot }])
    await waitFor(
      () =>
        records.some(
          (r) =>
            r.kind === 'service' &&
            r.event === 'exit' &&
            r.impl === 'toy-healthprobe' &&
            r.reason === 'health_timeout',
        ),
      '空 probe 字段下健康判定仍触发（协议级 ok:false → health_timeout）',
      8000,
    )
    await waitForQuiescence(() => records, 'toy-healthprobe 重启后恢复健康')
    expect(handle.loaded().map((x) => x.id)).toContain('toy-healthprobe')
  }, 15000)

  it('stop() 按启动序逆序 drain：顺序证据（两静默服务各记 drain_timeout，记录序 = 启动序逆序）', async () => {
    const baseRoot = writeTempPackage(root, {
      identity: 'toy-drainbase',
      start: 'node execute/main.js',
      implements: ['toy.drainbase'],
      restart: { policy: 'on-exit', backoff: 'none', max: 3, window_ms: 60000, drain_ms: 100 },
      serviceConfig: { drainMode: 'silent' },
    })
    const leafRoot = writeTempPackage(root, {
      identity: 'toy-drainleaf',
      start: 'node execute/main.js',
      implements: ['toy.drainleaf'],
      pins: { base: 'toy-drainbase' },
      restart: { policy: 'on-exit', backoff: 'none', max: 3, window_ms: 60000, drain_ms: 100 },
      serviceConfig: { drainMode: 'silent' },
    })
    const { handle } = await startWorld([
      { name: 'toy-drainbase', path: baseRoot },
      { name: 'toy-drainleaf', path: leafRoot },
    ])
    expect(handle.order).toEqual(['toy-drainbase', 'toy-drainleaf'])
    await handle.stop()
    // stop() 逐个 await drain：先排空启动序末位（依赖者），其 drain_timeout 必先落日志
    const drained = records
      .filter((r) => r.kind === 'service' && r.event === 'exit' && r.reason === 'drain_timeout')
      .map((r) => r.impl)
    expect(drained).toEqual(['toy-drainleaf', 'toy-drainbase'])
    expect(handle.endpoints.list()).toHaveLength(0)
  }, 15000)

  it('stop() 不写链：journal 字节与各身份 active 均不变', async () => {
    const report = runSeed(root, [
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
    ])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const journalFile = hostPaths(root).journalFile
    const beforeBytes = readFileSync(journalFile)
    const activeBefore = Object.fromEntries(
      Object.entries(world.ids).map(([id, identity]) => [id, identity.active]),
    )
    const handle = await startAssembly({ root, world, log })
    handles.push(handle)
    expect(handle.loaded()).toHaveLength(2)
    await handle.stop()
    expect(readFileSync(journalFile).equals(beforeBytes)).toBe(true)
    for (const [id, active] of Object.entries(activeBefore)) {
      expect(world.ids[id].active).toBe(active)
    }
  }, 15000)

  it('回归：稳定运行 ≥ window 后崩溃 + relaunch 持续握手失败 → max 次内 restart_exhausted + 分支隔离', async () => {
    const baseRoot = writeTempPackage(root, {
      identity: 'toy-relaunchfail',
      start: 'node execute/main.js',
      implements: ['toy.relaunchfail'],
      restart: { policy: 'on-exit', backoff: 'none', max: 2, window_ms: 200, drain_ms: 200 },
      serviceConfig: { exitAfterMs: 400, crashLimit: 1 },
    })
    const fanRoot = writeTempPackage(root, {
      identity: 'toy-relaunchfan',
      start: 'node execute/main.js',
      implements: ['toy.relaunchfan'],
      pins: { base: 'toy-relaunchfail' },
    })
    const { handle, world } = await startWorld([
      { name: 'toy-relaunchfail', path: baseRoot },
      { name: 'toy-relaunchfan', path: fanRoot },
    ])
    expect(handle.loaded()).toHaveLength(2)
    // 稳定运行期篡改物化目录的 plugin.json.identity：重启进程自述与新声明不符 → relaunch 握手必败。
    // 旧缺陷（在 scheduleRestart 里用已死旧实例的 startedAt 复位）会让 attempts 每次失败都归零、
    // 永不超限；本用例即钉住该行为。
    const materialized = join(
      hostPaths(root).materializedDir,
      world.ids['toy-relaunchfail'].active as string,
    )
    const pluginJson = JSON.parse(readFileSync(join(materialized, 'plugin.json'), 'utf8')) as {
      identity: string
    }
    pluginJson.identity = 'toy-hijacked'
    // 源码文件物化时置只读；篡改须先解写位（等价于服务强行绕过只读保护）
    chmodSync(join(materialized, 'plugin.json'), 0o666)
    writeFileSync(join(materialized, 'plugin.json'), JSON.stringify(pluginJson, null, 2))
    await waitFor(
      () =>
        records.some(
          (r) =>
            r.kind === 'service' &&
            r.event === 'restart_exhausted' &&
            r.impl === 'toy-relaunchfail',
        ),
      'relaunch 持续失败达 max → restart_exhausted',
      8000,
    )
    await waitForQuiescence(() => records, 'B1 分支隔离落地')
    expect(
      records.filter(
        (r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-relaunchfail',
      ),
    ).toHaveLength(1)
    expect(
      records.some(
        (r) => r.kind === 'handshake' && r.event === 'failed' && r.impl === 'toy-relaunchfail',
      ),
    ).toBe(true)
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'exit',
        impl: 'toy-relaunchfan',
        reason: 'isolated',
      }),
    )
    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toHaveLength(0)
  }, 15000)

  it('超限长度前缀 / 坏 JSON 帧 → handshake.failed（不降级成传输层 timeout）', async () => {
    const overRoot = writeTempPackage(root, {
      identity: 'toy-garbage',
      start: 'node execute/main.js',
      implements: ['toy.garbage'],
      serviceConfig: { helloMode: 'garbage' },
    })
    const badJsonRoot = writeTempPackage(root, {
      identity: 'toy-badjson',
      start: 'node execute/main.js',
      implements: ['toy.badjson'],
      serviceConfig: { helloMode: 'bad-json' },
    })
    // 超时放宽：node 冷启动 + 收 hello 后才写坏帧，重负载下 500ms 会先超时；
    // 坏帧一到即失败，放宽不影响失败分类（不引入等待）。
    const { handle } = await startWorld(
      [
        { name: 'toy-garbage', path: overRoot },
        { name: 'toy-badjson', path: badJsonRoot },
      ],
      { handshakeTimeoutMs: 4000 },
    )
    // 不崩宿主：assembly 正常返回；两者均被隔离（loaded/端点皆空）
    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toHaveLength(0)
    // (a) 首 4 字节 ≈1.85GB > 16 MiB 单帧上限 → 协议损坏 → handshake.failed，不落 start_failed
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'handshake', event: 'failed', impl: 'toy-garbage' }),
    )
    expect(
      records.some(
        (r) => r.kind === 'service' && r.event === 'start_failed' && r.impl === 'toy-garbage',
      ),
    ).toBe(false)
    // (b) 合法长度前缀 + 非法 JSON → markClosed('protocol_error') → 按协议形态错误收口
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'handshake', event: 'failed', impl: 'toy-badjson' }),
    )
    expect(
      records.some(
        (r) => r.kind === 'service' && r.event === 'start_failed' && r.impl === 'toy-badjson',
      ),
    ).toBe(false)
  }, 15000)

  it('小长度前缀不发体 → 凑不满且未超上限 → 传输层失败 timeout', async () => {
    const stallRoot = writeTempPackage(root, {
      identity: 'toy-stall',
      start: 'node execute/main.js',
      implements: ['toy.stall'],
      serviceConfig: { helloMode: 'stall' },
    })
    // stall 必须等满超时，单列一个世界保持 500ms，避免拖慢用例
    const { handle } = await startWorld([{ name: 'toy-stall', path: stallRoot }], {
      handshakeTimeoutMs: 500,
    })
    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toHaveLength(0)
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'start_failed',
        impl: 'toy-stall',
        reason: 'timeout',
      }),
    )
    expect(
      records.some((r) => r.kind === 'handshake' && r.event === 'failed' && r.impl === 'toy-stall'),
    ).toBe(false)
  }, 15000)

  it('服务回应错误 kind → 协议形态错误按 handshake.failed 收口', async () => {
    const wrongRoot = writeTempPackage(root, {
      identity: 'toy-wrongkind',
      start: 'node execute/main.js',
      implements: ['toy.wrongkind'],
      serviceConfig: { helloMode: 'wrong-kind' },
    })
    const { handle } = await startWorld([{ name: 'toy-wrongkind', path: wrongRoot }], {
      handshakeTimeoutMs: 2000,
    })
    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toHaveLength(0)
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'handshake', event: 'failed', impl: 'toy-wrongkind' }),
    )
    expect(records.some((r) => r.kind === 'service' && r.event === 'start_failed')).toBe(false)
  }, 15000)

  it('restart.policy 缺失/未知 → 按 on-exit 处理（服务仍会重启）', async () => {
    // 启动 pid 落文件：崩溃重启会发生「同一文件里出现两次启动」，不靠读端点表的瞬时行（防测试竞态）。
    // exitAfterMs 取足够大，保证 startWorld 返回后能先读到首实例的端点行 pid。
    const pidFiles: Record<string, string> = {
      'toy-poldef': join(root, 'poldef.pids'),
      'toy-polbogus': join(root, 'polbogus.pids'),
    }
    const withPidFile = (id: string): string =>
      `require('node:fs').appendFileSync(${JSON.stringify(pidFiles[id])}, String(process.pid) + '\\n')\n${FIXTURE_SERVICE_MAIN}`
    const defRoot = writeTempPackage(root, {
      identity: 'toy-poldef',
      start: 'node execute/main.js',
      implements: ['toy.poldef'],
      // 无 policy 字段
      restart: { backoff: 'none', max: 2, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { exitAfterMs: 1200, crashLimit: 1 },
      files: { 'execute/main.js': withPidFile('toy-poldef') },
    })
    const bogusRoot = writeTempPackage(root, {
      identity: 'toy-polbogus',
      start: 'node execute/main.js',
      implements: ['toy.polbogus'],
      restart: { policy: 'bogus', backoff: 'none', max: 2, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { exitAfterMs: 1200, crashLimit: 1 },
      files: { 'execute/main.js': withPidFile('toy-polbogus') },
    })
    const { handle, world } = await startWorld([
      { name: 'toy-poldef', path: defRoot },
      { name: 'toy-polbogus', path: bogusRoot },
    ])
    const rowOf = (id: string): { pid: number } | null =>
      handle.endpoints.get(id, world.ids[id].active as Hash, id.replace('toy-', 'toy.'), 'echo')
    const firstRowPids = new Map(
      ['toy-poldef', 'toy-polbogus'].map((id) => {
        const row = rowOf(id)
        expect(row, `${id} 首实例端点行应在`).not.toBeNull()
        return [id, (row as { pid: number }).pid]
      }),
    )
    const pidsOf = (id: string): number[] => {
      try {
        return readFileSync(pidFiles[id], 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => Number.parseInt(line, 10))
      } catch {
        return []
      }
    }
    for (const id of ['toy-poldef', 'toy-polbogus']) {
      await waitFor(
        () => pidsOf(id).length >= 2,
        `${id} 崩溃后按 on-exit 重启（两次启动 pid）`,
        8000,
      )
      const [first, second] = pidsOf(id)
      expect(second).not.toBe(first)
      // 端点行必须重挂到新实例（pid 与首实例不同），不是留着旧行
      await waitFor(
        () => {
          const row = rowOf(id)
          return row !== null && row.pid !== firstRowPids.get(id)
        },
        `${id} 端点重挂到新实例`,
        8000,
      )
    }
    expect(
      handle
        .loaded()
        .map((x) => x.id)
        .sort(),
    ).toEqual(['toy-polbogus', 'toy-poldef'])
    expect(records.some((r) => r.kind === 'service' && r.event === 'restart_exhausted')).toBe(false)
  }, 15000)

  it("members 含 execute 但 start 为空 → service.start_failed reason 'missing_start_command'，依赖者 dep.stale", async () => {
    const noexecRoot = writeTempPackage(root, {
      identity: 'toy-noexec',
      implements: [],
      start: '',
      members: [{ kind: 'execute', path: 'execute/' }],
      files: { 'execute/placeholder.txt': 'x' },
    })
    const fanRoot = writeTempPackage(root, {
      identity: 'toy-noexecfan',
      start: 'node execute/main.js',
      implements: ['toy.noexecfan'],
      pins: { base: 'toy-noexec' },
    })
    const { handle } = await startWorld([
      { name: 'toy-noexec', path: noexecRoot },
      { name: 'toy-noexecfan', path: fanRoot },
    ])
    expect(handle.loaded()).toEqual([])
    expect(handle.endpoints.list()).toHaveLength(0)
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'start_failed',
        impl: 'toy-noexec',
        reason: 'missing_start_command',
      }),
    )
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'dep', event: 'stale', impl: 'toy-noexecfan' }),
    )
  }, 15000)

  it('隔离后在途 relaunch 失败不再记失败 / 不再排程（无隔离后重启噪声）', async () => {
    // X：never 策略，延迟退出 → 退出即隔离分支（反向可达含依赖者 Y）
    const xRoot = writeTempPackage(root, {
      identity: 'toy-iso-x',
      start: 'node execute/main.js',
      implements: ['toy.iso.x'],
      restart: { policy: 'never', backoff: 'none', max: 3, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { exitAfterMs: 2500 },
    })
    // Y：pins X，on-exit；先崩溃一次，随后 relaunch 卡在握手上（篡改物化 service-config），
    // 使 X 退出隔离 Y 时，Y 的 relaunch 正在途。
    const yRoot = writeTempPackage(root, {
      identity: 'toy-iso-y',
      start: 'node execute/main.js',
      implements: ['toy.iso.y'],
      pins: { x: 'toy-iso-x' },
      restart: { policy: 'on-exit', backoff: 'none', max: 50, window_ms: 60000, drain_ms: 200 },
      serviceConfig: { exitAfterMs: 300, crashLimit: 1000 },
    })
    const { handle, world } = await startWorld(
      [
        { name: 'toy-iso-x', path: xRoot },
        { name: 'toy-iso-y', path: yRoot },
      ],
      { handshakeTimeoutMs: 2000 },
    )
    expect(
      handle
        .loaded()
        .map((x) => x.id)
        .sort(),
    ).toEqual(['toy-iso-x', 'toy-iso-y'])

    // 先等 Y 首次崩溃，确认重启环已在转，再篡改配置：使其后续 relaunch 进入握手在途环。
    // 否则重负载下若首崩晚于 X 退出，隔离时 Y 无在途 relaunch，用例退化为恒过。
    await waitFor(
      () =>
        records.some((r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-iso-y'),
      'Y 首次崩溃进入重启环',
      8000,
    )
    const materialized = join(
      hostPaths(root).materializedDir,
      world.ids['toy-iso-y'].active as Hash,
    )
    // 源码文件物化时置只读；篡改须先解写位（等价于服务强行绕过只读保护）
    chmodSync(join(materialized, 'service-config.json'), 0o666)
    writeFileSync(join(materialized, 'service-config.json'), JSON.stringify({ helloMode: 'stall' }))

    // X 退出 → 隔离 Y（Y 正处于 relaunch 握手在途窗口内）
    await waitFor(
      () =>
        records.some((r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-iso-x'),
      'X never 退出并隔离分支',
      8000,
    )
    const exitIndex = records.findIndex(
      (r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-iso-x',
    )
    // 观察窗需覆盖在途 relaunch 的握手超时落地（≤ handshakeTimeoutMs）
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const after = records.slice(exitIndex + 1)
    expect(
      after.some(
        (r) =>
          (r.kind === 'service' && r.event === 'start_failed' && r.impl === 'toy-iso-y') ||
          (r.kind === 'handshake' && r.event === 'failed' && r.impl === 'toy-iso-y') ||
          (r.kind === 'service' && r.event === 'restart_exhausted' && r.impl === 'toy-iso-y'),
      ),
    ).toBe(false)
    expect(handle.loaded().map((x) => x.id)).not.toContain('toy-iso-y')
  }, 20000)

  it('装配按依赖层并发：同层无依赖身份在构建阶段重叠', async () => {
    const aRoot = writeTempPackage(root, {
      identity: 'toy-conc-a',
      start: 'node execute/main.js',
      implements: ['toy.conc.a'],
    })
    const bRoot = writeTempPackage(root, {
      identity: 'toy-conc-b',
      start: 'node execute/main.js',
      implements: ['toy.conc.b'],
    })
    let active = 0
    let maxActive = 0
    let entered = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const restore = async (): Promise<void> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      entered += 1
      if (entered >= 2) release()
      // 有界等待：若分层错误导致两项不重叠，最多等 3s 后按实际 maxActive 判定失败
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 3000))])
      active -= 1
    }
    const { handle } = await startWorld(
      [
        { name: 'toy-conc-a', path: aRoot },
        { name: 'toy-conc-b', path: bRoot },
      ],
      { restore },
    )
    expect(maxActive).toBe(2)
    expect(
      handle
        .loaded()
        .map((x) => x.id)
        .sort(),
    ).toEqual(['toy-conc-a', 'toy-conc-b'])
  }, 15000)

  it('装配按依赖层顺序：被依赖者的构建完成后依赖者才开跑', async () => {
    const baseRoot = writeTempPackage(root, {
      identity: 'toy-lay-base',
      start: 'node execute/main.js',
      implements: ['toy.lay.base'],
    })
    const leafRoot = writeTempPackage(root, {
      identity: 'toy-lay-leaf',
      start: 'node execute/main.js',
      implements: ['toy.lay.leaf'],
      pins: { base: 'toy-lay-base' },
    })
    const events: string[] = []
    const restore = async (_cwd: string, decl: PluginDecl): Promise<void> => {
      events.push(`${decl.identity}:start`)
      if (decl.identity === 'toy-lay-base') {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      events.push(`${decl.identity}:end`)
    }
    const { handle } = await startWorld(
      [
        { name: 'toy-lay-base', path: baseRoot },
        { name: 'toy-lay-leaf', path: leafRoot },
      ],
      { restore },
    )
    expect(events.indexOf('toy-lay-base:end')).toBeLessThan(events.indexOf('toy-lay-leaf:start'))
    expect(handle.order).toEqual(['toy-lay-base', 'toy-lay-leaf'])
  }, 15000)

  it('同层并发上限生效：startConcurrency=1 → 构建不重叠', async () => {
    const aRoot = writeTempPackage(root, {
      identity: 'toy-cap-a',
      start: 'node execute/main.js',
      implements: ['toy.cap.a'],
    })
    const bRoot = writeTempPackage(root, {
      identity: 'toy-cap-b',
      start: 'node execute/main.js',
      implements: ['toy.cap.b'],
    })
    let active = 0
    let maxActive = 0
    const restore = async (): Promise<void> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
    }
    const { handle } = await startWorld(
      [
        { name: 'toy-cap-a', path: aRoot },
        { name: 'toy-cap-b', path: bRoot },
      ],
      { restore, startConcurrency: 1 },
    )
    expect(maxActive).toBe(1)
    expect(handle.loaded()).toHaveLength(2)
  }, 15000)

  it('构建耗时不计入握手超时：慢构建 + 短握手超时仍正常装载', async () => {
    const slowRoot = writeTempPackage(root, {
      identity: 'toy-slowbuild',
      start: 'node execute/main.js',
      implements: ['toy.slowbuild'],
    })
    const restore = async (): Promise<void> => {
      // 构建耗时 3s > 握手超时 1.5s：若构建计入握手窗口，这里必报 timeout
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    const { handle } = await startWorld([{ name: 'toy-slowbuild', path: slowRoot }], {
      restore,
      handshakeTimeoutMs: 1500,
    })
    expect(handle.loaded().map((x) => x.id)).toEqual(['toy-slowbuild'])
    expect(
      records.some(
        (r) => r.kind === 'service' && r.event === 'start_failed' && r.reason === 'timeout',
      ),
    ).toBe(false)
  }, 15000)

  it('装配期构建失败（deps_failed）→ 该身份及依赖者隔离，独立插件不受影响', async () => {
    const badRoot = writeTempPackage(root, {
      identity: 'toy-buildfail',
      start: 'node execute/main.js',
      implements: ['toy.buildfail'],
      build: [{ cmd: 'node', args: ['execute/fail.js'] }],
      files: { 'execute/fail.js': 'process.exit(1)\n' },
    })
    const fanRoot = writeTempPackage(root, {
      identity: 'toy-buildfan',
      start: 'node execute/main.js',
      implements: ['toy.buildfan'],
      pins: { dep: 'toy-buildfail' },
    })
    const { handle } = await startWorld([
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-buildfail', path: badRoot },
      { name: 'toy-buildfan', path: fanRoot },
    ])
    expect(handle.loaded().map((x) => x.id)).toEqual(['toy-alpha'])
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'service',
        event: 'start_failed',
        impl: 'toy-buildfail',
        reason: 'deps_failed',
      }),
    )
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'dep', event: 'stale', impl: 'toy-buildfan' }),
    )
  }, 15000)
})
