// 全局世界注册表：别名 → 世界根（项目 root）。CLI 在任意工作目录都能按别名引用世界，
// 由 `chrono world create <路径> as <别名>` 登记、`chrono world remove <别名>` 注销、`chrono world ls` 列出。
// 存放位置：Windows `%APPDATA%\chrono\worlds.json`；POSIX `$XDG_CONFIG_HOME/chrono/worlds.json`
// （缺省 `~/.config/chrono/worlds.json`）；`CHRONO_WORLDS` 可覆盖为显式文件路径。
// 形态非法 fail-closed（`bad_worlds_registry`），不静默当空表——否则别名会悄悄解析到错处。

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from './common/platform/index.ts'
import { isRecord } from './common/json.ts'

export interface WorldEntry {
  alias: string
  root: string
}

/** 注册表文件路径的环境覆盖（显式文件路径，非目录）。 */
export const WORLDS_ENV = 'CHRONO_WORLDS'

/** 解析注册表文件路径：环境 `CHRONO_WORLDS` 覆盖 > 平台用户配置目录。 */
export function worldsFile(): string {
  const explicit = process.env[WORLDS_ENV]
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit)
  const base =
    process.platform === 'win32'
      ? (process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'))
      : (process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'))
  return join(base, 'chrono', 'worlds.json')
}

/** 读注册表；文件缺失 = 空表；形态非法抛 `bad_worlds_registry`（fail-closed）。 */
function readEntries(): WorldEntry[] {
  const file = worldsFile()
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('bad_worlds_registry')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['worlds'])) throw new Error('bad_worlds_registry')
  const out: WorldEntry[] = []
  for (const item of parsed['worlds']) {
    if (!isRecord(item)) throw new Error('bad_worlds_registry')
    const alias = item['alias']
    const root = item['root']
    if (
      typeof alias !== 'string' ||
      alias.length === 0 ||
      typeof root !== 'string' ||
      root.length === 0
    ) {
      throw new Error('bad_worlds_registry')
    }
    out.push({ alias, root })
  }
  return out
}

/** 原子写注册表，按别名排序保证稳定输出。 */
function writeEntries(entries: WorldEntry[]): void {
  const file = worldsFile()
  mkdirSync(dirname(file), { recursive: true })
  const sorted = [...entries].sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0))
  writeFileAtomic(file, `${JSON.stringify({ worlds: sorted }, null, 2)}\n`)
}

/** 别名合法形态：非空、无 NUL / 换行、无路径分隔符（避免与路径字面歧义）。 */
function assertAlias(alias: string): void {
  if (alias.length === 0 || /[\0\r\n]/.test(alias) || alias.includes('/') || alias.includes('\\')) {
    throw new Error(`bad_alias: ${alias}`)
  }
}

/** 列出全部已登记世界（按别名升序）。 */
export function listWorlds(): WorldEntry[] {
  return readEntries()
}

/** 按别名精确查找；未登记返回 undefined。 */
export function findWorldByAlias(alias: string): WorldEntry | undefined {
  return readEntries().find((entry) => entry.alias === alias)
}

/** 登记（或覆盖）别名 → 世界根；返回落盘项（root 已绝对化）。 */
export function registerWorld(alias: string, root: string): WorldEntry {
  assertAlias(alias)
  const entry: WorldEntry = { alias, root: resolve(root) }
  const entries = readEntries().filter((item) => item.alias !== alias)
  entries.push(entry)
  writeEntries(entries)
  return entry
}

/** 注销别名；未登记返回 false（不删任何世界文件）。 */
export function unregisterWorld(alias: string): boolean {
  const entries = readEntries()
  const next = entries.filter((item) => item.alias !== alias)
  if (next.length === entries.length) return false
  writeEntries(next)
  return true
}

/**
 * 解析世界引用 `<世界路径/别名>`：先按别名精确命中，未命中按文件路径相对 cwd 解析。
 * 别名优先是刻意的——登记过的别名不应被同名相对路径意外遮蔽。
 */
export function resolveWorldRef(ref: string): string {
  const entry = findWorldByAlias(ref)
  if (entry !== undefined) return entry.root
  return resolve(process.cwd(), ref)
}
