// 顶层槽声明（③ 可重算，不进世界）：`state/ui-slots.json` = `[{name, kind?, mount?}]`。
// 壳按本表渲染槽容器：页面自带的 7 个顶层槽仍在，新增一种 chrome（如 statusbar）或页面槽（page）
// 只需改数据——不改壳代码里的槽名清单，也不改壳页面模板。
// `mount` 是新增槽的落位容器：root / column / stage / bottom / body。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export type SlotKind = 'chrome' | 'page'
export type SlotMount = 'root' | 'column' | 'stage' | 'bottom' | 'body'

export interface SlotEntry {
  name: string
  kind: SlotKind
  mount: SlotMount
}

export const SLOTS_FILE = 'ui-slots.json'

const KINDS: readonly SlotKind[] = ['chrome', 'page']
const MOUNTS: readonly SlotMount[] = ['root', 'column', 'stage', 'bottom', 'body']

/** 默认槽表：壳页面自带的 7 个顶层槽 + 页面宿主槽。挂载位只对新增槽有意义。 */
export const DEFAULT_SLOTS: SlotEntry[] = [
  { name: 'sidebar', kind: 'chrome', mount: 'root' },
  { name: 'topbar', kind: 'chrome', mount: 'column' },
  { name: 'underbar', kind: 'chrome', mount: 'column' },
  { name: 'main', kind: 'chrome', mount: 'column' },
  { name: 'dock', kind: 'chrome', mount: 'bottom' },
  { name: 'composer', kind: 'chrome', mount: 'bottom' },
  { name: 'overlay', kind: 'chrome', mount: 'body' },
  { name: 'page', kind: 'page', mount: 'stage' },
]

function isSlotName(value: Json | undefined): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value)
}

export function validSlot(value: Json): SlotEntry | null {
  if (!isRecord(value)) return null
  const name = value['name']
  if (!isSlotName(name)) return null
  const kind = value['kind'] === undefined ? 'chrome' : value['kind']
  if (typeof kind !== 'string' || !KINDS.includes(kind as SlotKind)) return null
  const mount = value['mount'] === undefined ? 'column' : value['mount']
  if (typeof mount !== 'string' || !MOUNTS.includes(mount as SlotMount)) return null
  return { name, kind: kind as SlotKind, mount: mount as SlotMount }
}

/** 解析槽表文本；形态非法返回 null（调用方回落默认值）。 */
export function parseSlots(text: string): SlotEntry[] | null {
  let parsed: Json
  try {
    parsed = JSON.parse(text) as Json
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const entries: SlotEntry[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    const entry = validSlot(item)
    if (entry === null || seen.has(entry.name)) return null
    seen.add(entry.name)
    entries.push(entry)
  }
  return entries
}

export function slotsPath(stateDir: string): string {
  return join(stateDir, SLOTS_FILE)
}

/** 读槽表；无表 / 坏表则写默认值。 */
export function ensureSlots(stateDir: string): { slots: SlotEntry[]; created: boolean } {
  mkdirSync(stateDir, { recursive: true })
  const path = slotsPath(stateDir)
  if (existsSync(path)) {
    const parsed = parseSlots(readFileSync(path, 'utf8'))
    if (parsed !== null) return { slots: parsed, created: false }
  }
  try {
    writeFileSync(path, `${JSON.stringify(DEFAULT_SLOTS, null, 2)}\n`, 'utf8')
  } catch {
    // 写不进去只损失可重算的落盘，运行期仍用默认表
  }
  return { slots: DEFAULT_SLOTS, created: true }
}
