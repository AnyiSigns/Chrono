// 会话表：状态住宿主侧进程内（③ 可重算，不进世界、不参与哈希）。
// 会话 id 由帧 `env.run` + 序号确定性派生（不用随机，保可回放）；空闲超 TTL 自动回收；
// `close` 显式关、服务退出 / 断连全关——不泄漏浏览器进程。

import { log } from './frames.ts'
import { ToolError } from './types.ts'
import type { BrowserEngine, EngineConfig } from './engine/types.ts'
import type { ViewportConfig } from './config.ts'

/** 引擎工厂：按配置造一个已就绪的引擎实例（生产 = createEngine，单测 = 假引擎）。 */
export type EngineFactory = (config: EngineConfig) => Promise<BrowserEngine>

export interface SessionRecord {
  id: string
  engine: BrowserEngine
  lastUsedAt: number
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly createEngine: EngineFactory
  private readonly baseConfig: EngineConfig
  private readonly idleMs: number
  private seq = 0

  constructor(createEngine: EngineFactory, baseConfig: EngineConfig, idleMs: number) {
    this.createEngine = createEngine
    this.baseConfig = baseConfig
    this.idleMs = idleMs
  }

  /** `open`：回收过期会话后新开一个；id 由 run + 序号派生。 */
  async open(run: string | null, now: number, viewport?: ViewportConfig): Promise<string> {
    this.reap(now)
    const id = `${run ?? 'run'}~${(this.seq += 1)}`
    const config = viewport === undefined ? this.baseConfig : { ...this.baseConfig, viewport }
    const engine = await this.createEngine(config)
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

  /** 服务退出 / 断连：关闭全部会话（不泄漏进程）。 */
  async closeAll(): Promise<void> {
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const results = await Promise.allSettled(records.map((record) => record.engine.close()))
    for (const result of results) {
      if (result.status === 'rejected') log(`close session failed: ${(result.reason as Error).message}`)
    }
  }

  /**
   * 硬杀兜底（进程 `exit` / 信号）：同步尽力终止全部会话的浏览器子进程 / 句柄。
   * `exit` 事件里不能 await，故走引擎的同步 `kill()`；失败只记日志，不阻断退出。
   */
  killAllSync(): void {
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
