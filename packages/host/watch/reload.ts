// watcher 触发的一次入世：纯规划（`planIngest`）→ 落 CAS → 经宿主落账互斥段提交 batch → 装配跟随。
// 与离线 seed 共用同一打包核心，故同一目录同一身份产出同一 commit 哈希；不同点是它跑在宿主进程内、
// 复用宿主的 `WorldWriter`，而不是自己抢锁——宿主常驻时锁恒被持有，离线 seed 必然 `writer_busy`。
// 换代走正常 `add_gen`，产生真 journal entry，可回滚可审计，不引入开发态与生产态的分叉。

import { randomUUID } from 'node:crypto'
import { appendJournal } from '../ledger/index.ts'
import { putBlob } from '../blobs.ts'
import { planIngest } from '../assembly/ingest.ts'
import type { PluginEntry } from '../assembly/ingest.ts'
import type { HostPaths } from '../paths.ts'
import type { WorldWriter } from '../writer.ts'
import { commitToWorld } from '../world-commit.ts'
import type { Hash, Head, World } from '../../kernel/index.ts'

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

/** 落账段内的定论：与外部 `ReloadOutcome` 分离，携带提交产物供段外交装配跟随。 */
type SegmentOutcome =
  | { kind: 'unchanged'; identity: string }
  | { kind: 'failed'; identity: string | null; reasons: string[] }
  | { kind: 'committed'; identity: string; gen: Hash; world: World; head: Head }

/**
 * 重新入世一个投递目录：
 * 内容哈希与当前最近代码世代相同 → `unchanged`（什么都不做，不产生 journal entry）；
 * 不同 → 字节先落 CAS、再在落账互斥段内提交 `batch`（身份不存在则 `add_identity` + `add_gen`），
 * 链头推进后交装配跟随（代码换代重起进程、数据换代热生效）。
 * 提交被拒 → `failed`，世界分文未动（至多留孤儿 CAS 字节，离线 GC 清理）。
 *
 * 规划（`planIngest` + `putBlob`，皆同步 IO）默认在**段外**预规划，缩短落账互斥段的持锁时间；
 * 段内以当前世界为准校验，世界已变（并发落账）才在段内重规划，保证 pins / unchanged / `id_taken`
 * 判定用段内当前世界。局限：`planIngest` 读源码树用 `readFileStable`（读前后 stat 比对），
 * 仍是 TOCTOU——打包中途的写入可能被读成混合版本；内容哈希自洽，调用方按结果处理，不追求原子快照。
 */
export async function reloadPlugin(deps: ReloadDeps, entry: PluginEntry): Promise<ReloadOutcome> {
  // 段外预规划：读源码树是重同步 IO，放段内会长时间占住落账互斥段、拖慢其它提交。
  // 字节也先落 CAS（内容寻址、幂等）；段内世界未变即复用该预规划。
  const preWorld = deps.writer.snapshot().world
  const preplanned = planIngest(preWorld, deps.root, entry)
  if (preplanned.ok && !preplanned.plan.unchanged) {
    for (const blob of preplanned.plan.blobs) putBlob(deps.paths.blobsDir, blob.bytes)
  }
  const outcome = await deps.writer.run<SegmentOutcome>((state) => {
    try {
      let planned = preplanned
      if (!preplanned.ok || state.world !== preWorld) {
        planned = planIngest(state.world, deps.root, entry)
        if (planned.ok && !planned.plan.unchanged) {
          for (const blob of planned.plan.blobs) putBlob(deps.paths.blobsDir, blob.bytes)
        }
      }
      if (!planned.ok) return { kind: 'failed', identity: null, reasons: planned.reasons }
      const plan = planned.plan
      if (plan.unchanged) return { kind: 'unchanged', identity: plan.identity }

      const committed = commitToWorld(
        { kind: 'writer', world: state.world, head: state.head },
        {
          id: `watch-${randomUUID()}`,
          op: 'batch',
          args: { ops: plan.ops },
          by: 'watcher',
        },
        deps.now(),
        (entry) => appendJournal(deps.paths.journalFile, [entry]),
      )
      if (committed.kind === 'refused') {
        return { kind: 'failed', identity: plan.identity, reasons: committed.reasons }
      }
      if (committed.kind === 'unchanged') {
        // 幂等命中（内容其实未变）：世界未动
        return { kind: 'unchanged', identity: plan.identity }
      }
      state.world = committed.world
      state.head = committed.head
      return {
        kind: 'committed',
        identity: plan.identity,
        gen: plan.commitHash,
        world: committed.world,
        head: committed.head,
      }
    } catch (err) {
      return {
        kind: 'failed',
        identity: null,
        reasons: [err instanceof Error ? err.message : String(err)],
      }
    }
  })
  if (outcome.kind === 'failed') {
    return { status: 'failed', identity: outcome.identity, reasons: outcome.reasons }
  }
  if (outcome.kind === 'unchanged') return { status: 'unchanged', identity: outcome.identity }
  await deps.applyWorld(outcome.world, outcome.head)
  return { status: 'committed', identity: outcome.identity, gen: outcome.gen }
}
