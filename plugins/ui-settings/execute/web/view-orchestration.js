// 编排页（编排图只读视图 + 回滚入口）：图 / Scope 名录 / 编排健康 / 进化台账。
// 健康判定住本插件 execute 服务，本页只渲染 `orchestration.health` 的结构化结果；回滚后不可验证时只显「回滚未验证」。

import { el, icon, textButton } from './dom.js'
import { dependencyMissing, emptyState } from './ui-parts.js'
import { isRecord } from './config-model.js'
import {
  graphView,
  HEALTH_UNHEALTHY,
  HEALTH_WARNING,
  healthView,
  ledgerSummary,
  scopeList,
  shortHash,
} from './health.js'

export function renderOrchestration(ctx, content) {
  content.appendChild(graphSection(ctx))
  content.appendChild(scopeSection(ctx))
  content.appendChild(healthSection(ctx))
  content.appendChild(ledgerSection(ctx))
}

function groupName(ctx, key) {
  return el(ctx.doc, 'div', { class: 'settings-group-name', text: ctx.text(key) })
}

function graphSection(ctx) {
  const doc = ctx.doc
  const node = el(doc, 'div', { class: 'settings-section' })
  node.appendChild(groupName(ctx, 'settings_orch_graph'))
  if (ctx.state.orch.degraded.graph) {
    node.appendChild(dependencyMissing(ctx))
    return node
  }
  const view = graphView(ctx.state.orch.graph)
  if (view.nodes.length === 0) {
    node.appendChild(emptyState(ctx, 'settings_orch_no_graph'))
    return node
  }
  node.appendChild(
    el(doc, 'div', { class: 'settings-list-meta', text: `${ctx.text('settings_orch_contract')} ${shortHash(view.contractId)}` }),
  )
  const list = el(doc, 'div', { class: 'settings-list' })
  for (const graphNode of view.nodes) {
    list.appendChild(
      el(doc, 'div', { class: 'settings-list-item' }, [
        el(doc, 'span', { class: 'settings-list-main', text: `#${graphNode.index} ${graphNode.contract_id}` }),
        el(doc, 'span', { class: 'settings-list-meta', text: graphNode.impl }),
      ]),
    )
  }
  for (const edge of view.edges) {
    list.appendChild(
      el(doc, 'div', { class: 'settings-list-item' }, [
        el(doc, 'span', { class: 'settings-list-main', text: `${edge.from} -> ${edge.to}` }),
        el(doc, 'span', { class: 'settings-list-meta', text: edge.when }),
      ]),
    )
  }
  node.appendChild(list)
  return node
}

function scopeSection(ctx) {
  const doc = ctx.doc
  const node = el(doc, 'div', { class: 'settings-section' })
  node.appendChild(groupName(ctx, 'settings_orch_scopes'))
  if (ctx.state.orch.degraded.scopes) {
    node.appendChild(dependencyMissing(ctx))
    return node
  }
  const scopes = scopeList(ctx.state.orch.scopes)
  if (scopes.length === 0) {
    node.appendChild(emptyState(ctx, 'settings_orch_no_scopes'))
    return node
  }
  const list = el(doc, 'div', { class: 'settings-list' })
  for (const scope of scopes) list.appendChild(scopeRow(ctx, scope))
  node.appendChild(list)
  return node
}

function scopeRow(ctx, scope) {
  const doc = ctx.doc
  const meta = [
    `${ctx.text('settings_orch_contract')} ${shortHash(scope.contract_id)}`,
    `${ctx.text('settings_orch_persona')} ${scope.persona.length > 0 ? scope.persona : '-'}`,
    `${ctx.text('settings_orch_scope')} ${
      scope.scope === 'global' ? ctx.text('settings_orch_scope_global') : scope.scope
    }`,
    `${ctx.text('settings_orch_autonomy')} ${scope.autonomy.length > 0 ? scope.autonomy : '-'}`,
  ]
  if (scope.links.length > 0) meta.push(`${ctx.text('settings_orch_links')} ${scope.links}`)
  meta.push(
    `${ctx.text('settings_orch_success')} ${scope.success_rate === null ? '-' : `${Math.round(scope.success_rate * 100)}%`}`,
  )
  return el(doc, 'div', { class: 'settings-list-item' }, [
    el(doc, 'span', { class: 'settings-list-main', text: scope.id }),
    ...meta.map((text) => el(doc, 'span', { class: 'settings-list-meta', text })),
  ])
}

function healthSection(ctx) {
  const doc = ctx.doc
  const node = el(doc, 'div', { class: 'settings-section' })
  node.appendChild(groupName(ctx, 'settings_orch_health'))
  if (ctx.state.orch.degraded.health) {
    node.appendChild(dependencyMissing(ctx))
    return node
  }
  const health = healthView(ctx.state.orch.health)
  node.appendChild(healthRow(ctx, health))
  if (health.codes.length > 0) {
    node.appendChild(
      el(doc, 'div', {
        class: 'settings-list-meta',
        text: health.codes.map((item) => `${item.code} ×${item.count}`).join(' · '),
      }),
    )
  }
  node.appendChild(rollbackActions(ctx, health))
  if (ctx.state.rollbackNote !== null) node.appendChild(rollbackNote(ctx))
  return node
}

