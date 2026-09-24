// `ui-approval` 客户端半边：注册进壳 `dock` 槽的 React 组件（契约 v2）。
// 业务状态住 React-free store（`store.ts`）；组件只渲染 store 快照 + 纯模型视图。
// 停靠带：0 高度起步，有待审批项才渲染；多条按队列 + 计数 + 整批裁决；键盘可达 + aria。

import { useEffect, useState } from 'react'
import type { SlotContext } from '@chrono/ui-contract'
import {
  confirmArmed,
  CONFIRM_APPROVE_ALL,
  CONFIRM_DENY_ALL,
  diffItemKey,
  diffItemText,
  elapsedMs,
  fileKey,
  fileText,
  formatWait,
  graphDiffText,
  isPending,
  itemPresentation,
  itemTone,
  oldestPending,
  waitWarning,
} from './model'
import type { Rec, View } from './model'
import { formatText, messageText } from './messages'
import { createApprovalStore } from './store'
import type { ApprovalSnapshot, ApprovalStore } from './store'

export const contract = '2'

export function register(ctx: SlotContext): void {
  const store = createApprovalStore(ctx)
  store.start()
  const registered = ctx.slots.register({ name: 'dock' }, function ApprovalDock() {
    useEffect(() => () => store.dispose(), [])
    return <Dock ctx={ctx} store={store} />
  })
  // 注册被拒（陈旧装载）：刚 start 的 store 立即 dispose，避免第二份在途。
  if (registered !== true) store.dispose()
}

type T = (code: string, vars?: Record<string, unknown>) => string

function translator(table: unknown): T {
  return (code, vars) => (vars === undefined ? messageText(table, code) : formatText(table, code, vars))
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <use href={`/assets/icons.v2.svg#${name}`} />
    </svg>
  )
}

function TextButton(props: {
  label: string
  onClick: () => void
  tone?: string
  busy?: boolean
  busyLabel?: string
  disabled?: boolean
  armed?: boolean
  title?: string
  ariaLabel?: string
  className?: string
}) {
  const { label, onClick, tone, busy, busyLabel, disabled, armed, title, ariaLabel, className } = props
  return (
    <button
      type="button"
      className={className ?? 'approval-btn'}
      data-tone={tone}
      data-busy={busy ? 'true' : undefined}
      data-armed={armed ? 'true' : undefined}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {busy ? (
        <>
          <span className="approval-breathe-ring" />
          {busyLabel}
        </>
      ) : (
        label
      )}
    </button>
  )
}

function Dock({ ctx, store }: { ctx: SlotContext; store: ApprovalStore }) {
  const snapshot = ctx.useStore(store)
  const t = translator(snapshot.table)
  const [now, setNow] = useState(() => Date.now())
  const [live, setLive] = useState('')

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') store.resetConfirm()
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target !== null && typeof target.closest === 'function' && target.closest('[data-armed="true"]') !== null) return
      store.resetConfirm()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onClick)
    }
  }, [store])

  const pending = snapshot.items.filter(isPending)
  const count = pending.length

  useEffect(() => {
    if (count === 0) {
      setLive('')
      return undefined
    }
    setLive('')
    const timer = setTimeout(() => setLive(formatText(snapshot.table, 'approval_waiting', { count })), 0)
    return () => clearTimeout(timer)
  }, [count, snapshot.table])

  if (snapshot.loading && snapshot.items.length === 0) {
    return (
      <div className="approval-root">
        <div className="approval-dock">
          <div className="approval-head">
            <span className="approval-head-count">{t('approval_loading')}</span>
          </div>
        </div>
      </div>
    )
  }
  // 无待审批项：不占高度、不渲染。
  if (count === 0) return null

  const oldest = oldestPending(snapshot.items)
  const waited = oldest === null ? null : elapsedMs({ at: new Date(oldest).toISOString() }, now)
  const warn = waited !== null && waitWarning(waited)
  const waitText = waited === null ? '' : t('approval_waited', { time: formatWait(waited) })

  return (
    <div className="approval-root">
      <div className="approval-dock" role="region" aria-label={t('approval_dock_label')}>
        <div className="approval-head">
          <span className="approval-head-count">
            <Icon name="list" size={16} />
            <span>{t('approval_waiting', { count })}</span>
          </span>
          <span className="approval-head-wait" data-warn={warn ? 'true' : 'false'}>
            {waitText}
          </span>
          <span className="approval-head-spacer" />
          <HeadButton kind={CONFIRM_DENY_ALL} count={count} tone="danger" store={store} snapshot={snapshot} t={t} />
          <HeadButton kind={CONFIRM_APPROVE_ALL} count={count} tone="accent" store={store} snapshot={snapshot} t={t} />
        </div>
        {snapshot.error !== null && (
          <div className="approval-danger-inline" data-role="batch-error" data-source={snapshot.error.kind}>
            <span>{t('approval_failed')}</span>
            <TextButton
              label={t('approval_retry')}
              disabled={snapshot.busy.length > 0}
              onClick={() => {
                const error = snapshot.error
                if (error === null) return
                if (error.kind === 'batch' && snapshot.lastBatch !== null) store.submitAll(snapshot.lastBatch)
                else store.load()
              }}
            />
          </div>
        )}
        <div className="approval-list">
          {pending.map((item) => (
            <Item key={item.id} item={item} store={store} snapshot={snapshot} t={t} />
          ))}
        </div>
      </div>
      <div className="approval-sr" aria-live="assertive" aria-atomic="true">
        {live}
      </div>
    </div>
  )
}

