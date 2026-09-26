// 宿主启动与停机编排：抢锁 → 载锚 → 撕裂尾修复 → 审计回填 → 启动压缩 → GC → 组合根接线（监听 +
// 起装配）→ 停机逆序收口。**全程 try/finally**：锁在 try 内取得、任何中途抛出都释放，不留 stale 锁。

import { truncateSync } from 'node:fs'
import {
  acquireLock,
  loadAnchor,
  readAllEntries,
  readJournal,
  releaseLock,
  replayFull,
} from './ledger/index.ts'
import { AuditStore } from './audit-store.ts'
import { resolveAuditTier } from './audit-tiers.ts'
import { backfillAuditStore, readAuditBackfillMeta } from './audit-backfill.ts'
import {
  DEFAULT_COMPACT_TAIL_ENTRIES,
  DEFAULT_FLATTEN_CHAIN,
  DEFAULT_GEN_RETENTION,
  compactWorld,
} from './compact.ts'
import { gcMaterialized } from './assembly/index.ts'
import { gcPluginData } from './plugin-data.ts'
import { gcPluginState } from './plugin-state.ts'
import { flushLifecycleSync } from './lifecycle.ts'
import { WorldWriter } from './writer.ts'
import type { LifecycleRecord } from './lifecycle.ts'
import type { HostPaths } from './paths.ts'
import type { AssemblyRuntimeHandle } from './assembly/index.ts'
import type { Head, World } from '../kernel/index.ts'

/** 世界就绪后交给组合根的接线上下文：writer / 审计索引 / 初值 / 审计分档世界 setter。 */
export interface WorldReady {
  writer: WorldWriter
  audits: AuditStore
  world: World
  head: Head
  /** 审计分档声明随世代变：跟随成功后调用，后续插入按新声明取预算。 */
  setAuditTierWorld: (world: World) => void
}

/** 组合根接线的产物：装配运行时。运行态收口由组合根的 `stop` 负责，本模块只管锁与世界资源。 */
export interface WiredHost {
  runtime: AssemblyRuntimeHandle
}

export interface BootstrapOptions {
  root: string
  paths: HostPaths
  startedAt: number
  /** G6 启动压缩阈值（尾段 entry 数）；缺省 `DEFAULT_COMPACT_TAIL_ENTRIES`。 */
  compactTailEntries?: number
  /** 运维日志安全写入：日志是旁路，写失败不得中断启动 / 停机。 */
  safeAppendLifecycle: (record: LifecycleRecord) => void
  /** 世界就绪后由组合根接线（监听入站面 → 起装配 → 建 router / periodic / watcher）。 */
  wire: (ready: WorldReady) => Promise<WiredHost>
}

export interface BootstrappedHost {
  writer: WorldWriter
  audits: AuditStore
  runtime: AssemblyRuntimeHandle
  setAuditTierWorld: (world: World) => void
  /** 停机逆序收口（幂等）：运行态 close → 释放锁 → 运维日志落稳。 */
  shutdown: () => Promise<void>
}

/** 抢锁后、装配前的三处 GC（③ 插件缓存 / ④ 插件数据 / ③ 物化目录）：失败不致命，只记运维日志。 */
function gcBeforeAssembly(
  paths: HostPaths,
  world: World,
  safeAppendLifecycle: (record: LifecycleRecord) => void,
): void {
  const logGcFailure = (reason: string): void => {
    safeAppendLifecycle({ at: Date.now(), kind: 'host', event: 'gc_failed', reason })
  }
  try {
    gcPluginState(paths.pluginsDir, world)
  } catch (err) {
    logGcFailure(err instanceof Error ? err.message : String(err))
  }
  try {
    const report = gcPluginData(paths.dataDir, world)
    if (report.failed.length > 0) logGcFailure(`data:${report.failed.length}`)
  } catch (err) {
    logGcFailure(err instanceof Error ? err.message : String(err))
  }
  try {
    const report = gcMaterialized(paths.materializedDir, world)
    if (report.failed.length > 0) logGcFailure(`materialized:${report.failed.length}`)
  } catch (err) {
    logGcFailure(err instanceof Error ? err.message : String(err))
  }
}

