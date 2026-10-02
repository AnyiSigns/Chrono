// `ui-slot` 提供方的槽 / 挂载 / headless 声明：解析与并入壳既有表（纯函数，可单测）。
// 提供方 `ui-slot.list` 返回 `{ slots?, mounts?, headless? }`；壳按槽名 / 挂载 id / headless id
// 去重合并，已存在的核心条目优先（提供方只补充，不覆盖页面自带的顶层槽与默认挂载）。

import { validHeadless, validMount } from './mounts.ts'
import { validSlot } from './slots.ts'
import type { HeadlessEntry, MountEntry } from './mounts.ts'
import type { SlotEntry } from './slots.ts'
import { isRecord } from './types.ts'
import type { Json } from './types.ts'

/** 一组声明合并后的三张表。 */
export interface SlotDeclTables {
  slots: SlotEntry[]
  mounts: MountEntry[]
  headless: HeadlessEntry[]
}

/** 合并基线：壳既有表（默认槽 / 挂载 / headless 或上一轮合并结果）。 */
export interface SlotDeclCore {
  slots: readonly SlotEntry[]
  mounts: readonly MountEntry[]
  headless: readonly HeadlessEntry[]
}

function itemsOf(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : []
}

/** 解析单个提供方的 `ui-slot.list` 回值；逐项形态非法按缺席跳过（作数据，不崩）。 */
export function parseSlotDecls(value: Json): SlotDeclTables {
  const record = isRecord(value) ? value : {}
  const slots: SlotEntry[] = []
  const mounts: MountEntry[] = []
  const headless: HeadlessEntry[] = []
  const slotNames = new Set<string>()
  for (const item of itemsOf(record['slots'])) {
    const entry = validSlot(item)
    if (entry === null || slotNames.has(entry.name)) continue
    slotNames.add(entry.name)
    slots.push(entry)
  }
  const mountIds = new Set<string>()
  for (const item of itemsOf(record['mounts'])) {
    const entry = validMount(item)
    if (entry === null || mountIds.has(entry.id)) continue
    mountIds.add(entry.id)
    mounts.push(entry)
  }
  const headlessIds = new Set<string>()
  for (const item of itemsOf(record['headless'])) {
    const entry = validHeadless(item)
    if (entry === null || headlessIds.has(entry.id)) continue
    headlessIds.add(entry.id)
    headless.push(entry)
  }
  return { slots, mounts, headless }
}

/**
 * 把多组提供方声明并入核心表：按名 / id 去重，核心条目优先。
 * 结果顺序 = 核心表序 → 各声明按提供方次序补齐的新增项，确定性。
 */
export function mergeSlotDecls(
  core: SlotDeclCore,
  decls: readonly SlotDeclTables[],
): SlotDeclTables {
  const slots = [...core.slots]
  const mounts = [...core.mounts]
  const headless = [...core.headless]
  const slotNames = new Set(slots.map((entry) => entry.name))
  const mountIds = new Set(mounts.map((entry) => entry.id))
  const headlessIds = new Set(headless.map((entry) => entry.id))
  for (const decl of decls) {
    for (const entry of decl.slots) {
      if (slotNames.has(entry.name)) continue
      slotNames.add(entry.name)
      slots.push(entry)
    }
    for (const entry of decl.mounts) {
      if (mountIds.has(entry.id)) continue
      mountIds.add(entry.id)
      mounts.push(entry)
    }
    for (const entry of decl.headless) {
      if (headlessIds.has(entry.id)) continue
      headlessIds.add(entry.id)
      headless.push(entry)
    }
  }
  return { slots, mounts, headless }
}
