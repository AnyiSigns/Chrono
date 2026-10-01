// 无进展空转检测（确定性纯函数，无时钟 / 无随机，保重放一致）。
//
// 行业共识（OpenHands StuckDetector / smolagents+RunGuard / Claude Lab / loopcanary）：
// 主信号不是「同一个工具」，而是「同一动作 + 同一观察（结果）」，外加短周期交替与窗口内低新颖；
// 单纯的动作指纹会漏掉「参数微改但每次同样报错」这类真卡死。故签名 = 动作 + 观察 + 状态增量。
//
// 签名只用于**相等性比较**（repeat / cycle / low_novelty），故取内容摘要、不留正文：签名会被写进每个段
// checkpoint，正文（工具 args / 结果全文）内嵌会让回合日志随输出体积反复复制、撑爆读取帧。

import { H } from './hash.ts'
import type { Json, Rec } from './types.ts'

/** 归一化时剔除的易变键：时间戳 / 耗时 / 请求标识 / 临时标识等不承载进展语义的字段。 */
const VOLATILE_KEYS = new Set([
  'timestamp',
  'time',
  'ts',
  'created_at',
  'updated_at',
  'started_at',
  'ended_at',
  'start_time',
  'end_time',
  'duration',
  'duration_ms',
  'elapsed',
  'elapsed_ms',
  'latency',
  'latency_ms',
  'request_id',
  'trace_id',
  'span_id',
  'pid',
])

/** 递归剔除易变键（对象键排序），使「同一动作/结果」在不同段可比。 */
export function stripVolatile(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value === null || typeof value !== 'object') return value
  const record = value as Rec
  const out: Rec = {}
  for (const key of Object.keys(record).sort()) {
    if (VOLATILE_KEYS.has(key)) continue
    out[key] = stripVolatile(record[key])
  }
  return out
}

export interface SegmentPart {
  /** 本段模型派发的工具调用。 */
  calls: Rec[]
  /** 本段工具结果（tool.dispatch 输出）。 */
  results: Json[]
  /** 状态增量（progress oracle）：todo 完成数 / verify 结果等。 */
  state: Rec
}

/** 段签名的内容哈希：动作（tool + 规范化 args）+ 观察（成功位 + 结果/错误主体）+ 状态增量。 */
export function segmentSignature(part: SegmentPart): string {
  const actions = part.calls.map((call) => [
    call['tool'] ?? call['port'] ?? null,
    stripVolatile((call['args'] ?? null) as Json),
  ])
  const observations = part.results.map((result) => {
    const record =
      result !== null && typeof result === 'object' && !Array.isArray(result)
        ? (result as Rec)
        : null
    if (record === null) return stripVolatile(result)
    return {
      ok: record['ok'] ?? null,
      out: stripVolatile((record['result'] ?? record['error'] ?? null) as Json),
    }
  })
  return H({ a: actions as Json, o: observations as Json, s: stripVolatile(part.state) })
}

export interface StallVerdict {
  kind: 'repeat' | 'cycle' | 'low_novelty'
  detail: string
}

/**
 * 检测空转。`window` 末尾是**本段**签名，前面是历史段（调用方保证末尾为最新）。
 * - repeat：末尾连续 `repeatN` 段签名完全相同；
 * - cycle：末尾 2..4 周期、每周期重复 2 次（A-B-A-B 型乒乓）；
 * - low_novelty：最近 `noveltyWindow` 段内不同签名数 ≤ `noveltyMin`（小幅改写仍原地打转）。
 */
export function detectStall(
  window: string[],
  repeatN: number,
  noveltyWindow: number,
  noveltyMin: number,
): StallVerdict | null {
  if (repeatN > 0 && window.length >= repeatN) {
    const tail = window.slice(-repeatN)
    if (tail.every((sig) => sig === tail[0])) {
      return { kind: 'repeat', detail: `same signature x${repeatN}` }
    }
  }
  for (let period = 2; period <= 4; period += 1) {
    if (window.length >= period * 2) {
      const tail = window.slice(-period * 2)
      let periodic = true
      for (let i = 0; i < period; i += 1) {
        if (tail[i] !== tail[i + period]) {
          periodic = false
          break
        }
      }
      if (periodic) return { kind: 'cycle', detail: `period ${period} x2` }
    }
  }
  if (noveltyWindow > 0 && window.length >= noveltyWindow) {
    const distinct = new Set(window.slice(-noveltyWindow)).size
    if (distinct <= noveltyMin) {
      return { kind: 'low_novelty', detail: `${distinct}/${noveltyWindow} distinct` }
    }
  }
  return null
}
