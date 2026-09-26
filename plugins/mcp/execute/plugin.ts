// 从同包 `plugin.json` 派生身份名与命令名（服务不 import 宿主与内核）。
// 读不到时回落到安全缺省，保证服务仍能起（宿主握手会按声明做机械校验）。

import { packageRootOf, readPluginJson } from 'plugin-sdk'
import { isRecord } from './plan.ts'
import type { Json } from './types.ts'

const CAPABILITY = 'mcp'
const PLUGIN = readPluginJson(packageRootOf(import.meta.url))

export const IDENTITY: string =
  typeof PLUGIN['identity'] === 'string' ? (PLUGIN['identity'] as string) : CAPABILITY

/** 本能力类声明的命令名（供 describe 自述入站面）。 */
export const COMMANDS: string[] = Array.isArray(PLUGIN['commands'])
  ? (PLUGIN['commands'] as Json[])
      .filter((item): item is Record<string, Json> => isRecord(item))
      .map((item) => (typeof item['name'] === 'string' ? item['name'] : ''))
      .filter((name) => name.length > 0)
  : []
