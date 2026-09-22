// 挂载表与 headless 清单（③ 可重算，不进世界）。
// 挂载表：`state/ui-mounts.json` = `[{id, path, slot, port}]`，启动无表则生成默认值；
// 子应用端口可用 `CHRONO_UI_PORT_<ID>` 覆盖（ID 大写、非字母数字转下划线）。
// headless 清单：`state/ui-headless.json` = `[{id, entry}]`，不进挂载表、不给布局位。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export interface MountEntry {
  id: string
  path: string
  slot: string
  port: number
}

export interface HeadlessEntry {
  id: string
  entry: string
}

export const MOUNTS_FILE = 'ui-mounts.json'
export const HEADLESS_FILE = 'ui-headless.json'
export const DEFAULT_UI_PORT = 8787
export const PROXY_PREFIX = '/p/'

/** 默认挂载表：一插件一 slot，增删改表不改壳代码。 */
export const DEFAULT_MOUNTS: MountEntry[] = [
  { id: 'ui-sidebar', path: '/p/ui-sidebar/', slot: 'sidebar', port: 8791 },
  { id: 'ui-chat', path: '/p/ui-chat/', slot: 'main', port: 8788 },
  { id: 'ui-approval', path: '/p/ui-approval/', slot: 'dock', port: 8789 },
  { id: 'ui-composer', path: '/p/ui-composer/', slot: 'composer', port: 8790 },
  { id: 'ui-threads', path: '/p/ui-threads/', slot: 'topbar', port: 8793 },
  { id: 'ui-settings', path: '/p/ui-settings/', slot: 'overlay', port: 8792 },
]

/** 默认 headless 清单：ui-notify 不占 slot、不给端口，只提供浏览器侧入口 bundle（住 `web/`）。 */
export const DEFAULT_HEADLESS: HeadlessEntry[] = [{ id: 'ui-notify', entry: 'web/entry.js' }]

/** 旧版默认 headless 入口路径（bundle 住 `execute/` 的历史值）；加载时迁移到当前默认。 */
const LEGACY_HEADLESS_ENTRIES: { [entry: string]: string } = {
  'execute/entry.js': 'web/entry.js',
}

/** headless 条目 id 必须是安全单段名（禁 `/` / `\` / `.` / `..` / 控制字符）。 */
export function isSafeHeadlessId(id: string): boolean {
  return id.length > 0 && !/[/\\\u0000-\u001f]/.test(id) && id !== '.' && id !== '..'
}

/** headless 入口必须是安全的包内相对 `.js` 路径（禁绝对 / 盘符 / `..` / 反斜杠）。 */
export function isSafeHeadlessEntry(entry: string): boolean {
  if (entry.length === 0 || entry.includes('\\') || entry.includes('\u0000')) return false
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) return false
  const segments = entry.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false
  return entry.endsWith('.js')
}

export function mountsPath(stateDir: string): string {
  return join(stateDir, MOUNTS_FILE)
}

export function headlessPath(stateDir: string): string {
  return join(stateDir, HEADLESS_FILE)
}

