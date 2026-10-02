// `ui-nav` 中立记录的解析与确定性排序（纯函数，可单测）。
// 记录形状 `{id, label, icon, target}`；`target` 指明点击去向：页面 / 浮层 / 壳视图状态。
// 顺序 = 提供方身份名字典序（调用方已按此汇集）→ 记录 `order` → 记录 `id`；同 id 取先到者。

import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export interface NavTarget {
  page?: string
  overlay?: string
  uiState?: { key: string; value: Json }
}

export interface NavRecord {
  id: string
  label: string
  /** 可选文案码：消费方优先按码取共享文案，取不到回落 `label`。 */
  labelCode?: string
  icon: string
  target: NavTarget
  order: number
  provider: string
}

function parseTarget(value: Json | undefined): NavTarget | null {
  if (!isRecord(value)) return null
  const page = value['page']
  if (typeof page === 'string' && page.length > 0) return { page }
  const overlay = value['overlay']
  if (typeof overlay === 'string' && overlay.length > 0) return { overlay }
  const uiState = value['uiState']
  if (isRecord(uiState) && typeof uiState['key'] === 'string' && uiState['key'].length > 0) {
    return { uiState: { key: uiState['key'] as string, value: uiState['value'] as Json } }
  }
  return null
}

/** 解析单条记录；任一必需字段非法即跳过（作数据，不崩）。 */
export function parseNavRecord(value: Json): Omit<NavRecord, 'provider'> | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const label = value['label']
  const icon = value['icon']
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof label !== 'string' || label.length === 0) return null
  if (typeof icon !== 'string' || icon.length === 0) return null
  const target = parseTarget(value['target'])
  if (target === null) return null
  const order = typeof value['order'] === 'number' && Number.isFinite(value['order']) ? value['order'] : 0
  const record: Omit<NavRecord, 'provider'> = { id, label, icon, target, order }
  const labelCode = value['label_code']
  if (typeof labelCode === 'string' && labelCode.length > 0) record.labelCode = labelCode
  return record
}

/** 解析一个提供方 `list` 方法回值 `{records:[...]}`；形状非法回空表。 */
export function recordsOf(value: Json): Omit<NavRecord, 'provider'>[] {
  if (!isRecord(value)) return []
  const records = value['records']
  if (!Array.isArray(records)) return []
  const out: Omit<NavRecord, 'provider'>[] = []
  for (const item of records) {
    const record = parseNavRecord(item as Json)
    if (record !== null) out.push(record)
  }
  return out
}

/**
 * 汇集导航记录会写入的壳视图状态键：显式 `target.uiState.key` 与浮层目标的
 * `${overlay}_open`（侧栏点击浮层入口时写这个派生键），加壳自身的 `boot_mode`。
 * 供壳按 nav 数据登记 uiState 键空间，免去「加 overlay 要改壳键白名单」。字典序去重。
 */
export function uiStateKeysOf(records: readonly NavRecord[]): string[] {
  const keys = new Set<string>(['boot_mode'])
  for (const record of records) {
    if (record.target.uiState !== undefined) keys.add(record.target.uiState.key)
    if (record.target.overlay !== undefined) keys.add(`${record.target.overlay}_open`)
  }
  return [...keys].sort()
}

/** 合并各提供方的记录：按提供方码元序 → order → id 稳定排序，同 id 取先到者。 */
export function orderNav(groups: { provider: string; records: Omit<NavRecord, 'provider'>[] }[]): NavRecord[] {
  const tagged: NavRecord[] = []
  for (const group of groups) {
    for (const record of group.records) tagged.push({ ...record, provider: group.provider })
  }
  tagged.sort((left, right) => {
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1
    if (left.order !== right.order) return left.order - right.order
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const seen = new Set<string>()
  const out: NavRecord[] = []
  for (const record of tagged) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    out.push(record)
  }
  return out
}
