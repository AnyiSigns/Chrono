// 挂载表与 headless 清单（③ 可重算，不进世界）。
// 挂载表：`state/ui-mounts.json` = `[{id, slot, entry}]`，启动无表则生成默认值。
// 客户端半边由插件自产自交付：壳经 `<id>.client.read` 取字节并以 `/assets/ui/<id>.js` 同源服务，无端口、无 `/p/` 反代。
// 老 state 表（带 port/path、无 entry）解析失败自动回落默认表，即迁移。
// headless 清单：`state/ui-headless.json` = `[{id, entry}]`，不进挂载表、不给布局位。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export interface MountEntry {
  id: string
  slot: string
  /** slot 客户端半边入口（包内相对 `.js` 路径，如 `dist/entry.js`）；壳经 `<id>.client.read` 同源服务。 */
  entry: string
}

export interface HeadlessEntry {
  id: string
  entry: string
}

export const MOUNTS_FILE = 'ui-mounts.json'
export const HEADLESS_FILE = 'ui-headless.json'
/** 壳自身 HTTP 端口（`CHRONO_UI_PORT`）；插件无端口。 */
export const DEFAULT_UI_PORT = 8787

/** 默认挂载表：一插件一 slot，增删改表不改壳代码。 */
export const DEFAULT_MOUNTS: MountEntry[] = [
  { id: 'ui-sidebar', slot: 'sidebar', entry: 'dist/entry.js' },
  { id: 'ui-chat', slot: 'main', entry: 'dist/entry.js' },
  { id: 'ui-approval', slot: 'dock', entry: 'dist/entry.js' },
  { id: 'ui-composer', slot: 'composer', entry: 'dist/entry.js' },
  { id: 'ui-threads', slot: 'topbar', entry: 'dist/entry.js' },
  { id: 'ui-settings', slot: 'overlay', entry: 'dist/entry.js' },
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

function validMount(value: Json): MountEntry | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const slot = value['slot']
  const entry = value['entry']
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof slot !== 'string' || slot.length === 0) return null
  if (typeof entry !== 'string' || !isSafeHeadlessEntry(entry)) return null
  return { id, slot, entry }
}

/** 解析挂载表文本；形态非法返回 null（调用方回落默认值，老表由此迁移）。 */
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

/** 读挂载表；无表 / 坏表（含带 port/path 的老表）则写默认值。 */
export function ensureMounts(stateDir: string): { mounts: MountEntry[]; created: boolean } {
  mkdirSync(stateDir, { recursive: true })
  const path = mountsPath(stateDir)
  if (existsSync(path)) {
    const parsed = parseMounts(readFileSync(path, 'utf8'))
    if (parsed !== null) return { mounts: parsed, created: false }
  }
  writeJson(path, DEFAULT_MOUNTS as unknown as Json)
  return { mounts: DEFAULT_MOUNTS, created: true }
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
