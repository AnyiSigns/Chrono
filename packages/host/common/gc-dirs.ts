// 目录回收骨架：readdir → 过滤 → rm → failed。
// 只共用骨架，保留策略由调用方以 `keep` / `select` / `remove` 参数化——
// `state/data/` 不参与「active + 前 N 代」窗口回收，且删除失败只记日志、不阻锁释放，与 `state/plugins/` 刻意分开。

import { existsSync, readdirSync } from 'node:fs'

export interface GcDirsReport {
  /** 参与扫描的项数（经 `select` 过滤后）。 */
  scanned: number
  /** 被删的项名（排序）。 */
  removed: string[]
  /** 保留集内的项数。 */
  kept: number
  /** 删不掉的项（含原因）；`onRemoveError: 'collect'` 时由调用方落运维日志，不阻断。 */
  failed: { name: string; reason: string }[]
}

export interface GcDirsPolicy {
  /** 目录项名是否在保留集内：true = 保留。 */
  keep: (name: string) => boolean
  /** 目录项名是否参与扫描：false 跳过（不计数、不删）；缺省全部参与。 */
  select?: (name: string) => boolean
  /** 删除一项；实现按文件 / 目录、符号链接等自定。 */
  remove: (name: string) => void
  /** 删除失败处置：`collect`（缺省）= 记入 `failed` 不阻断；`throw` = 上抛。 */
  onRemoveError?: 'collect' | 'throw'
}

/**
 * 回收一个目录下不在保留集内的项。目录不存在即空报告；
 * 只处理 `select` 命中的项，未命中的项（staging / 意外内容 / 旁挂元数据）一概不碰。
 */
export function gcDirs(dir: string, policy: GcDirsPolicy): GcDirsReport {
  if (!existsSync(dir)) return { scanned: 0, removed: [], kept: 0, failed: [] }
  const removed: string[] = []
  const failed: { name: string; reason: string }[] = []
  let scanned = 0
  let kept = 0
  for (const name of readdirSync(dir)) {
    if (policy.select !== undefined && !policy.select(name)) continue
    scanned += 1
    if (policy.keep(name)) {
      kept += 1
      continue
    }
    try {
      policy.remove(name)
      removed.push(name)
    } catch (err) {
      if (policy.onRemoveError === 'throw') throw err
      failed.push({ name, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { scanned, removed: removed.sort(), kept, failed }
}
