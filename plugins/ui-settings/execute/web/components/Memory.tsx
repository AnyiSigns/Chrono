// 记忆页：L1 / L2 / L3 三档 + 工作区筛选 + 浏览 + 搜索 + 编辑 / 删除 / 置顶。
// 浏览走 `memory.view`；搜索走 `memory.search`；编辑 / 删除 / 置顶走 `memory.edit`（写类无参）。
// 本文件只渲染；数据加载与动作住 data-load.ts / memory-actions.ts。

import { useState } from 'react'
import { DependencyMissing, EmptyState, Icon, IconButton, Section, TextButton, useVc } from './ui.tsx'
import { joinMeta } from '../config-model.ts'
import {
  editTextPatch,
  entrySummary,
  filterByWorkspace,
  highlightSegments,
  hitMeta,
  layerEntries,
  layerTitleKey,
  MEMORY_LAYERS,
  memoryBrowseState,
  memorySearch,
  memorySearchState,
  memoryView,
  pinPatch,
  summaryLists,
  workspaceOptions,
} from '../memory-model.ts'

const SUMMARY_FIELDS: [string, string][] = [
  ['settings_memory_decisions', 'decisions'],
  ['settings_memory_facts', 'facts'],
  ['settings_memory_open_questions', 'open_questions'],
  ['settings_memory_files', 'files'],
]

export function MemoryPanel() {
  const vc = useVc()
  const view = memoryView(vc.state.memory.view)
  return (
    <>
      <LayerBar view={view} />
      <SearchBar />
      <SearchSection />
      {vc.state.memory.editError !== null ? <EditErrorBar /> : null}
      <BrowseSection view={view} />
    </>
  )
}

/** 三档切换（分段控件）+ 工作区筛选。 */
function LayerBar(props: { view: any }) {
  const vc = useVc()
  const memory = vc.state.memory
  return (
    <div className="settings-row">
      <span className="settings-row-label">{vc.text('settings_memory_layers')}</span>
      <span className="settings-row-value">
        <span className="settings-segment" role="group" aria-label={vc.text('settings_memory_layers')}>
          {MEMORY_LAYERS.map((layer) => (
            <button
              type="button"
              key={layer}
              className="settings-segment-item"
              aria-pressed={memory.layer === layer ? 'true' : 'false'}
              onClick={() => {
                memory.layer = layer
                memory.edit = null
                memory.confirmDelete = null
                vc.render()
              }}
            >
              {vc.text(layerTitleKey(layer))}
            </button>
          ))}
        </span>
        <select
          className="settings-select"
          aria-label={vc.text('settings_memory_workspace_label')}
          value={memory.workspace}
          onChange={(event) => {
            memory.workspace = event.target.value
            memory.edit = null
            vc.render()
          }}
        >
          <option value="">{vc.text('settings_memory_workspace_all')}</option>
          {workspaceOptions(props.view).map((workspace) => (
            <option key={workspace} value={workspace}>
              {workspace}
            </option>
          ))}
        </select>
      </span>
    </div>
  )
}

/** 搜索输入 + 按钮（回车触发）。 */
function SearchBar() {
  const vc = useVc()
  const memory = vc.state.memory
  return (
    <div className="settings-row">
      <input
        className="settings-input"
        type="search"
        placeholder={vc.text('settings_memory_search_placeholder')}
        aria-label={vc.text('settings_memory_search')}
        value={memory.query}
        onChange={(event) => {
          memory.query = event.target.value
          vc.render()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          if (!memory.searchBusy) void vc.doMemorySearch()
        }}
      />
      <TextButton label={vc.text('settings_memory_search')} tone="accent" disabled={memory.searchBusy} onClick={() => void vc.doMemorySearch()} />
    </div>
  )
}

