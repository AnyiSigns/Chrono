// 插件 ③ 目录：`state/plugins/<id>/` 承载插件缓存 / 索引 / 水位等可重算产物。
// 宿主不认识目录内容，只保证存在（起服务时创建）与统一清理：启动时删掉目录名不在当前世界身份集中的项。

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { World } from '../kernel/index.ts'

/**
 * 统一 GC：删除插件 ③ 目录下不在 `world.ids` 中的项（整项递归删除），返回被删名字（排序）。
 * 目录不存在即无操作。`retire` 只把 `active` 置 null，身份 id 仍在 `world.ids` 里，
 * 故退役身份的缓存目录**保留**；GC 只删目录名不在 `world.ids` 的项。
 * 用 `Object.hasOwn` 判身份存在（`__proto__` 等原型键不是真身份）；符号链接只删链接、不跟进去。
 */
export function gcPluginState(pluginsDir: string, world: World): string[] {
  if (!existsSync(pluginsDir)) return []
  const removed: string[] = []
  for (const name of readdirSync(pluginsDir)) {
    if (Object.hasOwn(world.ids, name)) continue
    const target = resolve(pluginsDir, name)
    const link = lstatSync(target).isSymbolicLink()
    rmSync(target, link ? { force: true } : { recursive: true, force: true })
    removed.push(name)
  }
  return removed.sort()
}
