// watcher 触发的一次入世：纯规划（`planIngest`）→ 落 CAS → 经宿主落账互斥段提交 batch → 装配跟随。
// 与离线 seed 共用同一打包核心，故同一目录同一身份产出同一 commit 哈希；不同点是它跑在宿主进程内、
// 复用宿主的 `WorldWriter`，而不是自己抢锁——宿主常驻时锁恒被持有，离线 seed 必然 `writer_busy`。
// 换代走正常 `add_gen`，产生真 journal entry，可回滚可审计，不引入开发态与生产态的分叉。

import { randomUUID } from 'node:crypto'
import { cloneWorld, commit } from '../../kernel/index.ts'
import { appendJournal } from '../ledger/index.ts'
import { putBlob } from '../blobs.ts'
import { planIngest } from '../assembly/ingest.ts'
import type { PluginEntry } from '../assembly/ingest.ts'
import type { HostPaths } from '../paths.ts'
import type { WorldWriter } from '../writer.ts'
import type { Hash, Head, World, WriteRequest } from '../../kernel/index.ts'

export type ReloadOutcome =
  | { status: 'unchanged'; identity: string }
  | { status: 'committed'; identity: string; gen: Hash }
  | { status: 'failed'; identity: string | null; reasons: string[] }

export interface ReloadDeps {
  root: string
  paths: HostPaths
  writer: WorldWriter
  /** 宿主逐轮非回退时钟（与 run 落账同源）。 */
  now: () => number
  /** 链头推进后的装配跟随；宿主注入 `applyWorldSerial`，保证换代跟随串行且单调。 */
  applyWorld: (world: World, head: Head) => Promise<void>
}

/**
 * 重新入世一个投递目录：
 * 内容哈希与当前最近代码世代相同 → `unchanged`（什么都不做，不产生 journal entry）；
 * 不同 → 字节先落 CAS、再在落账互斥段内提交 `batch`（身份不存在则 `add_identity` + `add_gen`），
 * 链头推进后交装配跟随（代码换代重起进程、数据换代热生效）。
 * 提交被拒 → `failed`，世界分文未动（至多留孤儿 CAS 字节，离线 GC 清理）。
 */
export async function reloadPlugin(deps: ReloadDeps, entry: PluginEntry): Promise<ReloadOutcome> {
  const planned = planIngest(deps.writer.snapshot().world, deps.root, entry)
  if (!planned.ok) return { status: 'failed', identity: null, reasons: planned.reasons }
  const plan = planned.plan
  if (plan.unchanged) return { status: 'unchanged', identity: plan.identity }

  // 字节先于链落 CAS：提交拒绝时至多留孤儿字节，世界分文未动（与 seed / pack 同规）
  for (const blob of plan.blobs) putBlob(deps.paths.blobsDir, blob.bytes)

  const outcome = await deps.writer.run((state) => {
    try {
      const request: WriteRequest = {
        id: `watch-${randomUUID()}`,
        op: 'batch',
        target: { expect_pos: state.head.hash },
        args: { ops: plan.ops },
        by: 'watcher',
      }
      // `commit` 的契约是就地演化传入的世界；但装配运行时持有同一份引用做「换代前后」比对，
      // 就地改会让它把新旧视作同一对象而看不见换代。故先克隆独占副本再提交（与内核 `run` 同规）。
      const nextWorld = cloneWorld(state.world)
      const committed = commit(state.head, nextWorld, request, deps.now())
      if (!committed.verdict.ok) {
        return { ok: false as const, reasons: committed.verdict.reasons }
      }
      if (committed.entry === null) {
        // 幂等命中（内容其实未变）：世界未动
        return { ok: true as const, wrote: false, world: state.world, head: state.head }
      }
      appendJournal(deps.paths.journalFile, [committed.entry])
      state.world = nextWorld
      state.head = { seq: committed.entry.seq, hash: committed.hash as Hash }
      return { ok: true as const, wrote: true, world: nextWorld, head: state.head }
    } catch (err) {
      return { ok: false as const, reasons: [err instanceof Error ? err.message : String(err)] }
    }
  })
  if (!outcome.ok) {
    return { status: 'failed', identity: plan.identity, reasons: outcome.reasons }
  }
  if (!outcome.wrote) return { status: 'unchanged', identity: plan.identity }
  await deps.applyWorld(outcome.world, outcome.head)
  return { status: 'committed', identity: plan.identity, gen: plan.commitHash }
}
