// 记忆页（S12）：L1 / L2 / L3 三档 + 工作区筛选 + 浏览 + 搜索 + 编辑 / 删除 / 置顶。
// 浏览走 `memory.view`（只读，服务装配 #23 view），搜索走 `memory.search`（只读，服务装配 #22 search）；
// 编辑 / 删除 / 置顶走 `memory.edit`（写类无参：先写 `memory.edit` 槽再调命令）。
// 本文件只渲染；数据加载与动作住 data-load.js / memory-actions.js。加载 / 空 / 错误三态由入口骨架与下方行内条承担。

import { el, icon, iconButton, textButton } from './dom.js'
import { dependencyMissing, emptyState, section } from './ui-parts.js'
import {
  editTextPatch,
  filterByWorkspace,
  formatTtl,
  highlightSegments,
  layerEntries,
  layerTitleKey,
  MEMORY_LAYERS,
  memoryBrowseState,
  memorySearch,
  memorySearchState,
  memoryView,
  pinPatch,
  summaryLists,
  ttlState,
  workspaceOptions,
} from './memory-model.js'

const SUMMARY_FIELDS = [
  ['settings_memory_decisions', 'decisions'],
  ['settings_memory_facts', 'facts'],
  ['settings_memory_open_questions', 'open_questions'],
  ['settings_memory_files', 'files'],
]

export function renderMemory(ctx, content) {
  const view = memoryView(ctx.state.memory.view)
  content.appendChild(layerBar(ctx, view))
  content.appendChild(searchBar(ctx))
  const search = searchSection(ctx)
  if (search !== null) content.appendChild(search)
  if (ctx.state.memory.editError !== null) content.appendChild(editErrorBar(ctx))
  content.appendChild(browseSection(ctx, view))
}

/** 三档切换 + 工作区筛选。 */
function layerBar(ctx, view) {
  const doc = ctx.doc
  const memory = ctx.state.memory
  const tabs = el(doc, 'div', { class: 'settings-row-value' })
  for (const layer of MEMORY_LAYERS) {
    const selected = memory.layer === layer
    const button = textButton(
      doc,
      ctx.text(layerTitleKey(layer)),
      () => {
        memory.layer = layer
        memory.edit = null
        memory.confirmDelete = null
        ctx.render()
      },
      { tone: selected ? 'accent' : undefined },
    )
    button.setAttribute('aria-pressed', selected ? 'true' : 'false')
    tabs.appendChild(button)
  }
  const select = el(doc, 'select', { class: 'settings-select', attrs: { 'aria-label': ctx.text('settings_memory_workspace_label') } })
  select.appendChild(el(doc, 'option', { text: ctx.text('settings_memory_workspace_all'), attrs: { value: '' } }))
  for (const workspace of workspaceOptions(view)) {
    select.appendChild(el(doc, 'option', { text: workspace, attrs: { value: workspace } }))
  }
  select.value = memory.workspace
  select.addEventListener('change', () => {
    memory.workspace = select.value
    memory.edit = null
    ctx.render()
  })
  return el(doc, 'div', { class: 'settings-row' }, [
    el(doc, 'span', { class: 'settings-row-label', text: ctx.text('settings_memory_layers') }),
    el(doc, 'span', { class: 'settings-row-value' }, [tabs, select]),
  ])
}

/** 搜索输入 + 按钮（回车触发）。 */
function searchBar(ctx) {
  const doc = ctx.doc
  const memory = ctx.state.memory
  const input = el(doc, 'input', {
    class: 'settings-input',
    attrs: {
      type: 'search',
      placeholder: ctx.text('settings_memory_search_placeholder'),
      'aria-label': ctx.text('settings_memory_search'),
    },
  })
  input.value = memory.query
  input.addEventListener('input', () => {
    memory.query = input.value
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void ctx.doMemorySearch()
    }
  })
  const button = textButton(doc, ctx.text('settings_memory_search'), () => void ctx.doMemorySearch(), {
    tone: 'accent',
    disabled: memory.searchBusy,
  })
  return el(doc, 'div', { class: 'settings-row' }, [input, button])
}

/** 搜索结果区：忙 / 降级 / 空「无匹配」/ 命中列表（高亮）。 */
function searchSection(ctx) {
  const doc = ctx.doc
  const memory = ctx.state.memory
  const state = memorySearchState(memory.searchBusy, memory.searchDegraded, memory.search)
  if (state === 'idle') return null
  if (state === 'busy') {
    return section(ctx, 'settings_memory_search', [
      el(doc, 'div', { class: 'settings-block-loading' }, [el(doc, 'div', { class: 'settings-breathe' })]),
    ])
  }
  if (state === 'degraded') return section(ctx, 'settings_memory_search', [searchErrorBar(ctx)])
  const node = el(doc, 'div', { class: 'settings-section' })
  node.appendChild(el(doc, 'div', { class: 'settings-group-name', text: ctx.text('settings_memory_search') }))
  if (state === 'empty') {
    node.appendChild(emptyState(ctx, 'settings_memory_no_match'))
    return node
  }
  const list = el(doc, 'div', { class: 'settings-list' })
  for (const hit of memorySearch(memory.search).recall) list.appendChild(hitRow(ctx, hit))
  node.appendChild(list)
  return node
}

