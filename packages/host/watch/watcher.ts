// 源码 watcher：盯 `state/plugins.json` 登记的投递路径，文件变动经静默窗口合并后回调。
// 只监听、不落账、不持锁：重建与换代交给回调（宿主落账互斥段 + 装配跟随），
// 故 watcher 能活在常驻宿主进程内，而不必走离线 seed 那条会撞锁的路。
//
// 跨平台口径：`fs.watch` 的 recursive 在 Windows / macOS 稳定；Linux 自 Node 20 起可用
// （本包 engines >=24）。Windows 事件语义与 POSIX 有差异——同一保存可能给多条事件、
// `filename` 可能是相对路径也可能为 null；无法定位时保守按整目录触发，
// 因重建前会先比对内容哈希，真无变化不会换代，故不会因此死循环。

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { readPluginManifest, resolveEntryRoot } from '../assembly/ingest.ts'
import type { PluginEntry } from '../assembly/ingest.ts'
import { readWorldignore } from '../assembly/source.ts'
import { DEFAULT_WATCH_DEBOUNCE_MS, Debouncer } from './debounce.ts'
import { isPackedChange, watchPathSegments } from './ignore.ts'

/** 一个被盯的投递目标：清单项 + 其解析出的包根目录。 */
export interface WatchTarget {
  entry: PluginEntry
  dir: string
}

export interface SourceWatcherOptions {
  root: string
  /** 静默窗口（毫秒）；缺省 `DEFAULT_WATCH_DEBOUNCE_MS`。 */
  debounceMs?: number
  /**
   * 一次合并后的重建请求；同目标串行、不重入。`changedPath` 为触发事件的文件名
   * （无法定位时为空串，仅作日志展示）。
   */
  onReload: (target: WatchTarget, changedPath: string) => void | Promise<void>
  /** watcher 自身故障（目录消失 / 平台不支持 recursive / 句柄错误）只上报，不炸宿主。 */
  onError?: (target: WatchTarget, reason: string) => void
}

export interface SourceWatcherHandle {
  /** 实际开始监听的目标（解析不到包根的清单项不在内）。 */
  targets: WatchTarget[]
  stop: () => Promise<void>
}

/**
 * 解析 `state/plugins.json` 登记的投递路径：有 path 走路径、无 path 走 Node 解析。
 * 清单缺失 / 损坏、或某条解析不到包根 → 跳过（只读目录不产生事件，也不需要任何插件分类）。
 */
export function resolveWatchTargets(root: string): WatchTarget[] {
  let entries: PluginEntry[]
  try {
    entries = readPluginManifest(root)
  } catch {
    return []
  }
  const targets: WatchTarget[] = []
  for (const entry of entries) {
    const dir = resolveEntryRoot(root, entry)
    if (dir !== null) targets.push({ entry, dir })
  }
  return targets
}

/** 起 watcher：每个投递目标一个 recursive 句柄 + 一个静默窗口；返回的 stop 等待在途重建收敛。 */
export function startSourceWatcher(options: SourceWatcherOptions): SourceWatcherHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
  const targets = resolveWatchTargets(options.root)
  const watchers: FSWatcher[] = []
  const debouncers: Debouncer[] = []
  let stopped = false
  // 每目标一条重建链：同目标事件合并后按序执行、不重入；不同目标互不阻塞（落账段内规划保证一致性）
  const chains: Array<() => Promise<void>> = []
  for (const target of targets) {
    let lastPath = ''
    let chain: Promise<void> = Promise.resolve()
    const debouncer = new Debouncer(debounceMs, () => {
      if (stopped) return
      const changed = lastPath
      chain = chain
        .then(async () => {
          if (stopped) return
          await options.onReload(target, changed)
        })
        .catch((err: unknown) => {
          // 重建意外抛错（而非返回 failed）必须可见：只上报，不中断后续事件
          options.onError?.(target, err instanceof Error ? err.message : String(err))
        })
    })
    chains.push(() => chain)
    debouncers.push(debouncer)
    try {
      const watcher = watch(target.dir, { recursive: true }, (_event, filename) => {
        const rel = typeof filename === 'string' && filename.length > 0 ? filename : null
        if (rel === null) {
          // 无法定位：保守触发（重建前比对内容哈希，无变化不换代）
          debouncer.schedule()
          return
        }
        const ignore = readWorldignore(target.dir)
        if (!ignore.ok) {
          // `.worldignore` 读不出：保守触发，让入世失败被看见，而不是静默漏掉
          debouncer.schedule()
          return
        }
        if (isPackedChange(watchPathSegments(rel), ignore.patterns)) {
          lastPath = rel
          debouncer.schedule()
        }
      })
      watcher.on('error', (err) => {
        options.onError?.(target, err instanceof Error ? err.message : String(err))
      })
      watchers.push(watcher)
    } catch (err) {
      // 平台不支持 recursive / 目录已消失：上报后跳过该目标，其余目标照常
      options.onError?.(target, err instanceof Error ? err.message : String(err))
    }
  }
  const stop = async (): Promise<void> => {
    stopped = true
    for (const debouncer of debouncers) debouncer.dispose()
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch {
        // 句柄可能已被平台回收：关闭失败不阻断停机
      }
    }
    await Promise.allSettled(chains.map((current) => current()))
  }
  return { targets, stop }
}
