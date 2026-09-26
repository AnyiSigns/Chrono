// 宿主启动选项：调用超时解析（F7）、服务启动包装器（宿主侧最小沙箱形态）与源码 watcher 开关。
// 口径：显式（`--call-timeout-ms` / `--start-wrapper` / `--watch`）> 环境（`CHRONO_*`）> 常量 / 无。
// 纯函数：host 入口与 boot start 共用同一份，避免两处解析漂移；非法值 fail-closed。

import type { Json } from '../kernel/index.ts'
import { PROTOTYPE_KEYS } from './common/json.ts'
import { DEFAULT_CALL_TIMEOUT_MS } from './effect/run-loop.ts'
import { MAX_CALL_TIMEOUT_MS } from './service-link.ts'

/** 入口 flag 语法（boot CLI 与宿主入口共用同一份解析，避免语义漂移）。 */
export interface EntryOptions {
  root?: string
  /** `--call-timeout-ms` 的值；flag 给出但缺值 = ''（交给 `resolveCallTimeoutMs` fail-closed）。 */
  callTimeout?: string
  /** `--start-wrapper` 的值；flag 给出但缺值 = ''（交给 `resolveStartWrapper` fail-closed）。 */
  startWrapper?: string
  /** `--watch`：布尔旗标，出现即 true（源码 watcher，默认关）。 */
  watch?: boolean
  rest: string[]
}

const ENTRY_FLAGS: ReadonlySet<string> = new Set(['--root', '--call-timeout-ms', '--start-wrapper'])

/**
 * 解析入口 argv：`--root <v>` / `--call-timeout-ms <v>` / `--start-wrapper <v>` 摘出，其余按序进 `rest`。
 * 已知 flag 缺值（后随另一个 flag 或到末尾）→ 记为 present + 无值：不吞下一枚 flag、不静默进 rest。
 */
export function parseEntryArgv(argv: string[]): EntryOptions {
  const out: EntryOptions = { rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    // 布尔旗标不吞下一枚 token：`--watch` 后随的命令 / 路径照常进 rest
    if (token === '--watch') {
      out.watch = true
      continue
    }
    if (!ENTRY_FLAGS.has(token)) {
      out.rest.push(token)
      continue
    }
    const next = i + 1 < argv.length ? argv[i + 1] : undefined
    const value = next !== undefined && !next.startsWith('--') ? next : undefined
    if (value !== undefined) i += 1
    if (token === '--root') {
      if (value !== undefined) out.root = value
      continue
    }
    if (token === '--start-wrapper') {
      out.startWrapper = value ?? ''
      continue
    }
    out.callTimeout = value ?? ''
  }
  return out
}

/**
 * 解析调用超时（毫秒）。
 * @param explicit `--call-timeout-ms` 的值；给出但非法（含空串 / 非正整数 / 超过计时器硬上限）→ 抛 `bad_call_timeout`
 * @param env `CHRONO_CALL_TIMEOUT_MS` 的值；空串视为未设置
 */
export function resolveCallTimeoutMs(explicit?: string, env?: string): number {
  const raw = explicit ?? (env !== undefined && env.length > 0 ? env : undefined)
  if (raw === undefined) return DEFAULT_CALL_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > MAX_CALL_TIMEOUT_MS) {
    throw new Error(`bad_call_timeout: ${raw}`)
  }
  return value
}

/**
 * 解析服务启动包装器：一个把插件 `start` 包住的命令片段，宿主仍不认识语言。
 * 只影响 spawn 命令行，不参与声明解析、不改 `plugin.json` 契约、不引入特权插件。
 * @param explicit `--start-wrapper` 的值；给出但非法（空串 / 纯空白 / 含 NUL 或换行）→ 抛 `bad_start_wrapper`
 * @param env `CHRONO_START_WRAPPER` 的值；空串视为未设置
 * @returns 未配置 → `undefined`（零行为变化）；否则原样返回包装器命令片段
 */
export function resolveStartWrapper(explicit?: string, env?: string): string | undefined {
  const raw = explicit ?? (env !== undefined && env.length > 0 ? env : undefined)
  if (raw === undefined) return undefined
  if (raw.trim().length === 0 || /[\0\r\n]/.test(raw)) {
    throw new Error(`bad_start_wrapper: ${raw}`)
  }
  return raw
}

/** 布尔真值 / 假值的接受集合（大小写与首尾空白不敏感）；其余值 fail-closed。 */
const WATCH_TRUE = new Set(['1', 'true', 'yes', 'on'])
const WATCH_FALSE = new Set(['0', 'false', 'no', 'off'])