function hitRow(ctx, hit) {
  const doc = ctx.doc
  const main = el(doc, 'span', { class: 'settings-list-main' })
  for (const segment of highlightSegments(hit.text, ctx.state.memory.query)) {
    main.appendChild(el(doc, 'span', { class: segment.hit ? 'settings-memory-hit' : undefined, text: segment.text }))
  }
  const meta = []
  if (hit.entry_id.length > 0) meta.push(hit.entry_id)
  if (hit.score !== null) meta.push(ctx.text('settings_memory_score', { score: hit.score.toFixed(3) }))
  return el(doc, 'div', { class: 'settings-list-item' }, [
    main,
    el(doc, 'span', { class: 'settings-list-meta', text: meta.join(' · ') }),
  ])
}

/** 浏览区：当前档 + 工作区筛选后的条目（空态 / 降级 / 列表）。 */
function browseSection(ctx, view) {
  const doc = ctx.doc
  const memory = ctx.state.memory
  const node = el(doc, 'div', { class: 'settings-section' })
  node.appendChild(el(doc, 'div', { class: 'settings-group-name', text: ctx.text(layerTitleKey(memory.layer)) }))
  const state = memoryBrowseState(view, memory.viewDegraded, memory.layer, memory.workspace)
  if (state === 'degraded') {
    node.appendChild(dependencyMissing(ctx))
    return node
  }
  if (state === 'empty') {
    node.appendChild(emptyState(ctx, 'settings_memory_empty', 'settings_memory_empty_hint'))
    return node
  }
  const list = el(doc, 'div', { class: 'settings-list' })
  for (const entry of filterByWorkspace(layerEntries(view, memory.layer), memory.layer, memory.workspace)) {
    list.appendChild(entryBlock(ctx, entry))
  }
  node.appendChild(list)
  return node
}

/** 单条：行 + 可选摘要明细 + 可选内联编辑 / 删除确认。 */
function entryBlock(ctx, entry) {
  const layer = ctx.state.memory.layer
  const rowKey = `${layer}:${entry.id}`
  const wrap = el(ctx.doc, 'div', { class: 'settings-memory-entry' })
  wrap.appendChild(entryRow(ctx, entry, layer, rowKey))
  if (layer !== 'l3') {
    for (const detail of summaryDetail(ctx, summaryLists(entry.summary))) wrap.appendChild(detail)
  }
  const memory = ctx.state.memory
  if (memory.edit !== null && memory.edit.key === rowKey) wrap.appendChild(editForm(ctx, entry, layer, rowKey))
  if (memory.confirmDelete === rowKey) wrap.appendChild(deleteConfirm(ctx, layer, entry.id))
  return wrap
}

function entryRow(ctx, entry, layer, rowKey) {
  const doc = ctx.doc
  const summary = summaryLists(entry.summary)
  const ttl = ttlState(entry)
  const expired = layer === 'l1' && ttl.expired
  const mainText = layer === 'l3' ? textOf(entry.text) : summary.goal.length > 0 ? summary.goal : ctx.text('settings_memory_no_goal')
  const meta = []
  if (typeof entry.at === 'string' && entry.at.length > 0) meta.push(entry.at)
  if (layer === 'l1') {
    if (ttl.ms !== null) {
      meta.push(ttl.expired ? ctx.text('settings_memory_expired') : ctx.text('settings_memory_ttl', { ttl: formatTtl(ttl.ms) }))
    }
  }
  if (layer === 'l2') meta.push(ctx.text('settings_memory_sources', { count: Array.isArray(entry.sources) ? entry.sources.length : 0 }))
  if (layer === 'l3') {
    if (textOf(entry.source).length > 0) meta.push(`${ctx.text('settings_memory_source')} ${entry.source}`)
    if (textOf(entry.workspace).length > 0) meta.push(`${ctx.text('settings_memory_workspace_label')} ${entry.workspace}`)
    if (Array.isArray(entry.tags) && entry.tags.length > 0) meta.push(`${ctx.text('settings_memory_tags')} ${entry.tags.join(', ')}`)
    if (typeof entry.weight === 'number' && Number.isFinite(entry.weight)) meta.push(`${ctx.text('settings_memory_weight')} ${entry.weight.toFixed(2)}`)
  }
  const node = el(doc, 'div', { class: `settings-list-item${expired ? ' settings-memory-expired' : ''}` })
  node.appendChild(el(doc, 'span', { class: 'settings-list-main', text: mainText }))
  node.appendChild(el(doc, 'span', { class: 'settings-list-meta', text: meta.join(' · ') }))
  if (layer === 'l3' && entry.pinned === true) {
    node.appendChild(el(doc, 'span', { class: 'settings-memory-pinned', text: ctx.text('settings_memory_pinned') }))
  }
  node.appendChild(rowActions(ctx, entry, layer, rowKey))
  return node
}

