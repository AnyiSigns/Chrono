// 从同包 `plugin.json` 派生服务自述，并从 `schema/router.json` 读出别名清单的冻结默认值。
// 服务自述与声明一致（宿主握手按声明做机械校验）；读不到时回落安全缺省，保证服务仍能起。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import type { Json, Rec } from './types.ts'

const CAPABILITY = 'router'
const DEFAULT_PRIMARY = 'model'

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
