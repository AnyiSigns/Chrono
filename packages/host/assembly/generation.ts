// 换代判据（机械口径，纯计算）：按 `members` 声明跨代比对「路径 + 解析内容」。
// 任一 execute 成员路径增删 / 内容变化 → code（起新服务）；仅 term/schema 变化 → data（reload）；
// 两类都有 / 同路径两用 → code（execute 优先）。不按目录名硬编码、不解释语义。
// 声明读不出来（坏声明 / 缺 def）按 code 保守处理；未声明成员的变化看不见 → data。
// 运行相（实际 reload / swap / 隔离）在 runtime.ts。

import { readPluginDeclOfGen, resolveTreeEntry } from './decl.ts'
import type { PluginMember } from './decl.ts'
import type { Gen, Hash, World } from '../../kernel/index.ts'

export type GenerationChange = 'code' | 'data'

interface MemberRef {
  mode: 'file' | 'dir' | null
  hash: Hash | null
  kinds: Set<string>
}

/** 声明成员路径 → 该路径在本世代 tree 里的解析内容（文件 / 子树哈希）；缺失记 null。 */
function memberRefs(world: World, tree: Hash, members: PluginMember[]): Map<string, MemberRef> {
  const out = new Map<string, MemberRef>()
  for (const member of members) {
    const entry = resolveTreeEntry(world, tree, member.path)
    const existing = out.get(member.path)
    if (existing === undefined) {
      out.set(member.path, {
        mode: entry?.mode ?? null,
        hash: entry?.hash ?? null,
        kinds: new Set([member.kind]),
      })
    } else {
      existing.kinds.add(member.kind)
    }
  }
  return out
}

function pathChanged(before: MemberRef | undefined, after: MemberRef | undefined): boolean {
  if (before === undefined || after === undefined) return true
  if (before.mode !== after.mode || before.hash !== after.hash) return true
  // 同路径声明角色变化（如 term → execute）同样按内容变化处理：execute 侧必须起新服务
  if (before.kinds.size !== after.kinds.size) return true
  for (const kind of before.kinds) if (!after.kinds.has(kind)) return true
  return false
}

/**
 * 跨代判据：`oldGen`（旧世界 active）与 `newGen`（新世界 active）的声明成员比对。
 * 只做机械比对；不读 body、不推断依赖。
 */
export function classifyGenerationChange(
  prev: World,
  oldGen: Gen,
  next: World,
  newGen: Gen,
): GenerationChange {
  const oldRead = readPluginDeclOfGen(prev, oldGen)
  const newRead = readPluginDeclOfGen(next, newGen)
  if (oldRead === null || newRead === null) return 'code'
  const before = memberRefs(prev, oldRead.tree, oldRead.decl.members)
  const after = memberRefs(next, newRead.tree, newRead.decl.members)
  const paths = new Set<string>([...before.keys(), ...after.keys()])
  let code = false
  let data = false
  for (const path of paths) {
    if (!pathChanged(before.get(path), after.get(path))) continue
    const oldRef = before.get(path)
    const newRef = after.get(path)
    const kinds = new Set([...(oldRef?.kinds ?? []), ...(newRef?.kinds ?? [])])
    if (kinds.has('execute')) code = true
    else data = true
  }
  return code ? 'code' : 'data'
}
