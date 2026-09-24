// 设置模态外壳：左侧导航分组 + 右侧内容区；开合、焦点陷阱、背景 aria-hidden、Esc 关闭。
// 各 tab 内容由 `panelOf` 分发；开合状态住 store，壳经 uiState 同步。

import { useEffect, useRef } from 'react'
import { BlockLoading, ErrorBar, Icon, IconButton, PanelHead, VcContext, useVc } from './ui.tsx'
import { TABS } from '../settings-model.ts'
import { HEALTH_OK, healthView } from '../health.ts'
import { GeneralPanel } from './General.tsx'
import { ModelPanel } from './Model.tsx'
import { PluginsPanel } from './Plugins.tsx'
import { SkillsPanel } from './Skills.tsx'
import { MemoryPanel } from './Memory.tsx'
import { OrchestrationPanel } from './Orchestration.tsx'
import { AboutPanel } from './About.tsx'
import { Onboarding } from './Onboarding.tsx'

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

export function App() {
  const vc = useVc()
  const mode = vc.state.mode
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 模态打开：背景 aria-hidden + 焦点移入 + Esc 关闭 + Tab 焦点陷阱；关闭时归还焦点。
  useEffect(() => {
    if (mode === 'closed') return undefined
    const doc = vc.doc
    const previous = doc.activeElement
    const shellRoot = doc.getElementById('shell-root')
    if (shellRoot !== null) shellRoot.setAttribute('aria-hidden', 'true')
    focusFirst(rootRef.current)
    const onKeydown = (event: any) => {
      if (event.key === 'Escape') {
        if (mode === 'settings') vc.closeOverlay()
        return
      }
      if (event.key !== 'Tab') return
      const root = rootRef.current
      if (root === null) return
      const focusables = root.querySelectorAll(FOCUSABLE)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = doc.activeElement
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault()
          ;(last as HTMLElement).focus()
        }
      } else if (active === last || !root.contains(active)) {
        event.preventDefault()
        ;(first as HTMLElement).focus()
      }
    }
    doc.addEventListener('keydown', onKeydown)
    return () => {
      doc.removeEventListener('keydown', onKeydown)
      if (shellRoot !== null) shellRoot.removeAttribute('aria-hidden')
      if (previous !== null && typeof previous.focus === 'function' && doc.contains(previous)) previous.focus()
    }
  }, [mode])

  // 保存高亮：150ms 后清位。
  useEffect(() => {
    if (vc.state.savedKey === null) return undefined
    const timer = setTimeout(() => {
      vc.state.savedKey = null
      vc.render()
    }, 150)
    return () => clearTimeout(timer)
  }, [vc.state.savedKey])

  if (mode === 'closed') return null
  return (
    <div className="settings-root" ref={rootRef}>
      {mode === 'onboarding' ? <Onboarding /> : <SettingsShell />}
      <div className="settings-sr" aria-live="polite" aria-atomic="true">
        {vc.state.liveText}
      </div>
    </div>
  )
}

function focusFirst(root: HTMLDivElement | null): void {
  if (root === null) return
  const focusable = root.querySelector(FOCUSABLE)
  if (focusable !== null && typeof (focusable as HTMLElement).focus === 'function') (focusable as HTMLElement).focus()
}

function SettingsShell() {
  const vc = useVc()
  const warn = shouldWarnHealth(vc)

  const selectTab = (id: string) => {
    vc.state.tab = id
    vc.state.error = null
    vc.state.loadError = null
    vc.state.rollbackConfirm = false
    vc.render()
    void vc.loadTab(id)
  }

  // 方向键 / Home / End 在 tab 间移动焦点与选中项（roving tabindex）。
  const onTabKeyDown = (event: any) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const current = TABS.findIndex((tab) => tab.id === vc.state.tab)
    let next = current
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1) % TABS.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else next = TABS.length - 1
    const target = TABS[next]
    selectTab(target.id)
    const doc = vc.doc
    const button = doc === null || doc === undefined ? null : doc.getElementById(`settings-tab-${target.id}`)
    if (button !== null && typeof button.focus === 'function') button.focus()
  }

  return (
    <>
      <div className="settings-backdrop" onClick={() => vc.closeOverlay()} />
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label={vc.text('settings_title')}>
        <div className="settings-nav">
          <div className="settings-nav-head">
            <span className="settings-nav-title">{vc.text('settings_title')}</span>
            <IconButton name="x" label={vc.text('settings_close')} onClick={() => vc.closeOverlay()} />
          </div>
          <div role="tablist" onKeyDown={onTabKeyDown}>
            {TABS.map((tab) => (
              <button
                type="button"
                className="settings-tab"
                key={tab.id}
                id={`settings-tab-${tab.id}`}
                role="tab"
                aria-selected={vc.state.tab === tab.id ? 'true' : 'false'}
                aria-controls="settings-tabpanel"
                tabIndex={vc.state.tab === tab.id ? 0 : -1}
                data-tab={tab.id}
                onClick={() => selectTab(tab.id)}
              >
                <Icon name={tab.icon} size={16} />
                <span>{vc.text(`settings_tab_${tab.id}`)}</span>
                {tab.id === 'orchestration' && warn ? <span className="settings-tab-dot" /> : null}
              </button>
            ))}
          </div>
        </div>
        <div
          className="settings-content settings-content-fade"
          role="tabpanel"
          id="settings-tabpanel"
          aria-labelledby={`settings-tab-${vc.state.tab}`}
          key={vc.state.tab}
        >
          <PanelHead titleKey={`settings_tab_${vc.state.tab}`} descKey={`settings_desc_${vc.state.tab}`} />
          <TabContent />
        </div>
      </div>
    </>
  )
}

function TabContent() {
  const vc = useVc()
  if (vc.state.loading) return <BlockLoading note={vc.state.loadingNote} />
  // 页面级装载错误：替换整个 tab，可重试重拉。
  if (vc.state.loadError !== null && vc.state.loadError.code !== null) {
    return (
      <ErrorBar
        code={vc.state.loadError.code}
        onRetry={() => {
          vc.state.loadError = null
          vc.render()
          void vc.loadTab(vc.state.tab)
        }}
      />
    )
  }
  let panel: any
  switch (vc.state.tab) {
    case 'general':
      panel = <GeneralPanel />
      break
    case 'model':
      panel = <ModelPanel />
      break
    case 'plugins':
      panel = <PluginsPanel />
      break
    case 'skills':
      panel = <SkillsPanel />
      break
    case 'memory':
      panel = <MemoryPanel />
      break
    case 'orchestration':
      panel = <OrchestrationPanel />
      break
    default:
      panel = <AboutPanel />
      break
  }
  // 行内动作错误：不替换 tab 内容，只在其上方显一条行内条，避免抹掉用户已填输入。
  return (
    <>
      {vc.state.error !== null ? <ErrorBar code={vc.state.error.code} /> : null}
      {panel}
    </>
  )
}

function shouldWarnHealth(vc: any): boolean {
  if (vc.state.orch.degraded.health === true) return false
  return healthView(vc.state.orch.health).status !== HEALTH_OK
}

export { VcContext }