function healthRow(ctx, health) {
  const doc = ctx.doc
  const tone =
    health.status === HEALTH_UNHEALTHY ? 'danger' : health.status === HEALTH_WARNING ? 'warning' : 'success'
  const label =
    health.status === HEALTH_UNHEALTHY
      ? ctx.text('settings_orch_unhealthy')
      : health.status === HEALTH_WARNING
        ? ctx.text('settings_orch_warning')
        : ctx.text('settings_orch_healthy')
  const value = el(doc, 'span', { class: 'settings-row-value' }, [
    el(doc, 'span', { class: 'settings-dot', dataset: { tone } }),
    el(doc, 'span', { text: ctx.text('settings_orch_consecutive', { count: health.consecutive }) }),
    health.threshold !== null
      ? el(doc, 'span', { class: 'settings-list-meta', text: ctx.text('settings_orch_threshold', { count: health.threshold }) })
      : null,
    el(doc, 'span', {
      class: 'settings-list-meta',
      text: ctx.text(health.thresholdSource === 'loop-policy' ? 'settings_orch_threshold_loop' : 'settings_orch_threshold_default'),
    }),
  ])
  return el(doc, 'div', { class: 'settings-row' }, [
    el(doc, 'span', { class: 'settings-row-label', text: label }),
    value,
  ])
}

function rollbackActions(ctx, health) {
  const doc = ctx.doc
  const target = health.rollback
  const button = textButton(
    doc,
    ctx.state.rollbackConfirm ? ctx.text('settings_orch_rollback_confirm') : ctx.text('settings_orch_rollback'),
    async () => {
      if (!ctx.state.rollbackConfirm) {
        ctx.state.rollbackConfirm = true
        ctx.render()
        return
      }
      ctx.state.rollbackConfirm = false
      await ctx.doRollback()
    },
    { tone: 'danger', disabled: ctx.state.rollbackBusy || target === null },
  )
  if (ctx.state.rollbackBusy) button.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  return el(doc, 'div', { class: 'settings-guide-actions' }, [button])
}

function rollbackNote(ctx) {
  const doc = ctx.doc
  const note = ctx.state.rollbackNote
  if (note.tone !== 'danger') return el(doc, 'div', { class: 'settings-muted', text: note.text })
  return el(doc, 'div', { class: 'settings-error', attrs: { role: 'alert' } }, [
    icon(doc, 'alert-circle', 16),
    el(doc, 'span', { text: note.text }),
    textButton(doc, ctx.text('settings_retry'), () => void ctx.doRollback()),
  ])
}

function ledgerSection(ctx) {
  const doc = ctx.doc
  const node = el(doc, 'div', { class: 'settings-section' })
  node.appendChild(groupName(ctx, 'settings_orch_ledger'))
  if (ctx.state.orch.degraded.health) {
    node.appendChild(dependencyMissing(ctx))
    return node
  }
  // 台账随 `orchestration.health` 结果返回（服务侧已走完三条 tail）；缺字段时按空态处理，不假装「暂无台账」。
  const lists = healthView(ctx.state.orch.health).ledger
  let any = false
  for (const [kind, key] of [
    ['verdicts', 'settings_orch_verdicts'],
    ['proposals', 'settings_orch_proposals'],
    ['evidence', 'settings_orch_evidence'],
  ]) {
    const entries = lists[kind]
    if (entries.length === 0) continue
    any = true
    node.appendChild(groupName(ctx, key))
    const list = el(doc, 'div', { class: 'settings-list' })
    for (const entry of entries) {
      const summary = ledgerSummary(kind, entry)
      const detailKey = `${kind}:${summary.id}`
      const open = ctx.state.ledgerOpen === detailKey
      const main = el(doc, 'div', { class: 'settings-list-item' }, [
        el(doc, 'span', { class: 'settings-list-main', text: `${summary.id} · ${summary.label}` }),
        el(doc, 'span', { class: 'settings-list-meta', text: summary.detail }),
      ])
      main.addEventListener('click', () => {
        ctx.state.ledgerOpen = open ? null : detailKey
        ctx.render()
      })
      list.appendChild(main)
      if (open) list.appendChild(ledgerDetail(ctx, kind, entry))
    }
    node.appendChild(list)
  }
  if (!any) node.appendChild(emptyState(ctx, 'settings_orch_no_ledger'))
  return node
}

/** 逐级下钻：判定 → proposal / evidence → trace 引用；提案 → evidence；证据 → trace。 */
function ledgerDetail(ctx, kind, entry) {
  const doc = ctx.doc
  const rows = []
  const push = (label, values) => {
    if (!Array.isArray(values) || values.length === 0) return
    rows.push(`${label} ${values.join(', ')}`)
  }
  if (kind === 'verdicts') {
    push('proposal', entry.proposal_ids)
    push('evidence', entry.evidence_ids)
    if (isRecord(entry.gate)) {
      const gate = [entry.gate.mechanical, entry.gate.reason, entry.gate.human].filter(
        (part) => typeof part === 'string' && part.length > 0,
      )
      if (gate.length > 0) rows.push(`gate ${gate.join(' · ')}`)
    }
    if (Number.isInteger(entry.adopted_gen)) rows.push(`gen ${entry.adopted_gen}`)
  } else if (kind === 'proposals') {
    push('evidence', entry.evidence_ids)
    if (isRecord(entry.patch) && typeof entry.patch.def === 'string') rows.push(`patch ${entry.patch.def}`)
  } else {
    push('trace', Array.isArray(entry.traces) ? entry.traces.map((item) => (isRecord(item) ? item.def : null)) : [])
    if (isRecord(entry.cluster_key) && typeof entry.cluster_key.attributable_to === 'string') {
      rows.push(`attributable_to ${entry.cluster_key.attributable_to}`)
    }
  }
  if (typeof entry.at === 'string' && entry.at.length > 0) rows.push(entry.at)
  return el(doc, 'div', { class: 'settings-list-meta', text: rows.length > 0 ? rows.join(' · ') : '-' })
}
