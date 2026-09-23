// 编排页（编排图只读视图 + 回滚入口）：图 / Scope 名录 / 编排健康 / 进化台账。
// 健康判定住本插件 execute 服务，本页只渲染 `orchestration.health` 的结构化结果。

import { DependencyMissing, EmptyState, Icon, TextButton, useVc } from './ui.tsx'
import { isRecord } from '../config-model.ts'
import {
  graphView,
  HEALTH_UNHEALTHY,
  HEALTH_WARNING,
  healthView,
  ledgerSummary,
  scopeList,
  shortHash,
} from '../health.ts'

export function OrchestrationPanel() {
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
  return (
    <div className="settings-section">
      <GroupName nameKey="settings_orch_graph" />
      <div className="settings-list-meta">{`${vc.text('settings_orch_contract')} ${shortHash(view.contractId)}`}</div>
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
        {scopes.map((scope: any) => {
          const meta = [
            `${vc.text('settings_orch_contract')} ${shortHash(scope.contract_id)}`,
            `${vc.text('settings_orch_persona')} ${scope.persona.length > 0 ? scope.persona : '-'}`,
            `${vc.text('settings_orch_scope')} ${scope.scope === 'global' ? vc.text('settings_orch_scope_global') : scope.scope}`,
            `${vc.text('settings_orch_autonomy')} ${scope.autonomy.length > 0 ? scope.autonomy : '-'}`,
          ]
          if (scope.links.length > 0) meta.push(`${vc.text('settings_orch_links')} ${scope.links}`)
          meta.push(`${vc.text('settings_orch_success')} ${scope.success_rate === null ? '-' : `${Math.round(scope.success_rate * 100)}%`}`)
          return (
            <div className="settings-list-item" key={scope.id}>
              <span className="settings-list-main">{scope.id}</span>
              {meta.map((text, index) => (
                <span className="settings-list-meta" key={index}>
                  {text}
                </span>
              ))}
            </div>
          )
        })}
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
  return (
    <div className="settings-section">
      <GroupName nameKey="settings_orch_health" />
      <HealthRow health={health} />
      {health.codes.length > 0 ? (
        <div className="settings-list-meta">{health.codes.map((item: any) => `${item.code} ×${item.count}`).join(' · ')}</div>
      ) : null}
      <RollbackActions health={health} />
      {vc.state.rollbackNote !== null ? <RollbackNote /> : null}
    </div>
  )
}

function HealthRow(props: { health: any }) {
  const vc = useVc()
  const health = props.health
  const tone = health.status === HEALTH_UNHEALTHY ? 'danger' : health.status === HEALTH_WARNING ? 'warning' : 'success'
  const label =
    health.status === HEALTH_UNHEALTHY
      ? vc.text('settings_orch_unhealthy')
      : health.status === HEALTH_WARNING
        ? vc.text('settings_orch_warning')
        : vc.text('settings_orch_healthy')
  return (
    <div className="settings-row">
      <span className="settings-row-label">{label}</span>
      <span className="settings-row-value">
        <span className="settings-dot" data-tone={tone} />
        <span>{vc.text('settings_orch_consecutive', { count: health.consecutive })}</span>
        {health.threshold !== null ? (
          <span className="settings-list-meta">{vc.text('settings_orch_threshold', { count: health.threshold })}</span>
        ) : null}
        <span className="settings-list-meta">
          {vc.text(health.thresholdSource === 'loop-policy' ? 'settings_orch_threshold_loop' : 'settings_orch_threshold_default')}
        </span>
      </span>
    </div>
  )
}

function RollbackActions(props: { health: any }) {
  const vc = useVc()
  const target = props.health.rollback
  return (
    <div className="settings-guide-actions">
      <TextButton
        label={vc.state.rollbackConfirm ? vc.text('settings_orch_rollback_confirm') : vc.text('settings_orch_rollback')}
        tone="danger"
        disabled={vc.state.rollbackBusy || target === null}
        onClick={async () => {
          if (!vc.state.rollbackConfirm) {
            vc.state.rollbackConfirm = true
            vc.render()
            return
          }
          vc.state.rollbackConfirm = false
          await vc.doRollback()
        }}
      >
        {vc.state.rollbackBusy ? <span className="settings-breathe-ring" /> : null}
      </TextButton>
    </div>
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
      <TextButton label={vc.text('settings_retry')} onClick={() => void vc.doRollback()} />
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
              {entries.map((entry: any) => {
                const summary = ledgerSummary(kind, entry)
                const detailKey = `${kind}:${summary.id}`
                const open = vc.state.ledgerOpen === detailKey
                return (
                  <div key={detailKey}>
                    <div
                      className="settings-list-item"
                      onClick={() => {
                        vc.state.ledgerOpen = open ? null : detailKey
                        vc.render()
                      }}
                    >
                      <span className="settings-list-main">{`${summary.id} · ${summary.label}`}</span>
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
  const entry = props.entry
  const rows: string[] = []
  const push = (label: string, values: any) => {
    if (!Array.isArray(values) || values.length === 0) return
    rows.push(`${label} ${values.join(', ')}`)
  }
  if (props.kind === 'verdicts') {
    push('proposal', entry.proposal_ids)
    push('evidence', entry.evidence_ids)
    if (isRecord(entry.gate)) {
      const gate = [entry.gate.mechanical, entry.gate.reason, entry.gate.human].filter(
        (part) => typeof part === 'string' && part.length > 0,
      )
      if (gate.length > 0) rows.push(`gate ${gate.join(' · ')}`)
    }
    if (Number.isInteger(entry.adopted_gen)) rows.push(`gen ${entry.adopted_gen}`)
  } else if (props.kind === 'proposals') {
    push('evidence', entry.evidence_ids)
    if (isRecord(entry.patch) && typeof entry.patch.def === 'string') rows.push(`patch ${entry.patch.def}`)
  } else {
    push('trace', Array.isArray(entry.traces) ? entry.traces.map((item: any) => (isRecord(item) ? item.def : null)) : [])
    if (isRecord(entry.cluster_key) && typeof entry.cluster_key.attributable_to === 'string') {
      rows.push(`attributable_to ${entry.cluster_key.attributable_to}`)
    }
  }
  if (typeof entry.at === 'string' && entry.at.length > 0) rows.push(entry.at)
  return <div className="settings-list-meta">{rows.length > 0 ? rows.join(' · ') : '-'}</div>
}