/** 搜索结果区：忙 / 降级 / 空「无匹配」/ 命中列表（高亮）。 */
function SearchSection() {
  const vc = useVc()
  const memory = vc.state.memory
  const state = memorySearchState(memory.searchBusy, memory.searchDegraded, memory.search)
  if (state === 'idle') return null
  if (state === 'busy') {
    return (
      <Section nameKey="settings_memory_search">
        <div className="settings-block-loading">
          <div className="settings-breathe" />
        </div>
      </Section>
    )
  }
  if (state === 'degraded') {
    return (
      <Section nameKey="settings_memory_search">
        <SearchErrorBar />
      </Section>
    )
  }
  return (
    <div className="settings-section">
      <div className="settings-group-name">{vc.text('settings_memory_search')}</div>
      {state === 'empty' ? (
        <EmptyState nameKey="settings_memory_no_match" />
      ) : (
        <div className="settings-list">
          {memorySearch(memory.search).recall.map((hit: any, index: number) => (
            <HitRow hit={hit} key={`${hit.entry_id}:${index}`} />
          ))}
        </div>
      )}
    </div>
  )
}

function HitRow(props: { hit: any }) {
  const vc = useVc()
  const hit = props.hit
  return (
    <div className="settings-list-item">
      <span className="settings-list-main">
        {highlightSegments(hit.text, vc.state.memory.query).map((segment: any, index: number) => (
          <span className={segment.hit ? 'settings-memory-hit' : undefined} key={index}>
            {segment.text}
          </span>
        ))}
      </span>
      <span className="settings-list-meta">{hitMeta(hit, vc.text)}</span>
    </div>
  )
}

