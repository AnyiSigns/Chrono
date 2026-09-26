// 从同包 `plugin.json` 派生命令只读集（服务不 import 宿主与内核）。
// 读不到时回落空集，保证服务仍能起（宿主握手会按声明做机械校验）。

import { packageRootOf, readPluginJson } from 'plugin-sdk'
import { isRecord } from './plan.ts'
import type { Json } from './types.ts'

/**
 * 从命令声明派生并发安全方法集：`readonly: true` 表示纯读——只读 args 传入的投影切片、
 * 不推进任何状态，故可与在途回合并发执行。长回合 `send` 整段 await
 * `loop-policy.interpret`，若读命令也排队，宿主侧按方法声明（远短于回合上限）的超时
 * 会先到，读命令作废。声明缺失或形状非法一律忽略，不抛错。
 */
export function deriveReadonlyMethods(commands: Json | undefined): Set<string> {
  const names = new Set<string>()
  if (!Array.isArray(commands)) return names
  for (const command of commands) {
    if (!isRecord(command) || command['readonly'] !== true) continue
    const name = command['name']
    if (typeof name !== 'string') continue
    const separator = name.indexOf('.')
    if (separator < 0 || separator === name.length - 1) continue
    names.add(name.slice(separator + 1))
  }
  return names
}

/** 声明为只读的方法名（去掉能力前缀），供帧循环放行并发。 */
export const READONLY_METHODS: ReadonlySet<string> = deriveReadonlyMethods(
  readPluginJson(packageRootOf(import.meta.url))['commands'],
)
