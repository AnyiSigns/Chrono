// 从同包 `plugin.json` 派生 schema 路径，并从 `schema/router.json` 读出别名清单的冻结默认值。
// 服务自述与 manifest 由 SDK 从 plugin.json 派生；读不到 schema 时回落安全缺省，保证服务仍能起。

import { readFileSync } from 'node:fs'
import { isRecord, makeLogger } from 'plugin-sdk'
import type { Json, Rec } from 'plugin-sdk'

const DEFAULT_PRIMARY = 'model'
const log = makeLogger('router')

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

const PLUGIN = readJson('../plugin.json')

const SCHEMA_PATH = typeof PLUGIN['schema'] === 'string' ? (PLUGIN['schema'] as string) : ''
const SCHEMA = SCHEMA_PATH.length === 0 ? {} : readJson(`../${SCHEMA_PATH}`)

/** schema 里某个属性的冻结默认值（`properties.<name>.default`）。 */
function schemaDefault(name: string): Json | undefined {
  const properties = SCHEMA['properties']
  if (!isRecord(properties)) return undefined
  const property = properties[name]
  if (!isRecord(property)) return undefined
  return property['default']
}

const PRIMARY_DEFAULT = schemaDefault('primary')

/** 默认别名端口名（schema 冻结值，缺省 `model`）。 */
export const DEFAULT_ALIAS_PRIMARY: string =
  typeof PRIMARY_DEFAULT === 'string' ? PRIMARY_DEFAULT : DEFAULT_PRIMARY

const ALIASES_DEFAULT = schemaDefault('aliases')

/** 默认别名清单（schema 冻结值，缺省空数组）。 */
export const DEFAULT_ALIASES: string[] = Array.isArray(ALIASES_DEFAULT)
  ? ALIASES_DEFAULT.filter((item): item is string => typeof item === 'string')
  : []