/** 子应用端口覆盖环境变量名：`CHRONO_UI_PORT_<ID>`（ID 大写、非字母数字转 `_`）。 */
export function normalizePortEnvKey(id: string): string {
  return `CHRONO_UI_PORT_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/** 解析端口覆盖值；非法（非整数 / 越界）返回 null（忽略该覆盖）。 */
export function parsePort(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/** 按 id 取端口覆盖：先查规范化名，再查原始名（POSIX 允许带连字符的环境变量名）。 */
export function overridePort(id: string, env: { [key: string]: string | undefined }): number | null {
  return parsePort(env[normalizePortEnvKey(id)]) ?? parsePort(env[`CHRONO_UI_PORT_${id}`])
}

/** 对挂载表逐条应用端口覆盖（不改入参）。 */
export function applyOverrides(
  mounts: MountEntry[],
  env: { [key: string]: string | undefined },
): MountEntry[] {
  return mounts.map((entry) => {
    const port = overridePort(entry.id, env)
    return port === null ? entry : { ...entry, port }
  })
}

function validMount(value: Json): MountEntry | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const path = value['path']
  const slot = value['slot']
  const port = value['port']
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  if (typeof slot !== 'string' || slot.length === 0) return null
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { id, path, slot, port }
}

/** 解析挂载表文本；形态非法返回 null（调用方回落默认值）。 */
export function parseMounts(text: string): MountEntry[] | null {
  let parsed: Json
  try {
    parsed = JSON.parse(text) as Json
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const entries: MountEntry[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    const entry = validMount(item)
    if (entry === null || seen.has(entry.id)) return null
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

function validHeadless(value: Json): HeadlessEntry | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const entry = value['entry']
  if (typeof id !== 'string' || !isSafeHeadlessId(id)) return null
  if (typeof entry !== 'string' || !isSafeHeadlessEntry(entry)) return null
  return { id, entry }
}

/** 解析 headless 清单文本；形态非法返回 null（调用方回落默认值）。 */
export function parseHeadless(text: string): HeadlessEntry[] | null {
  let parsed: Json
  try {
    parsed = JSON.parse(text) as Json
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const entries: HeadlessEntry[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    const entry = validHeadless(item)
    if (entry === null || seen.has(entry.id)) return null
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

function writeJson(path: string, value: Json): boolean {
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读挂载表；无表 / 坏表则写默认值。返回的表已应用 `CHRONO_UI_PORT_<ID>` 覆盖。 */
export function ensureMounts(
  stateDir: string,
  env: { [key: string]: string | undefined },
): { mounts: MountEntry[]; created: boolean } {
  mkdirSync(stateDir, { recursive: true })
  const path = mountsPath(stateDir)
  if (existsSync(path)) {
    const parsed = parseMounts(readFileSync(path, 'utf8'))
    if (parsed !== null) return { mounts: applyOverrides(parsed, env), created: false }
  }
  writeJson(path, DEFAULT_MOUNTS as unknown as Json)
  return { mounts: applyOverrides(DEFAULT_MOUNTS, env), created: true }
}

/**
 * 归一 headless 条目：旧路径迁移到当前默认；任一坏值（id / entry 形态非法）整表回落默认。
 * 返回是否发生改动（调用方据此重写落盘）。
 */
export function normalizeHeadless(entries: HeadlessEntry[]): {
  headless: HeadlessEntry[]
  changed: boolean
} {
  if (entries.length === 0) return { headless: DEFAULT_HEADLESS, changed: true }
  let changed = false
  const headless: HeadlessEntry[] = []
  for (const entry of entries) {
    if (!isSafeHeadlessId(entry.id) || !isSafeHeadlessEntry(entry.entry)) {
      return { headless: DEFAULT_HEADLESS, changed: true }
    }
    const migrated = LEGACY_HEADLESS_ENTRIES[entry.entry]
    if (migrated !== undefined) {
      headless.push({ id: entry.id, entry: migrated })
      changed = true
    } else {
      headless.push(entry)
    }
  }
  return { headless, changed }
}

/** 读 headless 清单；无表 / 坏表 / 旧路径则重写为归一结果。 */
export function ensureHeadless(stateDir: string): { headless: HeadlessEntry[]; created: boolean } {
  mkdirSync(stateDir, { recursive: true })
  const path = headlessPath(stateDir)
  if (existsSync(path)) {
    const parsed = parseHeadless(readFileSync(path, 'utf8'))
    if (parsed !== null) {
      const normalized = normalizeHeadless(parsed)
      if (normalized.changed) writeJson(path, normalized.headless as unknown as Json)
      return { headless: normalized.headless, created: false }
    }
  }
  writeJson(path, DEFAULT_HEADLESS as unknown as Json)
  return { headless: DEFAULT_HEADLESS, created: true }
}

/** 按 id 查挂载项；不在表内返回 null（表外 id 走 forward 帧）。 */
export function findMount(mounts: MountEntry[], id: string): MountEntry | null {
  for (const entry of mounts) {
    if (entry.id === id) return entry
  }
  return null
}
