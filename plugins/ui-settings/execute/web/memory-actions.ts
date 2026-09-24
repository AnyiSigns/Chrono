// 记忆页动作：搜索（只读）+ 编辑 / 删除 / 置顶（写类无参：写 `memory.edit` 槽 → 调命令 → 重拉视图）。
// 命令失败落行内 danger + 重试；不弹窗、不空白。搜索需要的投影切片经 `settings.identities` 取回随 args 传入。

import { isRecord } from './config-model.ts'
import { editSlotPayload } from './memory-model.ts'
import { loadIdentities, loadMemoryView } from './data-load.ts'

/** 搜索结果条数上限（写入 #22 `retrieval.top_k`）。 */
export const SEARCH_LIMIT = 20

/** 搜索：空查询清结果；否则带投影切片调 `memory.search`。 */
export async function doMemorySearch(ctx: any): Promise<void> {
  const memory = ctx.state.memory
  const query = memory.query.trim()
  // 每次搜索取一个序号；只有最新序号的结果才提交，慢的旧搜索不覆盖新搜索。
  const seq = (memory.searchSeq = (memory.searchSeq ?? 0) + 1)
  if (query.length === 0) {
    memory.search = null
    memory.searchDegraded = false
    memory.searchBusy = false
    ctx.render()
    return
  }
  memory.searchBusy = true
  memory.searchDegraded = false
  ctx.render()
  try {
    // 投影切片（含 #21 body / refs）随 args 传入；编辑后置 stale，重取一次保证搜索看得到新条目。
    if (ctx.state.identities === null || memory.identitiesStale) {
      const identities = await loadIdentities(ctx)
      if (memory.searchSeq !== seq) return
      ctx.state.identities = identities
      memory.identitiesStale = false
    }
    if (ctx.state.identities === null) {
      if (memory.searchSeq !== seq) return
      memory.search = null
      memory.searchDegraded = true
      return
    }
    const result = await ctx.runCommand('memory.search', {
      query,
      workspace: memory.workspace,
      tags: [],
      limit: SEARCH_LIMIT,
      ids: ctx.state.identities,
    })
    if (memory.searchSeq !== seq) return
    const failed = !result.ok || (isRecord(result.value) && result.value.ok === false)
    memory.search = failed ? null : result.value
    memory.searchDegraded = failed
  } finally {
    if (memory.searchSeq === seq) {
      memory.searchBusy = false
      ctx.render()
    }
  }
}

/** 编辑 / 删除 / 置顶：先写槽再调无参命令，随后重拉视图。返回是否成功。 */
export async function doMemoryEdit(ctx: any, action: string, layer: string, id: string, patch: any): Promise<boolean> {
  const memory = ctx.state.memory
  memory.busy = true
  memory.editError = null
  memory.confirmDelete = null
  ctx.render()
  try {
    const wrote = await ctx.writeSlot(editSlotPayload(action, layer, id, patch))
    if (!wrote.ok) {
      memory.editError = { action, layer, id, patch, code: 'settings_memory_edit_failed' }
      return false
    }
    const result = await ctx.runCommand('memory.edit', null)
    const failed = !result.ok || (isRecord(result.value) && result.value.ok === false)
    if (failed) {
      memory.editError = { action, layer, id, patch, code: 'settings_memory_edit_failed' }
      return false
    }
    memory.edit = null
    memory.search = null
    memory.identitiesStale = true
    return true
  } finally {
    memory.busy = false
    await loadMemoryView(ctx)
    ctx.render()
  }
}
