// 编排页（编排图只读视图 + 回滚入口）：图 / Scope 名录 / 编排健康 / 进化台账。
// 健康判定住本插件 execute 服务，本页只渲染 `orchestration.health` 的结构化结果。

import { useEffect } from 'react'
import { DependencyMissing, EmptyState, Icon, TextButton, useVc } from './ui.tsx'
import {
  graphMeta,
  graphView,
  HEALTH_UNHEALTHY,
  HEALTH_WARNING,
  healthView,
  ledgerDetailText,
  ledgerSummary,
  ledgerTitle,
  scopeList,
  scopeMeta,
} from '../health.ts'

/** 回滚二次确认的自动取消时长（与停靠带确认态同档）。 */
const ROLLBACK_CONFIRM_TTL_MS = 3000

export function OrchestrationPanel() {
  const vc = useVc()
  // 回滚确认态：3s 自动取消 + 点击确认按钮以外处取消。
  useEffect(() => {
    if (!vc.state.rollbackConfirm) return undefined
    const timer = setTimeout(() => {
      vc.state.rollbackConfirm = false
      vc.render()
    }, ROLLBACK_CONFIRM_TTL_MS)
    const onClick = (event: any) => {
      const target = event.target
      if (target !== null && typeof target.closest === 'function' && target.closest('[data-rollback-armed="true"]') !== null) return
      vc.state.rollbackConfirm = false
      vc.render()
    }
    const doc = vc.doc
    if (doc !== null && doc !== undefined) doc.addEventListener('click', onClick)
    return () => {
      clearTimeout(timer)
      if (doc !== null && doc !== undefined) doc.removeEventListener('click', onClick)
    }
  }, [vc.state.rollbackConfirm])
  return (
    <>
      <GraphSection />
      <ScopeSection />
      <HealthSection />
      <LedgerSection />
    </>
  )
}

function GroupName(props: { nameKey: string }) {
  const vc = useVc()
  return <div className="settings-group-name">{vc.text(props.nameKey)}</div>
}