function summaryDetail(ctx, summary) {
  const doc = ctx.doc
  const rows = []
  for (const [key, field] of SUMMARY_FIELDS) {
    const values = summary[field]
    if (values.length === 0) continue
    rows.push(
      el(doc, 'div', { class: 'settings-memory-field' }, [
        el(doc, 'span', { class: 'settings-field-label', text: ctx.text(key) }),
        el(doc, 'span', { class: 'settings-list-meta', text: values.join(' · ') }),
      ]),
    )
  }
  return rows
}

function rowActions(ctx, entry, layer, rowKey) {
  const doc = ctx.doc
  const memory = ctx.state.memory
  const actions = el(doc, 'span', { class: 'settings-row-value' })
  const edit = iconButton(doc, 'pencil', ctx.text('settings_memory_edit'), () => {
    memory.edit = { key: rowKey, text: layer === 'l3' ? textOf(entry.text) : summaryLists(entry.summary).goal }
    memory.confirmDelete = null
    ctx.render()
  })
  if (memory.busy) edit.disabled = true
  actions.appendChild(edit)
  if (layer === 'l3') {
    const pinned = entry.pinned === true
    const pin = iconButton(doc, pinned ? 'arrow-down' : 'arrow-up', ctx.text(pinned ? 'settings_memory_unpin' : 'settings_memory_pin'), () => {
      void ctx.doMemoryEdit('pin', layer, entry.id, pinPatch(!pinned))
    })
    if (memory.busy) pin.disabled = true
    actions.appendChild(pin)
  }
  const remove = iconButton(doc, 'trash-2', ctx.text('settings_memory_delete'), () => {
    memory.confirmDelete = rowKey
    memory.edit = null
    ctx.render()
  })
  if (memory.busy) remove.disabled = true
  actions.appendChild(remove)
  return actions
}

function editForm(ctx, entry, layer, rowKey) {
  const doc = ctx.doc
  const memory = ctx.state.memory
  const input = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'text', 'aria-label': ctx.text('settings_memory_edit') },
  })
  input.value = memory.edit.text
  input.addEventListener('input', () => {
    memory.edit.text = input.value
  })
  const save = textButton(doc, ctx.text('settings_memory_save'), () => {
    void ctx.doMemoryEdit('update', layer, entry.id, editTextPatch(memory.edit.text))
  }, { tone: 'accent', disabled: memory.busy })
  const cancel = textButton(doc, ctx.text('settings_memory_cancel'), () => {
    memory.edit = null
    ctx.render()
  })
  return el(doc, 'div', { class: 'settings-memory-edit' }, [input, save, cancel])
}

function deleteConfirm(ctx, layer, id) {
  const doc = ctx.doc
  const confirm = textButton(doc, ctx.text('settings_memory_confirm_delete'), () => {
    void ctx.doMemoryEdit('delete', layer, id, {})
  }, { tone: 'danger', disabled: ctx.state.memory.busy })
  const cancel = textButton(doc, ctx.text('settings_memory_cancel'), () => {
    ctx.state.memory.confirmDelete = null
    ctx.render()
  })
  return el(doc, 'div', { class: 'settings-memory-edit' }, [confirm, cancel])
}

function editErrorBar(ctx) {
  const doc = ctx.doc
  const error = ctx.state.memory.editError
  const bar = el(doc, 'div', { class: 'settings-error', attrs: { role: 'alert' } })
  bar.appendChild(icon(doc, 'alert-circle', 16))
  bar.appendChild(el(doc, 'span', { text: ctx.text(error.code) }))
  bar.appendChild(
    textButton(doc, ctx.text('settings_retry'), () => {
      void ctx.doMemoryEdit(error.action, error.layer, error.id, error.patch)
    }),
  )
  return bar
}

function searchErrorBar(ctx) {
  const doc = ctx.doc
  const bar = el(doc, 'div', { class: 'settings-error', attrs: { role: 'alert' } })
  bar.appendChild(icon(doc, 'alert-circle', 16))
  bar.appendChild(el(doc, 'span', { text: ctx.text('settings_memory_search_failed') }))
  bar.appendChild(textButton(doc, ctx.text('settings_retry'), () => void ctx.doMemorySearch()))
  return bar
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}
