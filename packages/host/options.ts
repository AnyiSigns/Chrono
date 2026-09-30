// 宿主启动选项：调用超时解析（F7）、服务启动包装器（宿主侧最小沙箱形态）与源码 watcher 开关。
// 口径：显式（`--call-timeout-ms` / `--start-wrapper` / `--watch`）> 环境（`CHRONO_*`）> 常量 / 无。
// 纯函数：host 入口与 boot start 共用同一份，避免两处解析漂移；非法值 fail-closed。

import type { Json } from '../kernel/index.ts'
import { DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS } from './common/call-timeout.ts'
import { PROTOTYPE_KEYS, isRecord } from './common/json.ts'

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
 * 支持 `--flag value` 与 `--flag=value` 两种形态；`=` 形态下值可含任意字符（含 `--` 开头）。
 * 空格形态的值若以下一枚 flag 开头（`--`）视为缺值：已知 flag 记为 present + 无值（交给各自 resolver
 * fail-closed），不吞下一枚 flag、不静默进 rest。未知 token（含未知 `--flag` / `--flag=value`）原样进
 * `rest`，由调用方按各自口径处置（boot 命令专用 flag 依赖它；宿主入口由 `assertNoEntryRest` fail-closed）。
 */
export function parseEntryArgv(argv: string[]): EntryOptions {
  const out: EntryOptions = { rest: [] }
  const assign = (flag: string, value: string | undefined): void => {
    if (flag === '--root') {
      if (value !== undefined) out.root = value
      return
    }
    if (flag === '--start-wrapper') {
      out.startWrapper = value ?? ''
      return
    }
    out.callTimeout = value ?? ''
  }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    // 布尔旗标不吞下一枚 token：`--watch` 后随的命令 / 路径照常进 rest
    if (token === '--watch') {
      out.watch = true
      continue
    }
    // `--flag=value`：只在已知 flag 上切分（首个 `=`），未知 token 整体进 rest
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    if (eq > 0) {
      const flag = token.slice(0, eq)
      if (!ENTRY_FLAGS.has(flag)) {
        out.rest.push(token)
        continue
      }
      assign(flag, token.slice(eq + 1))
      continue
    }
    if (!ENTRY_FLAGS.has(token)) {
      out.rest.push(token)
      continue
    }
    const next = i + 1 < argv.length ? argv[i + 1] : undefined
    const value = next !== undefined && !next.startsWith('--') ? next : undefined
    if (value !== undefined) i += 1
    assign(token, value)
  }
  return out
}

/**
 * 宿主进程入口不接受位置参数 / 未知 flag：`rest` 只供 boot 派发命令与命令专用 flag。
 * 宿主入口出现 `rest` 即 fail-closed 抛出（不静默忽略），与选项值非法同口径。
 */
export function assertNoEntryRest(rest: readonly string[]): void {
  if (rest.length > 0) throw new Error(`unknown_entry_arg: ${rest[0]}`)
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

/** 生态 profile 在该文件里的键。 */
export const ECOSYSTEM_KEY = 'ecosystem'
/** 生态 profile 的环境覆盖（JSON 文本，与文件同形）。 */
export const ECOSYSTEM_ENV = 'CHRONO_ECOSYSTEM'

/**
 * 生态 profile 可覆盖字段：全部可选，未给即用内建默认（见 `assembly/ecosystem.ts`）。
 * 字段名与配置文件键一一对应（此处为驼峰，配置为下划线）。
 */
export interface EcosystemOverrides {
  lockFiles: string[]
  sourceExcludedNames: string[]
  npmCacheEnvVar: string
  npmCacheDirName: string
  npmAllowRemoteEnvVar: string
  npmAllowRemoteValue: string
  cargoTargetEnvVar: string
  cargoTargetDirName: string
  sdkPackageName: string
  sdkNodeModulesDir: string
  sdkRustDirName: string
  entryExtensions: string[]
}

/** 生态 profile 解析结果：`declared=false` = 文件 / 键缺失（用内建默认，零行为变化）。 */
export type EcosystemResolution =
  | { ok: true; overrides: Partial<EcosystemOverrides>; declared: boolean }
  | { ok: false; reason: 'bad_ecosystem' }

/** 配置键 → 覆盖字段名。 */
const ECOSYSTEM_FIELDS: ReadonlyMap<string, keyof EcosystemOverrides> = new Map([
  ['lock_files', 'lockFiles'],
  ['source_excluded_names', 'sourceExcludedNames'],
  ['npm_cache_env_var', 'npmCacheEnvVar'],
  ['npm_cache_dir_name', 'npmCacheDirName'],
  ['npm_allow_remote_env_var', 'npmAllowRemoteEnvVar'],
  ['npm_allow_remote_value', 'npmAllowRemoteValue'],
  ['cargo_target_env_var', 'cargoTargetEnvVar'],
  ['cargo_target_dir_name', 'cargoTargetDirName'],
  ['sdk_package_name', 'sdkPackageName'],
  ['sdk_node_modules_dir', 'sdkNodeModulesDir'],
  ['sdk_rust_dir_name', 'sdkRustDirName'],
  ['entry_extensions', 'entryExtensions'],
])

/** 非空字符串且不含路径分隔符 / NUL / 空白：包名、目录名、环境变量值等简单令牌。 */
function isSimpleToken(value: Json): value is string {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9@._-]+$/.test(value)
}