function GraphSection() {
  const vc = useVc()
  if (vc.state.orch.degraded.graph) {
    return (
      <div className="settings-section">
        <GroupName nameKey="settings_orch_graph" />
        <DependencyMissing />
      </div>
    )
  }
  const view = graphView(vc.state.orch.graph)
  if (view.nodes.length === 0) {
    return (
      <div className="settings-section">
        <GroupName nameKey="settings_orch_graph" />
        <EmptyState nameKey="settings_orch_no_graph" />
      </div>
    )
  }
  const meta = graphMeta(view, vc.text)
  return (
    <div className="settings-section">
      <GroupName nameKey="settings_orch_graph" />
      <div className="settings-list-meta">{meta}</div>
      <div className="settings-list">
        {view.nodes.map((node: any) => (
          <div className="settings-list-item" key={`n${node.index}`}>
            <span className="settings-list-main">{`#${node.index} ${node.contract_id}`}</span>
            <span className="settings-list-meta">{node.impl}</span>
          </div>
        ))}
        {view.edges.map((edge: any, index: number) => (
          <div className="settings-list-item" key={`e${index}`}>
            <span className="settings-list-main">{`${edge.from} -> ${edge.to}`}</span>
            <span className="settings-list-meta">{edge.when}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ScopeSection() {
  const vc = useVc()
  if (vc.state.orch.degraded.scopes) {
    return (
      <div className="settings-section">
        <GroupName nameKey="settings_orch_scopes" />
        <DependencyMissing />
      </div>
    )
  }
  const scopes = scopeList(vc.state.orch.scopes)
  if (scopes.length === 0) {
    return (
      <div className="settings-section">
        <GroupName nameKey="settings_orch_scopes" />
        <EmptyState nameKey="settings_orch_no_scopes" />
      </div>
    )
  }
  return (
    <div className="settings-section">
      <GroupName nameKey="settings_orch_scopes" />
      <div className="settings-list">
        {scopes.map((scope: any) => (
          <div className="settings-list-item" key={`${scope.id}#${scope.index}`}>
            <span className="settings-list-main">{scope.id}</span>
            <span className="settings-list-meta">{scopeMeta(scope, vc.text)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HealthSection() {
  const vc = useVc()
  if (vc.state.orch.degraded.health) {
    return (
      <div className="settings-section">
        <GroupName nameKey="settings_orch_health" />
        <DependencyMissing />
      </div>
    )
  }
  const health = healthView(vc.state.orch.health)
  const tone = health.status === HEALTH_UNHEALTHY ? 'danger' : health.status === HEALTH_WARNING ? 'warning' : 'success'
  const label =
    health.status === HEALTH_UNHEALTHY
      ? vc.text('settings_orch_unhealthy')
      : health.status === HEALTH_WARNING
        ? vc.text('settings_orch_warning')
        : vc.text('settings_orch_healthy')
  return (
    <div className="settings-section">
      <GroupName nameKey="settings_orch_health" />
      <div className="settings-health-card">
        <div className="settings-health-head">
          <span className="settings-health-status">
            <span className="settings-dot" data-tone={tone} />
            <span>{label}</span>
          </span>
          <span className="settings-health-metrics">
            <span className="settings-list-meta">{vc.text('settings_orch_consecutive', { count: health.consecutive })}</span>
            {health.threshold !== null ? (
              <>
                <span className="settings-list-meta">{vc.text('settings_orch_threshold', { count: health.threshold })}</span>
                <span className="settings-list-meta">
                  {vc.text(health.thresholdSource === 'loop-policy' ? 'settings_orch_threshold_loop' : 'settings_orch_threshold_default')}
                </span>
              </>
            ) : null}
          </span>
        </div>
        {health.codes.length > 0 ? (
          <div>
            <div className="settings-group-name">{vc.text('settings_orch_codes')}</div>
            <div className="settings-code-chips">
              {health.codes.map((item: any) => (
                <span className="settings-code-chip" key={item.code}>
                  <span className="settings-code-chip-name">{item.code}</span>
                  <span className="settings-code-chip-count">{`×${item.count}`}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="settings-rollback">
        <span className="settings-list-meta">{vc.text('settings_orch_rollback_hint')}</span>
        <RollbackActions health={health} />
      </div>
      {vc.state.rollbackNote !== null ? <RollbackNote /> : null}
    </div>
  )
}

function RollbackActions(props: { health: any }) {
  const vc = useVc()
  const target = props.health.rollback
  return (
    <span data-rollback-armed={vc.state.rollbackConfirm ? 'true' : undefined}>
      <TextButton
        label={vc.state.rollbackConfirm ? vc.text('settings_orch_rollback_confirm') : vc.text('settings_orch_rollback')}
        tone="danger"
        disabled={vc.state.rollbackBusy || target === null}
        onClick={() => vc.requestRollback()}
      >
        {vc.state.rollbackBusy ? <span className="settings-breathe-ring" /> : null}
      </TextButton>
    </span>
  )
}

function RollbackNote() {
  const vc = useVc()
  const note = vc.state.rollbackNote
  if (note.tone !== 'danger') return <div className="settings-muted">{note.text}</div>
  return (
    <div className="settings-error" role="alert">
      <Icon name="alert-circle" size={16} />
      <span>{note.text}</span>
      <span data-rollback-armed={vc.state.rollbackConfirm ? 'true' : undefined}>
        <TextButton
          label={vc.state.rollbackConfirm ? vc.text('settings_orch_rollback_confirm') : vc.text('settings_retry')}
          onClick={() => vc.requestRollback()}
        />
      </span>
    </div>
  )
}

function LedgerSection() {
  const vc = useVc()
  if (vc.state.orch.degraded.health) {
    return (
      <div className="settings-section">
        <GroupName nameKey="settings_orch_ledger" />
        <DependencyMissing />
      </div>
    )
  }
  const lists = healthView(vc.state.orch.health).ledger
  const kinds: [string, string][] = [
    ['verdicts', 'settings_orch_verdicts'],
    ['proposals', 'settings_orch_proposals'],
    ['evidence', 'settings_orch_evidence'],
  ]
  const any = kinds.some(([kind]) => lists[kind].length > 0)
  const toggleLedger = (key: string, open: boolean) => {
    vc.state.ledgerOpen = open ? null : key
    vc.render()
  }
  return (
    <div className="settings-section">
      <GroupName nameKey="settings_orch_ledger" />
      {kinds.map(([kind, key]) => {
        const entries = lists[kind]
        if (entries.length === 0) return null
        return (
          <div key={kind}>
            <GroupName nameKey={key} />
            <div className="settings-list">
              {entries.map((entry: any, index: number) => {
                const summary = ledgerSummary(kind, entry)
                const detailKey = `${kind}:${summary.id}#${index}`
                const open = vc.state.ledgerOpen === detailKey
                return (
                  <div key={detailKey}>
                    <div
                      className="settings-list-item"
                      role="button"
                      tabIndex={0}
                      aria-expanded={open ? 'true' : 'false'}
                      onClick={() => toggleLedger(detailKey, open)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        toggleLedger(detailKey, open)
                      }}
                    >
                      <span className="settings-list-main">{ledgerTitle(summary)}</span>
                      <span className="settings-list-meta">{summary.detail}</span>
                    </div>
                    {open ? <LedgerDetail kind={kind} entry={entry} /> : null}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      {!any ? <EmptyState nameKey="settings_orch_no_ledger" /> : null}
    </div>
  )
}

/** 逐级下钻：判定 → proposal / evidence → trace 引用；提案 → evidence；证据 → trace。 */
function LedgerDetail(props: { kind: string; entry: any }) {
  return <div className="settings-list-meta">{ledgerDetailText(props.kind, props.entry)}</div>
}
