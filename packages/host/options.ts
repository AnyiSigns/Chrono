// 宿主启动选项：调用超时解析（F7）。
// 口径：显式（`--call-timeout-ms`）> 环境（`CHRONO_CALL_TIMEOUT_MS`）> 常量 `DEFAULT_CALL_TIMEOUT_MS`。
// 纯函数：host 入口与 boot start 共用同一份，避免两处解析漂移；非法值 fail-closed。

import { DEFAULT_CALL_TIMEOUT_MS } from './effect/run-loop.ts'

/** 入口 flag 语法（boot CLI 与宿主入口共用同一份解析，避免语义漂移）。 */
export interface EntryOptions {
  root?: string
  /** `--call-timeout-ms` 的值；flag 给出但缺值 = ''（交给 `resolveCallTimeoutMs` fail-closed）。 */
  callTimeout?: string
  rest: string[]
}

const ENTRY_FLAGS: ReadonlySet<string> = new Set(['--root', '--call-timeout-ms'])

/**
 * 解析入口 argv：`--root <v>` / `--call-timeout-ms <v>` 摘出，其余按序进 `rest`。
 * 已知 flag 缺值（后随另一个 flag 或到末尾）→ 记为 present + 无值：不吞下一枚 flag、不静默进 rest。
 */
export function parseEntryArgv(argv: string[]): EntryOptions {
  const out: EntryOptions = { rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
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
    out.callTimeout = value ?? ''
  }
  return out
}

/**
 * 解析调用超时（毫秒）。
 * @param explicit `--call-timeout-ms` 的值；给出但非法（含空串）→ 抛 `bad_call_timeout`
 * @param env `CHRONO_CALL_TIMEOUT_MS` 的值；空串视为未设置
 */
export function resolveCallTimeoutMs(explicit?: string, env?: string): number {
  const raw = explicit ?? (env !== undefined && env.length > 0 ? env : undefined)
  if (raw === undefined) return DEFAULT_CALL_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`bad_call_timeout: ${raw}`)
  }
  return value
}