/**
 * 解析源码 watcher 开关。默认关：生产常驻不该无条件监听文件系统，
 * 只有显式 `--watch` 或 `CHRONO_WATCH=<真值>` 才打开。
 * @param explicit `--watch` 是否出现（true = 打开）
 * @param env `CHRONO_WATCH` 的值；空串视为未设置；无法识别的值抛 `bad_watch`（fail-closed，不静默当关）
 */
export function resolveWatch(explicit?: boolean, env?: string): boolean {
  if (explicit === true) return true
  if (env === undefined || env.length === 0) return false
  const value = env.trim().toLowerCase()
  if (WATCH_TRUE.has(value)) return true
  if (WATCH_FALSE.has(value)) return false
  throw new Error(`bad_watch: ${env}`)
}

/**
 * 解析严格回收开关（离线 `compact --strict`）。默认关：strict 仅在世界引用图完备时安全，
 * 只有显式 `--strict` 或 `CHRONO_COMPACT_STRICT=<真值>` 才打开。
 * @param explicit `--strict` 是否出现（true = 打开）
 * @param env `CHRONO_COMPACT_STRICT` 的值；空串视为未设置；无法识别的值抛 `bad_compact_strict`（fail-closed）
 */
export function resolveCompactStrict(explicit?: boolean, env?: string): boolean {
  if (explicit === true) return true
  if (env === undefined || env.length === 0) return false
  const value = env.trim().toLowerCase()
  if (WATCH_TRUE.has(value)) return true
  if (WATCH_FALSE.has(value)) return false
  throw new Error(`bad_compact_strict: ${env}`)
}

/** 框架运营配置文件：仓库根 `chrono.config.json`。 */
export const CONFIG_FILE = 'chrono.config.json'
/** 受保护 pin 名单在该文件里的键。 */
export const PROTECTED_PINS_KEY = 'protected_pins'
/** 受保护 pin 名单的环境覆盖（逗号分隔）。 */
export const PROTECTED_PINS_ENV = 'CHRONO_PROTECTED_PINS'

/** 受保护 pin 名单解析结果：`declared=false` = 文件 / 键缺失（空集 + 运维日志）。 */
export type ProtectedPinsResolution =
  | { ok: true; identities: string[]; declared: boolean }
  | { ok: false; reason: 'bad_protected_pins' }

/** 逗号分隔名单：任一项为空串 / 原型键 → 非法；整体空串由调用方视为未设置。 */
function parseProtectedPinList(raw: string): string[] | null {
  const items = raw.split(',').map((item) => item.trim())
  if (items.some((item) => item.length === 0 || PROTOTYPE_KEYS.has(item))) return null
  return items
}

/** 文件里的名单：必须是字符串数组、无空串项 / 原型键项；否则非法。 */
function parseProtectedPinValue(value: Json): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || PROTOTYPE_KEYS.has(item)) return null
    out.push(item)
  }
  return out
}

/**
 * 解析受保护 pin 名单，优先级 **显式 > 环境 `CHRONO_PROTECTED_PINS` > 文件 `protected_pins`**。
 * 空串（显式 / 环境）视为未设置；文件缺失 / 键缺失 → 空集且 `declared:false`（fail-open，配兜底测试）；
 * 形态非法（非字符串数组 / 原型键 / 空串项）→ `{ok:false}`，由调用方 fail-closed 拒 `bad_protected_pins`。
 */
export function resolveProtectedPins(
  explicit?: string,
  env?: string,
  fileValue?: Json,
): ProtectedPinsResolution {
  const explicitValue = explicit !== undefined && explicit.length > 0 ? explicit : undefined
  if (explicitValue !== undefined) {
    const parsed = parseProtectedPinList(explicitValue)
    return parsed === null
      ? { ok: false, reason: 'bad_protected_pins' }
      : { ok: true, identities: parsed, declared: true }
  }
  const envValue = env !== undefined && env.length > 0 ? env : undefined
  if (envValue !== undefined) {
    const parsed = parseProtectedPinList(envValue)
    return parsed === null
      ? { ok: false, reason: 'bad_protected_pins' }
      : { ok: true, identities: parsed, declared: true }
  }
  if (fileValue === undefined) return { ok: true, identities: [], declared: false }
  const parsed = parseProtectedPinValue(fileValue)
  return parsed === null
    ? { ok: false, reason: 'bad_protected_pins' }
    : { ok: true, identities: parsed, declared: true }
}
