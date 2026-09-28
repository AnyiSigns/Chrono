// token 账校准：解析真实用量（含缓存命中），维护每模型校正系数并持久化为可重算状态。
// 快路径（原生估算器）的计数按系数缩放；系数 = 真实 prompt_tokens / 估算 token 的指数滑动平均。
// 状态落 `CHRONO_PLUGIN_STATE/calibration.json`（③ 可重算，可随时删）；无该目录时只在本进程内累积。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageManifest } from './types.ts'

/** 指数滑动平均权重与系数上下限（防止单次异常把系数拉飞）。 */
const EWMA_WEIGHT = 0.2
const FACTOR_MIN = 0.5
const FACTOR_MAX = 2

interface ModelCalibration {
  factor: number
  last_estimate: number
}

type CalibrationState = Record<string, ModelCalibration>

const PROMPT_KEYS = ['prompt_tokens', 'input_tokens', 'inputTokens'] as const
const CACHED_KEYS = ['cached_tokens', 'cache_read_input_tokens', 'prompt_cache_hit_tokens'] as const
const CACHE_CREATION_KEYS = ['cache_creation_input_tokens'] as const
const COMPLETION_KEYS = ['completion_tokens', 'output_tokens', 'outputTokens'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

/**
 * 解析模型回包的真实用量：`prompt_tokens` + 各厂商缓存命中字段 + 完成 token。
 * 缓存命中率由此可观测。无 `prompt_tokens` 返回 null。
 */
export function parseUsage(value: unknown): UsageManifest | null {
  if (!isRecord(value)) return null
  const prompt = firstNumber(value, PROMPT_KEYS)
  if (prompt === null) return null
  let cached = 0
  for (const key of CACHED_KEYS) {
    const hit = firstNumber(value, [key])
    if (hit !== null) cached += hit
  }
  const creation = firstNumber(value, CACHE_CREATION_KEYS) ?? 0
  const completion = firstNumber(value, COMPLETION_KEYS) ?? 0
  return {
    prompt_tokens: prompt,
    cached_tokens: cached,
    cache_creation_tokens: creation,
    completion_tokens: completion,
    hit_rate: prompt > 0 ? cached / prompt : null,
    correction_factor: null,
  }
}

function stateFile(): string | null {
  const dir = process.env.CHRONO_PLUGIN_STATE
  if (typeof dir !== 'string' || dir.length === 0) return null
  return join(dir, 'calibration.json')
}

let memory: CalibrationState = {}

function load(): CalibrationState {
  const file = stateFile()
  if (file === null || !existsSync(file)) return memory
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(parsed)) return memory
    const state: CalibrationState = {}
    for (const [model, entry] of Object.entries(parsed)) {
      if (!isRecord(entry)) continue
      const factor = firstNumber(entry, ['factor'])
      const lastEstimate = firstNumber(entry, ['last_estimate'])
      if (factor === null || lastEstimate === null) continue
      state[model] = { factor, last_estimate: lastEstimate }
    }
    memory = state
    return state
  } catch {
    return memory
  }
}

function save(state: CalibrationState): void {
  memory = state
  const file = stateFile()
  if (file === null) return
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(state), 'utf8')
  } catch {
    // 状态可重算：写盘失败只影响跨重启累积，不阻断组装。
  }
}

/** 当前生效的每模型校正系数；无则 1。 */
export function correctionFactor(model: string): number {
  const entry = load()[model]
  return entry === undefined ? 1 : entry.factor
}

function clamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, value))
}

/**
 * 记录本次组装的估算 token，并用真实用量更新该模型的系数。
 * @param estimate 本次组装（按旧系数缩放后）的 token 估算，供下次比对。
 * @param usage 本次组装前收到的真实用量；无则只更新 last_estimate。
 */
export function observeUsage(model: string, estimate: number, usage: UsageManifest | null): number {
  const state = load()
  const entry = state[model] ?? { factor: 1, last_estimate: 0 }
  let factor = entry.factor
  if (usage !== null && usage.prompt_tokens > 0 && entry.last_estimate > 0) {
    const ratio = usage.prompt_tokens / entry.last_estimate
    factor = clamp(entry.factor * (1 - EWMA_WEIGHT + EWMA_WEIGHT * ratio))
  }
  state[model] = { factor, last_estimate: estimate }
  save(state)
  return factor
}

/** 测试用：清空内存态（落盘态由测试环境无 `CHRONO_PLUGIN_STATE` 规避）。 */
export function resetCalibration(): void {
  memory = {}
}
