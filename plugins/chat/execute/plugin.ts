// 从同包 `plugin.json` 派生服务自述（服务自述与声明一致；服务不 import 宿主与内核）。
// 读不到时回落到安全缺省，保证服务仍能起（宿主握手会按声明做机械校验）。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

const CAPABILITY = 'chat'

function readPlugin(): Rec {
  try {
    const text = readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read plugin.json: ${(err as Error).message}`)
  }
  return {}
}

const PLUGIN = readPlugin()

export const IDENTITY: string =
  typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : CAPABILITY

export const IMPLEMENTS: string[] = Array.isArray(PLUGIN['implements'])
  ? (PLUGIN['implements'] as Json[]).filter((item): item is string => typeof item === 'string')
  : [CAPABILITY]

export const METHODS: Rec = isRecord(PLUGIN['methods']) ? (PLUGIN['methods'] as Rec) : {}

export const PROTOCOL: string =
  typeof PLUGIN['protocol'] === 'string' ? (PLUGIN['protocol'] as string) : '1'

export const STATE: string =
  typeof PLUGIN['state'] === 'string' ? (PLUGIN['state'] as string) : 'recomputable'

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
export const READONLY_METHODS: ReadonlySet<string> = deriveReadonlyMethods(PLUGIN['commands'])
