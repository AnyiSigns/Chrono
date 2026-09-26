// 在册 run 的登记与逐轮非回退时钟：并发推进中的 run 在此登记，`cancel{run}` 与停机按此表中止。
// `run.started` / `run.finished` 成对收口（`finished` 幂等、恰好一次；异常路径也以 refused 收口）。

import type { Json } from '../kernel/index.ts'
import type { Limits } from './wire.ts'

/** 入站面广播回调：宿主自身事件与插件事件同路，`impl = "host"` 表宿主事件。 */
export type BroadcastFn = (impl: string, topic: string, payload: Json) => void

/** 发起者未给 limits 时的宿主默认预算。 */
export const DEFAULT_LIMITS: Limits = { gas: 1_000_000, depth: 64 }

/** detached run 并发上限：无调用方等待，超限即拒，防单个插件无限起后台 run 拖垮宿主。 */
export const MAX_DETACHED_RUNS = 32

export interface RunLifecycle {
  /** 广播 `run.started`；由调用方在起 run 前调用一次。 */
  started: () => void
  /** 广播 `run.finished`；幂等——重复调用只发一次。 */
  finished: (status: string, reasons: string[]) => void
}

/**
 * 建立一对 run 生命周期事件：`started()` 发 `run.started`，`finished()` 发 `run.finished`。
 * 只读命令不广播生命周期，故由调用方决定是否建立；建立后 `finished` 恰好一次。
 */
export function beginRun(
  broadcast: BroadcastFn,
  payload: { run: string; thread: string | null; origin: string; name?: string },
): RunLifecycle {
  let finished = false
  return {
    started: () => {
      broadcast('host', 'run.started', payload as unknown as Json)
    },
    finished: (status, reasons) => {
      if (finished) return
      finished = true
      broadcast('host', 'run.finished', { ...payload, status, reasons } as unknown as Json)
    },
  }
}

/**
 * 在册 run 表：`inflight` 在途任务 / `runs` 取消控制器 / `detached` 并发计数 / `nextNow` 非回退时钟。
 * 只做登记与时钟，不解释 run 语义；生命周期事件的成对收口见 `beginRun`。
 */
export class RunRegistry {
  private readonly inflight = new Set<Promise<void>>()
  private readonly runs = new Map<string, AbortController>()
  private readonly detached = new Set<string>()
  private lastNow: number

  constructor(startedAt: number) {
    this.lastNow = startedAt
  }

  /** 逐轮时间戳非回退：时钟回拨时仍单调 +1。 */
  nextNow(): number {
    const now = Date.now()
    this.lastNow = now > this.lastNow ? now : this.lastNow + 1
    return this.lastNow
  }

  register(runId: string, controller: AbortController): void {
    this.runs.set(runId, controller)
  }

  unregister(runId: string): void {
    this.runs.delete(runId)
  }

  /** 中止一个在册 run；未知 / 已结束返回 false。 */
  abort(run: string): boolean {
    const controller = this.runs.get(run)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** 停机：中止全部在册 run。 */
  abortAll(): void {
    for (const controller of this.runs.values()) controller.abort()
  }

  track(task: Promise<void>): void {
    this.inflight.add(task)
  }

  untrack(task: Promise<void>): void {
    this.inflight.delete(task)
  }

  /** 等全部在途 run 收敛（审计 / 业务写不落在停机中途）。 */
  settle(): Promise<void> {
    return Promise.allSettled([...this.inflight]).then(() => undefined)
  }

  detachedCount(): number {
    return this.detached.size
  }

  addDetached(runId: string): void {
    this.detached.add(runId)
  }

  removeDetached(runId: string): void {
    this.detached.delete(runId)
  }
}
