// 会话表：状态住宿主侧进程内（③ 可重算，不进世界、不参与哈希）。
// 会话 id 由帧 `env.run` + 序号确定性派生（不用随机，保可回放）；空闲超 TTL 自动回收；
// `close` 显式关、服务退出 / 断连全关——不泄漏浏览器进程。

import { CreationHandle } from './creation.ts'
import { log } from './frames.ts'
import { ToolError } from './types.ts'
import type { BrowserEngine, EngineConfig } from './engine/types.ts'
import type { ViewportConfig } from './config.ts'

/**
 * 引擎工厂：按配置造一个已就绪的引擎实例（生产 = createEngine，单测 = 假引擎）。
 * `handle` 供工厂登记建引擎途中可同步硬杀的中间态（见 creation.ts）。
 */
export type EngineFactory = (config: EngineConfig, handle: CreationHandle) => Promise<BrowserEngine>

export interface SessionRecord {
  id: string
  engine: BrowserEngine
  lastUsedAt: number
}

/** 在途建引擎：句柄供 `killAllSync` 同步触达，promise 供 `closeAll` 等落地。 */
interface PendingCreation {
  handle: CreationHandle
  promise: Promise<BrowserEngine>
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly createEngine: EngineFactory
  private readonly baseConfig: EngineConfig
  private readonly idleMs: number
  private readonly pending = new Set<PendingCreation>()
  private closing = false
  private seq = 0

  constructor(createEngine: EngineFactory, baseConfig: EngineConfig, idleMs: number) {
    this.createEngine = createEngine
    this.baseConfig = baseConfig
    this.idleMs = idleMs
  }

  /**
   * `open`：回收过期会话后新开一个；id 由 run + 序号派生。
   * 建引擎的 promise 与硬杀句柄在 await 前一起登记进 `pending`：
   * `closeAll` 等它落地后关闭，`killAllSync` 在 `exit` 里同步硬杀；
   * await 返回时若已被硬杀 / 已进入 closing，则由接管方关闭并在此拒绝（不把孤儿会话登记进表）。
   */
  async open(run: string | null, now: number, viewport?: ViewportConfig): Promise<string> {
    if (this.closing) throw new ToolError('tool_failed', 'session manager is closing')
    this.reap(now)
    const id = `${run ?? 'run'}~${(this.seq += 1)}`
    const config = viewport === undefined ? this.baseConfig : { ...this.baseConfig, viewport }
    const handle = new CreationHandle()
    const creation: PendingCreation = { handle, promise: this.createEngine(config, handle) }
    this.pending.add(creation)
    let engine: BrowserEngine
    try {
      engine = await creation.promise
    } finally {
      this.pending.delete(creation)
    }
    if (handle.isAborted) {
      // 硬杀路径已 abort：引擎落地即补一次 kill（幂等），本次 open 作废。
      try {
        engine.kill()
      } catch (err) {
        log(`kill aborted session failed: ${(err as Error).message}`)
      }
      throw new ToolError('tool_failed', 'session manager is closing')
    }
    if (this.closing) {
      // 引擎已交给 `closeAll`（它 await 了同一个 promise）关闭；本次 open 作废。
      throw new ToolError('tool_failed', 'session manager is closing')
    }
    this.sessions.set(id, { id, engine, lastUsedAt: now })
    return id
  }

  /** 取会话；过期或未知 → session_not_found。 */
  get(id: string, now: number): SessionRecord {
    this.reap(now)
    const record = this.sessions.get(id)
    if (record === undefined) {
      throw new ToolError('session_not_found', `unknown or expired session ${id}`)
    }
    return record
  }

  /** 刷新最近使用时间。 */
  touch(id: string, now: number): void {
    const record = this.sessions.get(id)
    if (record !== undefined) record.lastUsedAt = now
  }

  /** 显式关闭；未知 / 已回收 → session_not_found。 */
  async close(id: string, now: number): Promise<boolean> {
    this.reap(now)
    const record = this.sessions.get(id)
    if (record === undefined) {
      throw new ToolError('session_not_found', `unknown or expired session ${id}`)
    }
    this.sessions.delete(id)
    await record.engine.close()
    return true
  }

  /**
   * 服务退出 / 断连：关闭全部会话（不泄漏进程）。
   * 先置 `closing` 并等在途 `open` 的引擎落地，再逐个关闭——否则建引擎途中退出会留下孤儿浏览器。
   */
  async closeAll(): Promise<void> {
    this.closing = true
    const settled = await Promise.allSettled([...this.pending].map((creation) => creation.promise))
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        await result.value
          .close()
          .catch((err: unknown) => log(`close pending session failed: ${(err as Error).message}`))
      }
    }
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const results = await Promise.allSettled(records.map((record) => record.engine.close()))
    for (const result of results) {
      if (result.status === 'rejected') log(`close session failed: ${(result.reason as Error).message}`)
    }
  }

  /**
   * 硬杀兜底（进程 `exit` / 信号）：同步尽力终止全部会话**及在途建引擎**的浏览器子进程 / 句柄。
   * `exit` 事件里不能 await，故走同步 `kill()`：在途创建经句柄触达已 spawn 的浏览器子进程，
   * 落地后尚未入册的引擎由 `open` 的 abort 分支补杀；失败只记日志，不阻断退出。
   */
  killAllSync(): void {
    this.closing = true
    for (const creation of [...this.pending]) creation.handle.kill()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    for (const record of records) {
      try {
        record.engine.kill()
      } catch (err) {
        log(`kill session failed: ${(err as Error).message}`)
      }
    }
  }

  /** 空闲超 TTL 的会话移出并异步关闭。 */
  reap(now: number): void {
    for (const record of [...this.sessions.values()]) {
      if (now - record.lastUsedAt > this.idleMs) {
        this.sessions.delete(record.id)
        void record.engine.close().catch((err: unknown) => log(`reap session failed: ${(err as Error).message}`))
      }
    }
  }

  /** 当前在册会话数（诊断 / 测试用）。 */
  get size(): number {
    return this.sessions.size
  }
}
