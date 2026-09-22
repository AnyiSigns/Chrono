// 记忆页动作：搜索（只读）+ 编辑 / 删除 / 置顶（写类无参：写 `memory.edit` 槽 → 调命令 → 重拉视图）。
// 命令失败落行内 danger + 重试；不弹窗、不空白。搜索需要的投影切片经 `settings.identities` 取回随 args 传入。

import { isRecord, slotWriteDirective } from './config-model.js'
import { editSlotPayload } from './memory-model.js'
import { loadIdentities, loadMemoryView } from './data-load.js'

/** 搜索结果条数上限（写入 #22 `retrieval.top_k`）。 */
export const SEARCH_LIMIT = 20

/** 搜索：空查询清结果；否则带投影切片调 `memory.search`。 */
export async function doMemorySearch(ctx) {
  const memory = ctx.state.memory
  const query = memory.query.trim()
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
      ctx.state.identities = await loadIdentities(ctx)
      memory.identitiesStale = false
    }
    if (ctx.state.identities === null) {
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
    const failed = !result.ok || (isRecord(result.value) && result.value.ok === false)
    memory.search = failed ? null : result.value
    memory.searchDegraded = failed
  } finally {
    memory.searchBusy = false
    ctx.render()
  }
}

/** 编辑 / 删除 / 置顶：先写槽再调无参命令，随后重拉视图。返回是否成功。 */
export async function doMemoryEdit(ctx, action, layer, id, patch) {
  const memory = ctx.state.memory
  memory.busy = true
  memory.editError = null
  memory.confirmDelete = null
  ctx.render()
  try {
    const slots = await ctx.readSlots()
    const wrote = await ctx.applyWrite(slotWriteDirective(slots, ctx.threadKey, editSlotPayload(action, layer, id, patch)))
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
