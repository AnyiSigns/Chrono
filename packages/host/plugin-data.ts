// 插件 ④ 目录：`state/data/<id>/` 承载 owner 插件的不可重算运行记录（对话 / 输入槽 / 审批 / 待办 …）。
// 宿主不认识目录内容，只保证位置：声明 `durable` 时在准备阶段建目录、注入 `CHRONO_PLUGIN_DATA`，
// 启动时删目录名不在当前世界身份集中的顶层项。与 ③ 分开：④ 进备份、跨代存活，不参与世代窗口回收。

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { World } from '../kernel/index.ts'
import { isSafeIdentityName } from './assembly/identity-name.ts'

/** 身份名不安全（路径穿越 / 非法目录名）：拒绝解析持久目录，fail-closed。 */
export class PluginDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginDataError'
  }
}

/**
 * 解析本身份持久目录路径并建目录：`<dataRoot>/<id>/`，返回该目录。
 * 身份名必须是安全单段名（复用装配侧校验器），否则抛 `PluginDataError`——
 * 不安全名字既会路径穿越、又会被 GC 误删，故不静默接受。
 */
export function ensurePluginDataDir(dataRoot: string, id: string): string {
  if (!isSafeIdentityName(id)) throw new PluginDataError(`bad_identity:${id}`)
  const dir = resolve(dataRoot, id)
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface PluginDataGcReport {
  /** 被删的顶层项名（排序）。 */
  removed: string[]
  /** 删不掉的项（含原因），由调用方落运维日志，不阻断其余项与锁释放。 */
  failed: { name: string; reason: string }[]
}

/**
 * 统一 GC：删除插件 ④ 目录下不在 `world.ids` 中的顶层项（整项递归删除）。
 * 与 ③ 同规：`retire` / `set_active(null)` 只改 active、身份 id 仍在 `world.ids` ⇒ 目录保留；
 * ④ 不参与「active + 前 N 代」窗口回收，故本函数无世代窗口参数——代码换代与回滚都不碰它。
 * 单项删除失败只记 `failed`，不中断其余项、不阻调用方释放锁。
 * 用 `Object.hasOwn` 判身份存在（`__proto__` 等原型键不是真身份）；符号链接只删链接、不跟进去。
 */
export function gcPluginData(dataRoot: string, world: World): PluginDataGcReport {
  if (!existsSync(dataRoot)) return { removed: [], failed: [] }
  const removed: string[] = []
  const failed: { name: string; reason: string }[] = []
  for (const name of readdirSync(dataRoot)) {
    if (Object.hasOwn(world.ids, name)) continue
    const target = resolve(dataRoot, name)
    try {
      const link = lstatSync(target).isSymbolicLink()
      rmSync(target, link ? { force: true } : { recursive: true, force: true })
      removed.push(name)
    } catch (err) {
      failed.push({ name, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { removed: removed.sort(), failed }
}