/** 浏览区：当前档 + 工作区筛选后的条目（空态 / 降级 / 列表）。 */
function BrowseSection(props: { view: any }) {
  const vc = useVc()
  const memory = vc.state.memory
  const state = memoryBrowseState(props.view, memory.viewDegraded, memory.layer, memory.workspace)
  return (
    <div className="settings-section">
      <div className="settings-group-name">{vc.text(layerTitleKey(memory.layer))}</div>
      {state === 'degraded' ? (
        <DependencyMissing />
      ) : state === 'empty' ? (
        <EmptyState nameKey="settings_memory_empty" hintKey="settings_memory_empty_hint" />
      ) : (
        <div className="settings-list">
          {filterByWorkspace(layerEntries(props.view, memory.layer), memory.layer, memory.workspace).map((entry: any) => (
            <EntryBlock entry={entry} key={entry.id} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 单条：行 + 可选摘要明细 + 可选内联编辑 / 删除确认。 */
function EntryBlock(props: { entry: any }) {
  const vc = useVc()
  const entry = props.entry
  const layer = vc.state.memory.layer
  const rowKey = `${layer}:${entry.id}`
  const memory = vc.state.memory
  return (
    <div className="settings-memory-entry">
      <EntryRow entry={entry} layer={layer} rowKey={rowKey} />
      {layer !== 'l3' ? <SummaryDetail summary={summaryLists(entry.summary)} /> : null}
      {memory.edit !== null && memory.edit.key === rowKey ? <EditForm entry={entry} layer={layer} /> : null}
      {memory.confirmDelete === rowKey ? <DeleteConfirm layer={layer} id={entry.id} /> : null}
    </div>
  )
}

function EntryRow(props: { entry: any; layer: string; rowKey: string }) {
  const vc = useVc()
  const entry = props.entry
  const layer = props.layer
  const summary = entrySummary(entry, layer, vc.text)
  return (
    <div className={`settings-list-item${summary.expired ? ' settings-memory-expired' : ''}`}>
      <span className="settings-list-main">{summary.mainText}</span>
      <span className="settings-list-meta">{summary.meta}</span>
      {layer === 'l3' && entry.pinned === true ? <span className="settings-memory-pinned">{vc.text('settings_memory_pinned')}</span> : null}
      <RowActions entry={entry} layer={layer} rowKey={props.rowKey} />
    </div>
  )
}

function SummaryDetail(props: { summary: any }) {
  const vc = useVc()
  return (
    <>
      {SUMMARY_FIELDS.map(([key, field]) => {
        const values = props.summary[field]
        if (values.length === 0) return null
        return (
          <div className="settings-memory-field" key={key}>
            <span className="settings-field-label">{vc.text(key)}</span>
            <span className="settings-list-meta">{joinMeta(values)}</span>
          </div>
        )
      })}
    </>
  )
}

function RowActions(props: { entry: any; layer: string; rowKey: string }) {
  const vc = useVc()
  const entry = props.entry
  const layer = props.layer
  const memory = vc.state.memory
  const pinned = entry.pinned === true
  return (
    <span className="settings-row-value">
      <IconButton
        name="pencil"
        label={vc.text('settings_memory_edit')}
        disabled={memory.busy}
        onClick={() => {
          memory.edit = { key: props.rowKey, text: layer === 'l3' ? textOf(entry.text) : summaryLists(entry.summary).goal }
          memory.confirmDelete = null
          vc.render()
        }}
      />
      {layer === 'l3' ? (
        <IconButton
          name={pinned ? 'arrow-down' : 'arrow-up'}
          label={vc.text(pinned ? 'settings_memory_unpin' : 'settings_memory_pin')}
          disabled={memory.busy}
          onClick={() => {
            void vc.doMemoryEdit('pin', layer, entry.id, pinPatch(!pinned))
          }}
        />
      ) : null}
      <IconButton
        name="trash-2"
        label={vc.text('settings_memory_delete')}
        disabled={memory.busy}
        onClick={() => {
          memory.confirmDelete = props.rowKey
          memory.edit = null
          vc.render()
        }}
      />
    </span>
  )
}

function EditForm(props: { entry: any; layer: string }) {
  const vc = useVc()
  const memory = vc.state.memory
  const [text, setText] = useState(memory.edit.text)
  return (
    <div className="settings-memory-edit">
      <input
        className="settings-input"
        type="text"
        aria-label={vc.text('settings_memory_edit')}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <TextButton
        label={vc.text('settings_memory_save')}
        tone="accent"
        disabled={memory.busy}
        onClick={() => {
          void vc.doMemoryEdit('update', props.layer, props.entry.id, editTextPatch(text))
        }}
      />
      <TextButton
        label={vc.text('settings_memory_cancel')}
        onClick={() => {
          memory.edit = null
          vc.render()
        }}
      />
    </div>
  )
}

function DeleteConfirm(props: { layer: string; id: string }) {
  const vc = useVc()
  const memory = vc.state.memory
  return (
    <div className="settings-memory-edit">
      <TextButton
        label={vc.text('settings_memory_confirm_delete')}
        tone="danger"
        disabled={memory.busy}
        onClick={() => {
          void vc.doMemoryEdit('delete', props.layer, props.id, {})
        }}
      />
      <TextButton
        label={vc.text('settings_memory_cancel')}
        onClick={() => {
          memory.confirmDelete = null
          vc.render()
        }}
      />
    </div>
  )
}

function EditErrorBar() {
  const vc = useVc()
  const error = vc.state.memory.editError
  return (
    <div className="settings-error" role="alert">
      <Icon name="alert-circle" size={16} />
      <span>{vc.text(error.code)}</span>
      <TextButton
        label={vc.text('settings_retry')}
        onClick={() => {
          void vc.doMemoryEdit(error.action, error.layer, error.id, error.patch)
        }}
      />
    </div>
  )
}

function SearchErrorBar() {
  const vc = useVc()
  return (
    <div className="settings-error" role="alert">
      <Icon name="alert-circle" size={16} />
      <span>{vc.text('settings_memory_search_failed')}</span>
      <TextButton label={vc.text('settings_retry')} onClick={() => void vc.doMemorySearch()} />
    </div>
  )
}

function textOf(value: any): string {
  return typeof value === 'string' ? value : ''
}
