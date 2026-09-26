// watcher 一次触发的宿主侧处理：重新入世（内容未变则什么都不做）→ 装配跟随。
// 换代走正常 `add_gen`（真 journal entry，可回滚可审计）；失败不替换在跑服务，
// 只记运维日志并在终端说清「旧版本继续服务」。

import { reloadPlugin } from './reload.ts'
import type { WatchTarget } from './watcher.ts'
import type { AssemblyRuntimeHandle } from '../assembly/index.ts'
import type { LifecycleRecord } from '../lifecycle.ts'
import type { HostPaths } from '../paths.ts'
import type { WorldWriter } from '../writer.ts'
import type { Head, World } from '../../kernel/index.ts'

export interface WatchReloadDeps {
  root: string
  paths: HostPaths
  writer: WorldWriter
  nextNow: () => number
  applyWorld: (world: World, head: Head) => Promise<void>
  safeAppendLifecycle: (record: LifecycleRecord) => void
  escalateFatal: () => void
  getRuntime: () => AssemblyRuntimeHandle | undefined
  isStopping: () => boolean
  /** 跟随失败的世代集合（`recordLifecycle` 写入）：watcher 据此把「旧版本继续服务」讲清楚。 */
  followFailedGens: Set<string>
  watchLog: (line: string) => void
}

export interface WatchReload {
  onReload: (target: WatchTarget, changedPath: string) => Promise<void>
}

export function createWatchReload(deps: WatchReloadDeps): WatchReload {
  /**
   * 换代跟随失败的实况提示：准备阶段失败时旧实例仍在服务（端点已换新世代键）；
   * 独占序 drain 后的 spawn / 握手失败则已无旧实例，该身份转入「无服务但保留世代」按 `restart` 重试。
   * 按运行态实况区分，不笼统说「旧版本继续服务」。
   */
  const followFailureLine = (identity: string): string => {
    const running =
      deps.getRuntime()?.loaded().some((entry) => entry.id === identity && entry.service) ?? false
    return running
      ? `watcher: ${identity} 新世代构建 / 启动失败，旧版本继续服务`
      : `watcher: ${identity} 新世代启动失败，当前无可用服务（按 restart 策略重试）`
  }

  const onReload = async (target: WatchTarget, changedPath: string): Promise<void> => {
    if (deps.isStopping() || deps.getRuntime() === undefined) return
    const label = target.entry.name
    deps.safeAppendLifecycle({
      at: Date.now(),
      kind: 'host',
      event: 'watch_triggered',
      impl: label,
      reason: changedPath,
    })
    const outcome = await reloadPlugin(
      {
        root: deps.root,
        paths: deps.paths,
        writer: deps.writer,
        now: deps.nextNow,
        applyWorld: deps.applyWorld,
      },
      target.entry,
    )
    if (outcome.status === 'failed') {
      const reason = outcome.reasons.join('|')
      deps.safeAppendLifecycle({
        at: Date.now(),
        kind: 'host',
        event: 'watch_failed',
        impl: outcome.identity ?? label,
        reason,
      })
      deps.watchLog(`watcher: ${outcome.identity ?? label} 入世失败，旧版本继续服务（${reason}）`)
      // 普通拒绝时 fatalError() 为空，escalateFatal 是空操作；落账失败则停机
      deps.escalateFatal()
      return
    }
    if (outcome.status === 'unchanged') return
    const failed = deps.followFailedGens.has(outcome.gen)
    // 一次性消费：本次跟随实况已据实报出；同一世代若再次失败会在下次跟随重新记入，
    // 避免只增不减（曾失败后又被重试成功的世代不再被永久误报为失败）。
    deps.followFailedGens.delete(outcome.gen)
    deps.safeAppendLifecycle({
      at: Date.now(),
      kind: 'host',
      event: failed ? 'watch_follow_failed' : 'watch_applied',
      impl: outcome.identity,
      gen: outcome.gen,
    })
    deps.watchLog(
      failed
        ? followFailureLine(outcome.identity)
        : `watcher: ${outcome.identity} 检测到改动 → 已重建并接管（gen ${outcome.gen.slice(0, 12)}）`,
    )
  }

  return { onReload }
}
