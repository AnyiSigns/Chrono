// 三形态验收：同一 toy 插件在 stdio / inproc / worker 下，同一组调用产出逐字节相同的结果与审计；
// worker 崩溃只收该分支（宿主存活、按重启策略恢复）；inproc / worker 无独立进程（pid 缺席）。
// inproc 崩溃带走宿主是已知代价，见 docs/plugins.md（同线程无隔离，故不在此做破坏性用例）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { startAssembly } from '../runtime.ts'
import type { AssemblyRuntimeHandle } from '../runtime.ts'
import type { ServiceLink } from '../../service-link.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { buildAudit } from '../../effect/execute.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { FIXTURE_CHANNEL_MAIN, waitFor, writeTempPackage } from '../../test/test-helpers-ext.ts'
import { canonicalJson } from '../../../kernel/index.ts'
import type { EffRequest, EffResult, Hash, Json, World } from '../../../kernel/index.ts'

type LifeRecord = { kind: string; event: string; impl?: string; reason?: string }
type Form = 'stdio' | 'inproc' | 'worker'

const FORMS: readonly Form[] = ['stdio', 'inproc', 'worker']

describe('服务形态（transport）：三形态一致性', () => {
  let records: LifeRecord[] = []
  const handles: AssemblyRuntimeHandle[] = []
  const roots: string[] = []

  beforeEach(() => {
    records = []
    handles.length = 0
    roots.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 尽力停机
      }
    }
    handles.length = 0
    for (const dir of roots.splice(0)) await cleanupTempRoot(dir)
  })

  const log = (r: LifeRecord): void => {
    records.push(r)
  }

  /**
   * 在独立 root 里 seed 同一身份 `toy-channel`（同一份 `execute/main.mjs`），按 transport 起装配。
   * 三个 root 各自独立，故可直接逐字节比较结果 / 审计 / 事件。
   */
  async function startForm(
    transport: Form,
  ): Promise<{ handle: AssemblyRuntimeHandle; world: World; events: Json[] }> {
    const dir = createTempRoot()
    roots.push(dir)
    const start = transport === 'stdio' ? 'node execute/main.mjs' : 'execute/main.mjs'
    const pkg = writeTempPackage(dir, {
      identity: 'toy-channel',
      implements: ['toy.channel'],
      methods: { 'toy.channel': ['echo'] },
      start,
      transport,
      files: { 'execute/main.mjs': FIXTURE_CHANNEL_MAIN },
    })
    const report = runSeed(dir, [{ name: 'toy-channel', path: pkg }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(dir, 'state', 'world', 'journal.jsonl')).world
    const events: Json[] = []
    const handle = await startAssembly({
      root: dir,
      world,
      log,
      onEvent: (impl, topic, payload) => events.push({ impl, topic, payload } as unknown as Json),
    })
    handles.push(handle)
    return { handle, world, events }
  }

  it('同一组调用在 stdio / inproc / worker 下产出逐字节相同的结果、审计与事件', async () => {
    const results: string[] = []
    const audits: string[] = []
    const events: string[] = []
    const pids: Array<number | undefined> = []
    const transports: string[] = []

    for (const transport of FORMS) {
      const { handle, world, events: emitted } = await startForm(transport)
      const gen = world.ids['toy-channel'].active as Hash
      const row = handle.endpoints.get('toy-channel', gen, 'toy.channel', 'echo')
      expect(row, `${transport} 端点行应在`).not.toBeNull()
      transports.push(row!.transport)
      pids.push(row!.pid)
      const link = row!.link as unknown as ServiceLink

      // 正向调用：同一 args，比较结果
      const response = await link.call('toy.channel', 'echo', { n: 1 }, 5000)
      expect(response.ok, `${transport} echo 应成功`).toBe(true)
      const value = response.ok ? response.value : null
      results.push(canonicalJson(value))

      // 控制面直调：probe / reload 三形态同语义（不依赖进程存活竞速）
      expect(await link.probe(2000), `${transport} probe`).toBe(true)
      await link.reload('g'.repeat(64), 2000)

      // 审计：同一 eff + 同一结果 → 审计正文逐字节相同
      const eff = {
        id: 'e1',
        port: 'toy.channel',
        method: 'echo',
        args: { n: 1 },
      } as unknown as EffRequest
      const effResult: EffResult = response.ok
        ? { ok: true, value: response.value }
        : { ok: false, error: response.code }
      const audit = buildAudit(
        eff,
        { by: 'test', now: 1_700_000_000_000, run: 'run-1', emitter: 'toy-channel' },
        effResult,
        false,
      )
      audits.push(canonicalJson(audit as unknown as Json))

      // 上行事件（hello 时各发一条 ready）逐字节相同
      events.push(canonicalJson(emitted))

      await link.drain(200, 2000)
    }

    expect(transports).toEqual(['stdio', 'inproc', 'worker'])
    // pid 语义：stdio 有独立进程；inproc / worker 无
    expect(pids[0]).toBeGreaterThan(0)
    expect(pids[1]).toBeUndefined()
    expect(pids[2]).toBeUndefined()

    expect(results[0]).toBe(results[1])
    expect(results[0]).toBe(results[2])
    expect(audits[0]).toBe(audits[1])
    expect(audits[0]).toBe(audits[2])
    expect(events[0]).toBe(events[1])
    expect(events[0]).toBe(events[2])
  }, 30000)

  it('worker 崩溃只收该分支：宿主存活、service.exit 记账、按重启策略恢复端点', async () => {
    const dir = createTempRoot()
    roots.push(dir)
    const pkg = writeTempPackage(dir, {
      identity: 'toy-chan-crash',
      implements: ['toy.channel'],
      methods: { 'toy.channel': ['echo'] },
      start: 'execute/main.mjs',
      transport: 'worker',
      files: { 'execute/main.mjs': FIXTURE_CHANNEL_MAIN },
      serviceConfig: { callMode: 'exit' },
      restart: { policy: 'on-exit', backoff: 'none', max: 3, window_ms: 60000, drain_ms: 200 },
    })
    const report = runSeed(dir, [{ name: 'toy-chan-crash', path: pkg }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(dir, 'state', 'world', 'journal.jsonl')).world
    const handle = await startAssembly({ root: dir, world, log })
    handles.push(handle)

    const gen = world.ids['toy-chan-crash'].active as Hash
    const row = handle.endpoints.get('toy-chan-crash', gen, 'toy.channel', 'echo')
    expect(row).not.toBeNull()

    // 调用即让 worker 退出：通道断开，调用以「没执行」收口（不炸宿主）
    await expect(row!.link.call('toy.channel', 'echo', null, 2000)).rejects.toBeTruthy()

    await waitFor(
      () =>
        records.some(
          (r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-chan-crash',
        ),
      'worker 退出被记为 service.exit',
      8000,
    )
    // 宿主仍存活，重启后端点重挂（新实例）
    await waitFor(
      () => {
        const current = handle.endpoints.get('toy-chan-crash', gen, 'toy.channel', 'echo')
        return current !== null && current !== row
      },
      'worker 重启后端点重挂',
      8000,
    )
    expect(handle.loaded().some((x) => x.id === 'toy-chan-crash')).toBe(true)
    expect(records.some((r) => r.kind === 'service' && r.event === 'restart_exhausted')).toBe(false)
  }, 20000)
})
