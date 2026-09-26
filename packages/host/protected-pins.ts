// 受保护 pin 名单的运营配置读取：仓库根 `chrono.config.json` 的 `protected_pins` 键。
// 优先级 显式 > 环境 `CHRONO_PROTECTED_PINS` > 文件；缺失 → 空集 + 运维日志；形态非法 → fail-closed。
// 名单是安全策略，不由被约束的插件自报；读取与入世（seed / pack / validate_package）共用同一份。

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Json } from '../kernel/index.ts'
import { isRecord } from './common/json.ts'
import { appendLifecycle } from './lifecycle.ts'
import {
  CONFIG_FILE,
  PROTECTED_PINS_ENV,
  PROTECTED_PINS_KEY,
  resolveProtectedPins,
} from './options.ts'
import { hostPaths } from './paths.ts'

export interface ProtectedPinsRead {
  /** 受保护身份名集合；非法时为空集（调用方按 `reason` fail-closed）。 */
  identities: ReadonlySet<string>
  /** 形态非法（文件 JSON 坏 / 非字符串数组 / 原型键 / 空串项）→ `bad_protected_pins`。 */
  reason?: 'bad_protected_pins'
}

/** 读 `chrono.config.json` 的 `protected_pins` 键；文件 / 键缺失 → `value: undefined`；JSON 坏 → `ok:false`。 */
function readConfigValue(root: string): { ok: true; value: Json | undefined } | { ok: false } {
  const file = join(root, CONFIG_FILE)
  if (!existsSync(file)) return { ok: true, value: undefined }
  let parsed: Json
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Json
  } catch {
    return { ok: false }
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, PROTECTED_PINS_KEY)) {
    return { ok: true, value: undefined }
  }
  return { ok: true, value: parsed[PROTECTED_PINS_KEY] }
}

/** 已记过「未声明」运维日志的 root：同一 root 只记一次，避免逐插件入世时重记。 */
const unsetLogged = new Set<string>()

/**
 * 解析受保护 pin 名单：显式 > 环境 > 文件。
 * 文件缺失 / 键缺失 → 空集 + 一条运维日志（fail-open，故有兜底测试断言随仓库配置恰含六个身份）；
 * 形态非法 → fail-closed `bad_protected_pins`（不静默当空集，否则删保护边可绕过）。
 */
export function readProtectedPins(root: string, explicit?: string): ProtectedPinsRead {
  const config = readConfigValue(root)
  if (!config.ok) return { identities: new Set(), reason: 'bad_protected_pins' }
  const resolved = resolveProtectedPins(explicit, process.env[PROTECTED_PINS_ENV], config.value)
  if (!resolved.ok) return { identities: new Set(), reason: 'bad_protected_pins' }
  if (!resolved.declared) {
    const key = resolve(root)
    if (!unsetLogged.has(key)) {
      unsetLogged.add(key)
      appendLifecycle(hostPaths(root).lifecycleFile, {
        at: Date.now(),
        kind: 'host',
        event: 'protected_pins_unset',
      })
    }
  }
  return { identities: new Set(resolved.identities) }
}