export async function bootstrapHost(options: BootstrapOptions): Promise<BootstrappedHost> {
  const lock = acquireLock(options.paths.lockFile, options.startedAt)
  if (!lock.ok) throw new Error('writer_busy')

  let wired: WiredHost | undefined
  let writer: WorldWriter | undefined
  let audits: AuditStore | undefined
  let setAuditTierWorld: (world: World) => void = () => {}
  let stopped = false

  const release = (): void => {
    releaseLock(options.paths.lockFile, lock.info)
    try {
      // 停机 / 启动失败都收口：排空并落稳运维日志，避免证据随进程退出丢失
      flushLifecycleSync(options.paths.lifecycleFile)
    } catch {
      // 日志落稳失败不改变结果
    }
  }

  try {
    const anchor = loadAnchor(
      options.paths.journalFile,
      options.paths.baseFile,
      options.paths.coldDir,
    )
    // 撕裂尾修复：容错读已丢弃末条半截 entry，这里在持锁下把文件截到有效前缀，
    // 否则下一次 append 会把新 entry 粘在残行上，被后续容错读当末行丢弃、终致 journal 永久损坏。
    if (anchor.journalTruncated) {
      truncateSync(options.paths.journalFile, anchor.journalValidBytes)
      options.safeAppendLifecycle({
        at: Date.now(),
        kind: 'host',
        event: 'journal_tail_repaired',
        reason: String(anchor.journalValidBytes),
      })
    }
    // 只读审计面：审计写旁路侧存（不进世界），启动时由侧存重建内存索引。
    // 保留分档按当前世界的 `schema.audit_tier` 声明解析；声明随世代变，故用可变世界引用，插入时现查。
    let auditTierWorld: World = anchor.world
    audits = AuditStore.open(options.paths.auditFile, {
      tierBudgetOf: (port) =>
        typeof port === 'string' ? resolveAuditTier(auditTierWorld, port) : undefined,
    })
    // 历史审计一次性回填：升级前写入的审计 def 从未进侧存，首启扫描全链 + base world defs 导入
    // （受保留窗口约束，`state/audit/meta.json` 标记幂等）。回填是旁路：失败不阻断启动，下次再试。
    if (readAuditBackfillMeta(options.paths.auditMetaFile) === null) {
      try {
        backfillAuditStore(
          options.paths,
          anchor.world,
          readAllEntries(options.paths.journalFile, options.paths.coldDir),
          audits,
        )
      } catch {
        // 回填失败只损失历史审计可见性，不影响世界 / 链 / 启动
      }
    }
    // G6 启动压缩：尾段达到阈值即追加快照 entry + 归档前缀 + 写基础世界（世界不变，链头推进到快照）。
    // 归档前缀只取**当前 journal**（未归档部分）：回落全链时 `anchor.entries` 可能是全链，不能整段再归档。
    const compactTailEntries = options.compactTailEntries ?? DEFAULT_COMPACT_TAIL_ENTRIES
    let initialWorld: World = anchor.world
    let initialHead: Head = anchor.head
    if (compactTailEntries > 0 && anchor.entries.length >= compactTailEntries) {
      // 有界化回收需要**全量世界**的 world_rev（快照 entry 自校 + full verify 用），
      // 故基础世界已被回收（子世界）时从冷段 + 尾段全链重放一次；未回收时直接用载入世界。
      const baseWorld = anchor.pruned
        ? replayFull(readAllEntries(options.paths.journalFile, options.paths.coldDir))
        : anchor.world
      const compacted = compactWorld(
        options.paths,
        baseWorld,
        anchor.head,
        readJournal(options.paths.journalFile),
        Date.now(),
        { genWindow: DEFAULT_GEN_RETENTION, flattenChain: DEFAULT_FLATTEN_CHAIN },
      )
      initialWorld = compacted.world
      initialHead = { seq: compacted.snapshot.seq, hash: compacted.snapshot.hash }
    }
    auditTierWorld = initialWorld
    setAuditTierWorld = (world: World): void => {
      auditTierWorld = world
    }
    // 落账互斥段：多个 run 可并发推进，只有「追加 journal + 推进世界 / 链头」经它串行。
    writer = new WorldWriter({ world: initialWorld, head: initialHead })
    gcBeforeAssembly(options.paths, writer.snapshot().world, options.safeAppendLifecycle)
    wired = await options.wire({
      writer,
      audits,
      world: writer.snapshot().world,
      head: writer.snapshot().head,
      setAuditTierWorld,
    })
    const started = writer
    const store = audits
    return {
      writer: started,
      audits: store,
      runtime: wired.runtime,
      setAuditTierWorld,
      shutdown: async (): Promise<void> => {
        if (stopped) return
        stopped = true
        release()
      },
    }
  } catch (err) {
    release()
    throw err
  }
}
