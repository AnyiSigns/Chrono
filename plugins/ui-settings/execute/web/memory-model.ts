// 记忆页纯函数（node 下可 import 单测）：三档切换 / 工作区筛选 / TTL 格式 / 搜索高亮 / 编辑槽载荷。
// 只做数据归一与字符串处理，不触 DOM、不发请求；渲染在 React 组件层。

import { isRecord } from './config-model.ts'

/** 记忆三档（#23 `view` 的 l1 / l2 / l3）。 */
export const MEMORY_LAYERS = ['l1', 'l2', 'l3']

/** 合法档位兜底到 `l1`。 */
export function normalizeLayer(layer: any): string {
  return MEMORY_LAYERS.includes(layer) ? layer : 'l1'
}

/** 档位标题文案键。 */
export function layerTitleKey(layer: any): string {
  return `settings_memory_layer_${normalizeLayer(layer)}`
}

/** 剩余 TTL 格式：`<1m` / `45m` / `3h 12m` / `2d 4h`；非法值回空串。 */
export function formatTtl(ms: any): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (ms <= 0) return '0m'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '<1m'
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

/** L1 行的 TTL 状态：`{expired, ms}`（无 TTL 字段时 `ms` 为 null、`expired` 为 false）。 */
export function ttlState(entry: any): any {
  const ms = isRecord(entry) && typeof entry.ttl_remaining_ms === 'number' ? entry.ttl_remaining_ms : null
  return { expired: ms !== null && ms <= 0, ms }
}

/** `memory.view` 结果归一：`{ok, at, l1, l2, l3}`（非法结果按空视图）。 */
export function memoryView(result: any): any {
  const empty = { ok: false, at: null, l1: [], l2: [], l3: [] }
  if (!isRecord(result)) return empty
  const list = (key: string) => (Array.isArray(result[key]) ? result[key].filter((item: any) => isRecord(item)) : [])
  return {
    ok: result.ok !== false,
    at: typeof result.at === 'string' ? result.at : null,
    l1: list('l1'),
    l2: list('l2'),
    l3: list('l3'),
  }
}

/** 取某档条目（档位非法回空）。 */
export function layerEntries(view: any, layer: any): any[] {
  const key = normalizeLayer(layer)
  return isRecord(view) && Array.isArray(view[key]) ? view[key] : []
}

/** 工作区选项：L2 id + L3 `workspace`（非空、去重、排序）。 */
export function workspaceOptions(view: any): string[] {
  const set = new Set<string>()
  for (const entry of layerEntries(view, 'l2')) {
    if (typeof entry.id === 'string' && entry.id.length > 0) set.add(entry.id)
  }
  for (const entry of layerEntries(view, 'l3')) {
    if (typeof entry.workspace === 'string' && entry.workspace.length > 0) set.add(entry.workspace)
  }
  return [...set].sort()
}

/**
 * 工作区筛选：`''` 表示全部；L2 按 id 精确匹配；L3 保留匹配项与全局（无 workspace）项；
 * L1 无工作区元数据，保持原样（由视图提示归属未知）。
 */
export function filterByWorkspace(entries: any[], layer: any, workspace: any): any[] {
  if (typeof workspace !== 'string' || workspace.length === 0) return entries
  const key = normalizeLayer(layer)
  if (key === 'l2') return entries.filter((entry) => entry.id === workspace)
  if (key === 'l3') {
    return entries.filter((entry) => entry.workspace === undefined || entry.workspace === null || entry.workspace === '' || entry.workspace === workspace)
  }
  return entries
}

/** 摘要四列表 + goal（缺失回空数组 / 空串）。 */
export function summaryLists(summary: any): any {
  const source = isRecord(summary) ? summary : {}
  const list = (key: string) => (Array.isArray(source[key]) ? source[key].filter((item: any) => typeof item === 'string' && item.length > 0) : [])
  return {
    goal: typeof source.goal === 'string' ? source.goal : '',
    facts: list('facts'),
    decisions: list('decisions'),
    open_questions: list('open_questions'),
    files: list('files'),
  }
}

/** `memory.search` 结果归一：`{ok, recall:[{entry_id, entry_hash, text, score, meta}], count}`。 */
export function memorySearch(result: any): any {
  if (!isRecord(result)) return { ok: false, recall: [], count: 0 }
  const recall = Array.isArray(result.recall)
    ? result.recall
        .filter((item: any) => isRecord(item))
        .map((item: any) => ({
          entry_id: typeof item.entry_id === 'string' ? item.entry_id : '',
          entry_hash: typeof item.entry_hash === 'string' ? item.entry_hash : '',
          text: typeof item.text === 'string' ? item.text : '',
          score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null,
          meta: isRecord(item.meta) ? item.meta : {},
        }))
    : []
  return { ok: result.ok !== false, recall, count: recall.length }
}

/**
 * 命中高亮：大小写不敏感切分，返回 `[{text, hit}]` 段（无查询 / 无命中回整段）。
 * 纯字符串扫描，不用正则（避免查询里的元字符）。
 */
export function highlightSegments(text: any, query: any): any[] {
  const source = typeof text === 'string' ? text : ''
  const needle = typeof query === 'string' ? query.trim() : ''
  if (needle.length === 0) return [{ text: source, hit: false }]
  const haystack = source.toLowerCase()
  const lower = needle.toLowerCase()
  const segments: any[] = []
  let index = 0
  while (index < source.length) {
    const found = haystack.indexOf(lower, index)
    if (found < 0) {
      segments.push({ text: source.slice(index), hit: false })
      break
    }
    if (found > index) segments.push({ text: source.slice(index, found), hit: false })
    segments.push({ text: source.slice(found, found + needle.length), hit: true })
    index = found + needle.length
  }
  return segments.length > 0 ? segments : [{ text: source, hit: false }]
}

/** `memory.edit` 槽载荷（写类无参命令：先写槽再调命令；action 对齐由服务侧做）。 */
export function editSlotPayload(action: any, layer: any, id: any, patch: any): any {
  return { kind: 'memory.edit', action, layer: normalizeLayer(layer), id, patch: isRecord(patch) ? patch : {} }
}

/** 行内编辑提交的 patch：L3 文本编辑走 `{text}`；L1 / L2 文本编辑同形（#23 置 goal）。 */
export function editTextPatch(text: any): any {
  return { text: typeof text === 'string' ? text : '' }
}

/** 置顶 patch：`pinned` 为 false 表示取消置顶。 */
export function pinPatch(pinned: any): any {
  return { pinned: pinned === true }
}

/** 浏览三态：`degraded`（依赖未就绪）/ `empty`（当前档 + 工作区筛选后无条目）/ `ready`。 */
export function memoryBrowseState(view: any, degraded: any, layer: any, workspace: any): string {
  if (degraded) return 'degraded'
  const entries = filterByWorkspace(layerEntries(view, layer), layer, workspace)
  return entries.length === 0 ? 'empty' : 'ready'
}

/** 搜索四态：`busy` / `degraded` / `idle`（未搜）/ `empty`（无匹配）/ `ready`（有命中）。 */
export function memorySearchState(busy: any, degraded: any, result: any): string {
  if (busy) return 'busy'
  if (degraded) return 'degraded'
  if (result === null) return 'idle'
  return memorySearch(result).recall.length === 0 ? 'empty' : 'ready'
}
