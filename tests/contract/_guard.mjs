// 接缝测试共享驱动：真宿主路由（judgments）→ 真 guard 服务（facts / collect）→ term 裁决。
// `guard.judge` 已整迁 term（plugin.json.judgments）；本文件把宿主组合根的最小等价件拼出来：
// 入世 seed 临时世界 → spawn 真 guard 服务 → 端点表挂 facts/collect → judgment runner + invoke。
// 本文件不是测试文件（不以 .test.mjs 结尾），不参与 `node --test` 收集。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSeed } from '../../packages/host/offline.ts'
import { loadAnchor } from '../../packages/host/ledger/index.ts'
import { hostPaths } from '../../packages/host/paths.ts'
import { EndpointTable } from '../../packages/host/endpoint-table.ts'
import { assemblyGen } from '../../packages/host/assembly/index.ts'
import {
  createJudgmentInvoke,
  createJudgmentRunner,
  createRoundRouter,
} from '../../packages/host/effect/index.ts'
import { DEFAULT_LIMITS } from '../../packages/host/run-registry.ts'
import { startRealService, stopRealService } from './_bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GUARD_DIR = resolve(HERE, '..', '..', 'plugins', 'guard')

/** `guard.facts` / `guard.collect` 的端点行：link 直连 spawn 的真服务。 */
function serviceRow(service, gen, method) {
  return {
    impl: 'guard',
    gen,
    cap: 'guard',
    method,
    transport: 'stdio',
    pid: service.child.pid,
    link: {
      call: async (_port, called, args, _timeout, _signal, env) => {
        const frame = await service.call('guard', called, args, env)
        return frame.kind === 'error'
          ? { ok: false, code: frame.code, message: frame.message ?? '' }
          : { ok: true, value: frame.value ?? null }
      },
    },
  }
}

/**
 * 起一套「宿主路由 + 真 guard 服务」的最小接线，返回 `judge(bag)`（等价 `eff guard.judge`）
 * 与 `dispose()`。judge 返回端点调用结果 `{ok:true,value}` / `{ok:false,code,message}`。
 */
export async function startGuardJudgment() {
  const root = mkdtempSync(join(tmpdir(), 'chrono-guard-judgment-'))
  const service = startRealService({ name: 'guard' })
  const cleanup = async () => {
    await stopRealService(service)
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows 偶发 EPERM：临时目录留给系统回收
    }
  }
  try {
    const report = runSeed(root, [{ name: 'guard', path: GUARD_DIR }])
    if (!report.ok) throw new Error(`seed guard failed: ${JSON.stringify(report.items)}`)
    const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
    const blobsDir = hostPaths(root).blobsDir
    const gen = assemblyGen(world, 'guard').payload

    const endpoints = new EndpointTable()
    endpoints.add(serviceRow(service, gen, 'facts'))
    endpoints.add(serviceRow(service, gen, 'collect'))

    let router
    const invoke = createJudgmentInvoke({ getRouter: () => router, blobsDir, now: () => 0 })
    router = createRoundRouter({
      endpoints,
      blobsDir,
      judgment: createJudgmentRunner(DEFAULT_LIMITS, { invoke }),
    })

    const judge = (bag) => {
      const outcome = router.resolve(world, 'guard', 'guard', 'judge')
      if (!outcome.ok) throw new Error(`resolve guard.judge failed: ${outcome.error}`)
      return outcome.row.link.call('guard', 'judge', bag, 20000)
    }
    return { judge, dispose: cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}