/** POSIX / 环境变量名形态。 */
function isEnvName(value: Json): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

/** 无点、纯字母数字的扩展名（供正则拼接，避免元字符注入）。 */
function isExtensionToken(value: Json): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value)
}

/** 字符串数组：逐项须过 `itemOk`；`requireNonEmpty` 为真时数组本身不得为空。 */
function readStringArray(
  value: Json,
  itemOk: (item: Json) => boolean,
  requireNonEmpty: boolean,
): string[] | null {
  if (!Array.isArray(value)) return null
  if (requireNonEmpty && value.length === 0) return null
  for (const item of value) if (!itemOk(item)) return null
  return value as string[]
}

/** 逐键校验并组装覆盖对象；任一键未知 / 形态非法 → `{ok:false}`（fail-closed）。 */
function parseEcosystemValue(value: Json): EcosystemResolution {
  if (!isRecord(value)) return { ok: false, reason: 'bad_ecosystem' }
  const overrides: Partial<EcosystemOverrides> = {}
  for (const key of Object.keys(value)) {
    const field = ECOSYSTEM_FIELDS.get(key)
    if (field === undefined) return { ok: false, reason: 'bad_ecosystem' }
    const raw = value[key]
    let parsed: string[] | string | null
    if (field === 'lockFiles' || field === 'sourceExcludedNames') {
      parsed = readStringArray(raw, (item) => typeof item === 'string' && item.length > 0, false)
    } else if (field === 'entryExtensions') {
      parsed = readStringArray(raw, isExtensionToken, true)
    } else if (field.endsWith('EnvVar')) {
      parsed = isEnvName(raw) ? raw : null
    } else {
      parsed = isSimpleToken(raw) ? raw : null
    }
    if (parsed === null) return { ok: false, reason: 'bad_ecosystem' }
    ;(overrides as Record<string, string | string[]>)[field] = parsed
  }
  return { ok: true, overrides, declared: true }
}

/**
 * 解析生态 profile 覆盖，优先级 **显式 > 环境 `CHRONO_ECOSYSTEM`（JSON 文本）> 文件 `ecosystem`**。
 * 未给（含文件 / 键缺失）→ `declared:false`、空覆盖（调用方用内建默认，零行为变化）；
 * 形态非法（非对象 / 未知键 / 错型 / 环境非 JSON）→ `{ok:false}`，由调用方 fail-closed 拒 `bad_ecosystem`。
 */
export function resolveEcosystem(
  explicit?: Json,
  env?: string,
  fileValue?: Json,
): EcosystemResolution {
  if (explicit !== undefined) {
    const result = parseEcosystemValue(explicit)
    return result.ok ? { ok: true, overrides: result.overrides, declared: true } : result
  }
  const envValue = env !== undefined && env.length > 0 ? env : undefined
  if (envValue !== undefined) {
    let parsed: Json
    try {
      parsed = JSON.parse(envValue) as Json
    } catch {
      return { ok: false, reason: 'bad_ecosystem' }
    }
    const result = parseEcosystemValue(parsed)
    return result.ok ? { ok: true, overrides: result.overrides, declared: true } : result
  }
  if (fileValue === undefined) return { ok: true, overrides: {}, declared: false }
  return parseEcosystemValue(fileValue)
}

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

// ---------------------------------------------------------------------------
// 宿主机制策略默认值：各机制的默认行为契约集中在此，供实现模块按名引用。
// 仅作具名默认，取值即行为契约，不得随引用重构改动。
// ---------------------------------------------------------------------------

/** 发起者未给 limits 时的宿主默认预算。 */
export const DEFAULT_LIMITS = { gas: 1_000_000, depth: 64 }

