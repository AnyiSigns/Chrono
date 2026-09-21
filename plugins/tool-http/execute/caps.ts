// 工具能力声明的默认形状：fs 只读不写（本插件不触盘），网络档按工具语义分。
// websearch 只打 schema 声明的源清单（limited）；webfetch 可打任意 URL（all）。

import type { Rec } from './types.ts'

export const NET_WEBSEARCH = 'limited'
export const NET_WEBFETCH = 'all'

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MEM_MB = 512
const DEFAULT_OUTPUT_MAX = 1048576
const DEFAULT_PROCS_MAX = 8

/** 工具默认 caps：对象形、含 fs.read。 */
export function defaultCaps(net: string, outputMax = DEFAULT_OUTPUT_MAX): Rec {
  return {
    fs: { read: 'none', write: 'none' },
    net,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    mem_mb: DEFAULT_MEM_MB,
    output_max: outputMax,
    procs_max: DEFAULT_PROCS_MAX,
  }
}

/** 本次执行的 caps：以调用方随 bag 传入的声明为基，只覆盖本次 net 档。 */
export function execCaps(declared: Rec | undefined, net: string, outputMax: number): Rec {
  if (declared === undefined) return defaultCaps(net, outputMax)
  return { ...declared, net }
}