function HeadButton(props: {
  kind: string
  count: number
  tone: string
  store: ApprovalStore
  snapshot: ApprovalSnapshot
  t: T
}) {
  const { kind, count, tone, store, snapshot, t } = props
  const armed = confirmArmed(snapshot.confirm, kind, Date.now())
  const label = armed
    ? kind === CONFIRM_APPROVE_ALL
      ? t('approval_confirm_approve', { count })
      : t('approval_confirm_deny')
    : kind === CONFIRM_APPROVE_ALL
      ? t('approval_all_approve')
      : t('approval_all_deny')
  const denyAll = kind === CONFIRM_DENY_ALL
  return (
    <TextButton
      label={label}
      tone={tone}
      busy={snapshot.busy.includes('all')}
      busyLabel={t('approval_submitting')}
      disabled={snapshot.busy.length > 0}
      armed={armed}
      title={denyAll ? t('approval_all_deny_hint') : undefined}
      ariaLabel={denyAll ? `${t('approval_all_deny')}，${t('approval_all_deny_hint')}` : undefined}
      onClick={() => store.armOrRun(kind, () => store.submitAll(kind === CONFIRM_APPROVE_ALL ? 'approve' : 'deny'))}
    />
  )
}

function Item(props: { item: Rec; store: ApprovalStore; snapshot: ApprovalSnapshot; t: T }) {
  const { item, store, snapshot, t } = props
  const id: string = item.id
  const presentation = itemPresentation(item, snapshot.refs, t)
  const view = presentation.view
  const expanded = snapshot.expanded.includes(id)
  const busy = snapshot.busy.includes(id)
  const tone = itemTone(item)
  const error = snapshot.itemErrors[id]
  return (
    <div className="approval-item" data-tone={tone} data-kind={view.kind}>
      <div className="approval-item-main">
        <button
          type="button"
          className="approval-item-toggle"
          aria-expanded={expanded ? 'true' : 'false'}
          aria-label={expanded ? t('approval_collapse') : t('approval_expand')}
          onClick={() => store.toggleExpanded(id)}
        >
          <span className="approval-item-tool">{presentation.lead}</span>
          <span className="approval-item-summary">{presentation.summary}</span>
          {tone === 'expired' && <span className="approval-tag">{t('approval_expired_label')}</span>}
        </button>
        <span className="approval-item-actions">
          <TextButton
            label={t('approval_deny')}
            tone="danger"
            busy={busy}
            busyLabel={t('approval_submitting')}
            disabled={busy}
            title={t('approval_deny_hint')}
            ariaLabel={`${t('approval_deny')}，${t('approval_deny_hint')}`}
            onClick={() => store.submitItem(item, 'deny')}
          />
          <TextButton
            label={t('approval_approve')}
            tone="accent"
            busy={busy}
            busyLabel={t('approval_submitting')}
            disabled={busy}
            onClick={() => store.submitItem(item, 'approve')}
          />
        </span>
      </div>
      {expanded && <ItemDetail view={view} t={t} />}
      {error !== undefined && (
        <div className="approval-danger-inline">
          <span>{t('approval_failed')}</span>
          <TextButton label={t('approval_retry')} disabled={busy} onClick={() => store.submitItem(item, error.action)} />
        </div>
      )}
    </div>
  )
}

function ItemDetail({ view, t }: { view: View; t: T }) {
  if (view.kind === 'orchestration_change') {
    return (
      <div className="approval-item-detail">
        {view.rounds !== null && (
          <>
            <div className="approval-shadow-title">{t('approval_shadow_title')}</div>
            <div className="approval-note">{t('approval_shadow_rounds', { count: view.rounds })}</div>
          </>
        )}
        {view.rows.length > 0 && (
          <div className="approval-shadow-rows">
            {view.rows.map((row) => (
              <span className="approval-shadow-row" key={row.key}>
                <span className="label">{t(row.code)}</span>
                <span className="from">{row.fromText}</span>
                <span className="arrow">→</span>
                <span className="to">{row.toText}</span>
                <span className="delta" data-tone={row.tone}>
                  {row.delta}
                </span>
              </span>
            ))}
          </div>
        )}
        {view.diff !== null && (
          <>
            <div className="approval-note">{graphDiffText(view.diff, t)}</div>
            {view.diff.items.map((entry, index) => (
              <div className="approval-note" key={diffItemKey(entry, index)}>
                {diffItemText(entry)}
              </div>
            ))}
          </>
        )}
      </div>
    )
  }
  if (view.kind === 'plugin_write') {
    return (
      <div className="approval-item-detail">
        {view.files.map((file, index) => (
          <div className="approval-note" key={fileKey(file, index)}>
            {fileText(file)}
          </div>
        ))}
        {view.validate === true && (
          <div className="approval-note" data-tone="success">
            {t('approval_validate_ok')}
          </div>
        )}
        {view.validate === false && (
          <div className="approval-note" data-tone="danger">
            {t('approval_validate_failed')}
          </div>
        )}
        <div className="approval-danger-inline">{t('approval_isolation_risk')}</div>
      </div>
    )
  }
  return <div className="approval-item-detail">{view.args || t('approval_no_args')}</div>
}