/** detached run 并发上限：无调用方等待，超限即拒，防单个插件无限起后台 run。 */
export const MAX_DETACHED_RUNS = 32

/** 审计查询缺省返回条数（按 seq 降序取最新）。 */
export const AUDIT_DEFAULT_LIMIT = 100
/** 审计查询单次返回条数上限。 */
export const AUDIT_MAX_LIMIT = 1000
/** 不分档时单档保留窗口缺省（条数）；与字节上限任一超出即淘汰。 */
export const AUDIT_MAX_RECORDS = 10_000
/** 不分档时单档保留窗口缺省（近似字节，按 body 的 JSON 长度计）。 */
export const AUDIT_MAX_BYTES = 8 * 1024 * 1024
/** 声明式分档的单档框架上限（条数）：插件自报超上限即截到上限。 */
export const AUDIT_TIER_MAX_RECORDS = 10_000
/** 声明式分档的单档框架上限（近似字节）。 */
export const AUDIT_TIER_MAX_BYTES = 8 * 1024 * 1024
/** 未声明 `audit_tier` 的端口归 default 档。 */
export const AUDIT_TIER_DEFAULT = 'default'
/** 缺省档预算：未声明端口走它。 */
export const AUDIT_DEFAULT_TIER = { maxRecords: 1000, maxBytes: 512 * 1024 }

/** 启动自动压缩阈值（尾段 entry 数）：达到即追加快照并归档前缀。 */
export const DEFAULT_COMPACT_TAIL_ENTRIES = 512
/**
 * 启动自动压缩阈值（尾段 journal 字节）：与条数阈值取先到者。
 * 只按条数会漏「少而大」的链——实测 337 条 / ~2.49 MB 时 512 条永不达到，base 从不落盘，
 * 每次启动从空世界全量重放。2 MiB 确保该量级启动后必落一次 base，启动重放退到「base + 尾段」。
 */
export const DEFAULT_COMPACT_JOURNAL_BYTES = 2 * 1024 * 1024
/** 有界化缺省世代窗口：每身份保留最近 N 代（含 active）+ 被 pin / graft 引用的世代。 */
export const DEFAULT_GEN_RETENTION = 64
/** 缺省补丁链压扁阈值：线性补丁链长达到此值即在 compact 时折叠成整份世代。 */
export const DEFAULT_FLATTEN_CHAIN = 32

/** 服务重启退避基准（毫秒）。 */
export const DEFAULT_RESTART_BACKOFF_MS = 500
/** 服务重启退避上限（毫秒）。 */
export const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000
/** 稳定窗口内允许的服务重启次数上限。 */
export const DEFAULT_RESTART_MAX = 5
/** 服务重启计数复位窗口（毫秒）。 */
export const DEFAULT_RESTART_WINDOW_MS = 60_000
/** 服务退出前等待在途收敛的排空窗口（毫秒）。 */
export const DEFAULT_RESTART_DRAIN_MS = 5_000
/** 健康探针间隔（毫秒）。 */
export const DEFAULT_HEALTH_INTERVAL_MS = 10_000
/** 健康探针单次超时（毫秒）。 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000
/** 连续探针失败阈值：达到该次数才判不健康。 */
export const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3
/** 启动宽限期（毫秒）：服务启动后该窗口内不发探针、不记失败。 */
export const DEFAULT_HEALTH_GRACE_MS = 30_000

/**
 * 同层装配并发上限：单次启动可能触发 npm / cargo 构建并 spawn 整棵进程树。
 * 不设上限会让 30+ 个构建同时开跑，打满 CPU / IO，且多个 cargo 争抢同一 target 目录锁；
 * 上限只约束「同时在物化 / 构建 / 握手的身份数」，不改变分层与顺序语义。
 */
export const DEFAULT_START_CONCURRENCY = 4
/**
 * active 之外额外保留的前代码世代数。前 N 代只是缓存命中优化，**不是回滚前提**：
 * 被回收的世代仍可由「指针 def + CAS 字节」重建，故回收绝不改变回滚承诺。
 */
export const MATERIALIZED_KEEP_GENERATIONS = 5
/** 源码 watcher 缺省静默窗口（毫秒）：足够覆盖编辑器多事件与原子替换，又不明显延迟反馈。 */
export const DEFAULT_WATCH_DEBOUNCE_MS = 300
/** 密钥名长度上限。 */
export const MAX_SECRET_NAME_LENGTH = 256
/** 单个密钥值字节上限（64 KiB）：防无界文件。 */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024
