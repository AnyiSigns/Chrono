// H6 定时触发：宿主按插件 `schema` 里的 `periodic` 声明构造一次 run。
// 本模块只做「读声明 + 计时 + 单条目并发去重」；run 的构造（命令入口 / 能力方法 + 投影 bag
// 机械注入）由宿主注入的 `onFire` 完成——宿主不认识业务，只按声明周期触发。

import type { Json, World } from '../kernel/index.ts'

/** 周期方法所需的一段投影：`key` 是 bag 里的键，`path` 是投影内的字面路径。 */
export interface PeriodicRead {
  key: string
  path: Json[]
}

export interface PeriodicEntry {
  identity: string
  /** 二选一：命令名（按声明的入口 term 起一次 run）或能力方法名（直接调该服务方法）。 */
  command?: string
  method?: string
  everyMs: number
  reads: PeriodicRead[]
}

export interface PeriodicSchedulerDeps {
  /** 到点触发一次；宿主负责起 run 与错误收口。 */
  onFire: (entry: PeriodicEntry) => void | Promise<void>
  /** 声明非法（跳过该条，不阻断其余）：身份 + 原因。 */
  onInvalid?: (identity: string, reason: string) => void
}

interface Scheduled {
  entry: PeriodicEntry
  signature: string
  timer: NodeJS.Timeout
  inFlight: boolean
}

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JS 原型键：bag 键 / 投影路径段出现即拒（否则赋值改原型、读取拿到函数）。 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** 解析一条 `periodic` 声明；不合法返回原因字符串。 */
function parseEntry(identity: string, raw: Json): PeriodicEntry | string {
  if (!isRecord(raw)) return 'not_object'
  const command = raw['command']
  const method = raw['method']
  const hasCommand = typeof command === 'string' && command.length > 0
  const hasMethod = typeof method === 'string' && method.length > 0
  if (hasCommand === hasMethod) return 'bad_target'
  const everyMs = raw['every_ms']
  if (typeof everyMs !== 'number' || !Number.isInteger(everyMs) || everyMs <= 0) {
    return 'bad_every_ms'
  }
  const reads: PeriodicRead[] = []
  const rawReads = raw['reads']
  if (rawReads !== undefined) {
    if (!isRecord(rawReads)) return 'bad_reads'
    for (const [key, path] of Object.entries(rawReads)) {
      if (UNSAFE_KEYS.has(key) || !Array.isArray(path)) return 'bad_reads'
      if (path.some((segment) => typeof segment === 'string' && UNSAFE_KEYS.has(segment))) {
        return 'bad_reads'
      }
      reads.push({ key, path })
    }
  }
  const entry: PeriodicEntry = { identity, everyMs, reads }
  if (hasCommand) entry.command = command as string
  else entry.method = method as string
  return entry
}

/**
 * 从世界里读全部周期声明（按身份 id 排序，确定性）：`schema` def body 的顶层 `periodic` 数组。
 * 身份 retired（`active=null`）跳过；声明非法只记 invalid，不影响其余。
 */
export function readPeriodicEntries(world: World): {
  entries: PeriodicEntry[]
  invalid: { identity: string; reason: string }[]
} {
  const entries: PeriodicEntry[] = []
  const invalid: { identity: string; reason: string }[] = []
  for (const identity of Object.keys(world.ids).sort()) {
    const record = world.ids[identity]
    if (record.active === null) continue
    const body = world.defs[record.schema]?.body
    if (!isRecord(body)) continue
    const periodic = body['periodic']
    if (periodic === undefined) continue
    if (!Array.isArray(periodic)) {
      invalid.push({ identity, reason: 'bad_periodic' })
      continue
    }
    for (const raw of periodic) {
      const parsed = parseEntry(identity, raw)
      if (typeof parsed === 'string') invalid.push({ identity, reason: parsed })
      else entries.push(parsed)
    }
  }
  return { entries, invalid }
}

function signatureOf(entry: PeriodicEntry): string {
  return JSON.stringify({
    command: entry.command ?? null,
    method: entry.method ?? null,
    everyMs: entry.everyMs,
    reads: entry.reads,
  })
}

/**
 * 周期调度器：`sync(world)` 增量对齐声明（新增 / 删除 / 改周期），计时器跨 sync 保留，
 * 故每轮落账触发的 `applyWorld` 不会重置周期。`stop()` 清全部计时器。
 */
export class PeriodicScheduler {
  private readonly scheduled = new Map<string, Scheduled>()
  private readonly deps: PeriodicSchedulerDeps
  private stopped = false

  constructor(deps: PeriodicSchedulerDeps) {
    this.deps = deps
  }

  sync(world: World): void {
    // 停机后不再排程：在途 run 收尾仍会触发 applyWorld → sync，不得复活计时器
    if (this.stopped) return
    const { entries, invalid } = readPeriodicEntries(world)
    for (const item of invalid) this.deps.onInvalid?.(item.identity, item.reason)
    // 键 = 身份 + 该身份内的序号（不用全局下标：别的身份增删条目不得重置本身份的计时器）
    const desired = new Map<string, { entry: PeriodicEntry; signature: string }>()
    const ordinalOf = new Map<string, number>()
    for (const entry of entries) {
      const ordinal = ordinalOf.get(entry.identity) ?? 0
      ordinalOf.set(entry.identity, ordinal + 1)
      desired.set(`${entry.identity}\u0000${ordinal}`, { entry, signature: signatureOf(entry) })
    }
    for (const [key, current] of this.scheduled) {
      const next = desired.get(key)
      if (next === undefined || next.signature !== current.signature) {
        clearInterval(current.timer)
        this.scheduled.delete(key)
      }
    }
    for (const [key, next] of desired) {
      if (this.scheduled.has(key)) continue
      const timer = setInterval(() => this.fire(key), next.entry.everyMs)
      timer.unref?.()
      this.scheduled.set(key, {
        entry: next.entry,
        signature: next.signature,
        timer,
        inFlight: false,
      })
    }
  }

  stop(): void {
    this.stopped = true
    for (const current of this.scheduled.values()) clearInterval(current.timer)
    this.scheduled.clear()
  }

  private fire(key: string): void {
    const current = this.scheduled.get(key)
    // 条目可能已在 sync / stop 时移除；单条目并发去重：上一拍未结束则跳过本拍
    if (current === undefined || current.inFlight) return
    current.inFlight = true
    // onFire 同步抛错不得逃出计时器回调（否则进程级未捕获异常）；收进 promise 链
    Promise.resolve()
      .then(() => this.deps.onFire(current.entry))
      .catch(() => {
        // 触发失败由宿主 onFire 自行记录；这里只保证 inFlight 复位
      })
      .finally(() => {
        const latest = this.scheduled.get(key)
        if (latest !== undefined) latest.inFlight = false
      })
  }
}
