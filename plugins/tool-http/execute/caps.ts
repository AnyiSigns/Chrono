// 工具能力声明的默认形状：fs 只读不写（本插件不触盘），网络档按工具语义分。
// websearch 只打 schema 声明的源清单（limited）；webfetch 可打任意 URL（all）。
// 执行时间预算与反向等待同源：见 execBudgetMs（保证 host > reverse > exec）。

import { DEFAULT_CALL_TIMEOUT_MS, MAX_EXEC_BUDGET_MS, TIMER_MAX_MS } from './reverse.ts'
import { isRec } from './types.ts'
import type { Rec } from './types.ts'

export const NET_WEBSEARCH = 'limited'
export const NET_WEBFETCH = 'all'

const DEFAULT_MEM_MB = 512
const DEFAULT_OUTPUT_MAX = 1048576
const DEFAULT_PROCS_MAX = 8

/** 工具默认 caps：对象形、含 fs.read。 */
export function defaultCaps(net: string, outputMax = DEFAULT_OUTPUT_MAX): Rec {
  return {
    fs: { read: 'none', write: 'none' },
    net,
    timeout_ms: DEFAULT_CALL_TIMEOUT_MS,
    mem_mb: DEFAULT_MEM_MB,
    output_max: outputMax,
    procs_max: DEFAULT_PROCS_MAX,
  }
}

/**
 * 本次 exec 的时间预算：取声明抓取超时与 caps.timeout_ms（缺省 30s）的较大者，
 * 并 clamp 在反向等待上界内——保证「宿主调用超时 > 反向等待 > 执行」。
 * 反向等待与传给 sandbox 的 `caps.timeout_ms` 共用此预算（同源，不互相击穿）。
 */
export function execBudgetMs(declared: Rec | undefined, specTimeoutMs: number): number {
  const capsTimeout =
    isRec(declared) && typeof declared['timeout_ms'] === 'number' && Number.isFinite(declared['timeout_ms'])
      ? declared['timeout_ms']
      : DEFAULT_CALL_TIMEOUT_MS
  const budget = Math.max(specTimeoutMs, capsTimeout)
  return Math.min(Math.max(budget, 1), MAX_EXEC_BUDGET_MS, TIMER_MAX_MS)
}

/** 本次执行的 caps：以调用方随 bag 传入的声明为基，覆盖本次 net 档与执行时间预算。 */
export function execCaps(
  declared: Rec | undefined,
  net: string,
  outputMax: number,
  budgetMs: number,
): Rec {
  const base = declared === undefined ? defaultCaps(net, outputMax) : { ...declared, net }
  return { ...base, timeout_ms: budgetMs }
}
