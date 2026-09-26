// 从同包 `schema/protocol.json` 派生本插件自用参数（服务自述与 manifest 由 SDK 从 plugin.json 派生）。
// 读不到时回落安全缺省，保证服务仍能起。

import { readFileSync } from 'node:fs'
import { isRecord, makeLogger } from 'plugin-sdk'
import type { Rec } from 'plugin-sdk'

const log = makeLogger('model-protocol')

function readJson(relative: string): Rec {
  try {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read ${relative}: ${(err as Error).message}`)
  }
  return {}
}

const SCHEMA = readJson('../schema/protocol.json')

/** schema 顶层自用键（宿主只读 periodic / method_timeouts，其余归本插件）。 */
export function schemaConfig(): Rec {
  return isRecord(SCHEMA['resilience']) ? (SCHEMA['resilience'] as Rec) : {}
}
