// `ui-approval` 客户端半边：注册进壳 `dock` 槽的 React 组件（契约 v2）。
// 业务状态住 React-free store（`store.ts`）；组件只渲染 store 快照 + 纯模型视图。
// 停靠带：0 高度起步，有待审批项才渲染；多条默认 iOS 式堆叠（前卡完整 + 至多两张后卡露顶），
// 滚轮循环切换前卡（按 item.id 跟踪），点窥视区或头部切换钮展开为平铺列表；键盘可达 + aria。

import { useEffect, useRef, useState } from 'react'
import type { SlotContext } from '@chrono/ui-contract'
import {
  approvalStatus,
  approvalStatusTextCode,
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
  LOADING_NOTE_MS,
  oldestPending,
  waitWarning,
} from './model'
import type { Rec, View } from './model'
import { formatText, messageText } from './messages'
import { createApprovalStore } from './store'
import type { ApprovalSnapshot, ApprovalStore } from './store'
import { STYLE_TEXT } from './styles.ts'

export const contract = '2'

export function register(ctx: SlotContext): void {
  const store = createApprovalStore(ctx)
  store.start()
  // store 住 register 作用域：组件卸载不 dispose，错误边界重挂后仍是同一实例（start 幂等，订阅不重复）。
  const registered = ctx.slots.register({ name: 'dock' }, function ApprovalDock() {
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
  const [fanned, setFanned] = useState(false)
  const [frontId, setFrontId] = useState<string | null>(null)
  const found = pending.findIndex((item) => item.id === frontId)
  const frontIndex = found >= 0 ? found : 0
  const stacked = !fanned && count > 1
  const status = approvalStatus({
    loading: snapshot.loading,
    error: snapshot.error,
    connected: snapshot.connected,
    itemCount: count,
  })
  const [slow, setSlow] = useState(false)

  // 队列不足两张时无叠可展：回到堆叠默认、前卡回落队首。
  useEffect(() => {
    if (count < 2) {
      setFanned(false)
      setFrontId(null)
    }
  }, [count])

  // 滚轮循环切换前卡：React 的 onWheel 是 passive、无法 preventDefault，
  // 故挂原生非 passive 监听；48px 累积阈值 = 一卡，180ms 闲置清零（触控板一次手势只进一卡）。
  const deckRef = useRef<HTMLDivElement | null>(null)
  const wheelRef = useRef<{ count: number; frontIndex: number; ids: string[] }>({ count: 0, frontIndex: 0, ids: [] })
  wheelRef.current = { count, frontIndex, ids: pending.map((item) => item.id) }
  useEffect(() => {
    const el = deckRef.current
    if (!stacked || el === null) return undefined
    let acc = 0
    let idle: ReturnType<typeof setTimeout> | null = null
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      acc += event.deltaY
      if (idle !== null) clearTimeout(idle)
      idle = setTimeout(() => {
        acc = 0
      }, 180)
      if (Math.abs(acc) < 48) return
      const dir = acc > 0 ? 1 : -1
      acc = 0
      const { count: n, frontIndex: i, ids } = wheelRef.current
      if (n < 2) return
      setFrontId(ids[(i + dir + n) % n])
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (idle !== null) clearTimeout(idle)
    }
  }, [stacked])

  useEffect(() => {
    if (count === 0) {
      setLive('')
      return undefined
    }
    setLive('')
    const timer = setTimeout(() => setLive(formatText(snapshot.table, 'approval_waiting', { count })), 0)
    return () => clearTimeout(timer)
  }, [count, snapshot.table])

  // 长等待追加提示：仅在「读取中」计时，8s 后追加「仍在读取…」，与 ui-chat / ui-settings 同档。
  useEffect(() => {
    if (status !== 'loading') {
      setSlow(false)
      return undefined
    }
    const timer = setTimeout(() => setSlow(true), LOADING_NOTE_MS)
    return () => clearTimeout(timer)
  }, [status])

  if (status === 'loading') {
    return (
      <div className="approval-root">
        <style>{STYLE_TEXT}</style>
        <div className="approval-dock">
          <div className="approval-loading" role="status">
            <span className="approval-breathe-ring" />
            <span>{t('approval_loading')}</span>
            {slow ? <span className="approval-loading-note">{t('approval_loading_more')}</span> : null}
          </div>
        </div>
      </div>
    )
  }
  // 插件不可达 / 显式失败：给独立、可重试的错误条；否则空队列会把失败吞掉。
  if (status === 'offline' || status === 'failed') {
    const code = approvalStatusTextCode(status) ?? 'approval_load_failed'
    return (
      <div className="approval-root">
        <style>{STYLE_TEXT}</style>
        <div className="approval-dock" role="region" aria-label={t('approval_dock_label')}>
          <div className="approval-danger-inline" data-role="dock-error" data-source={status}>
            <span>{t(code)}</span>
            <TextButton label={t('approval_retry')} onClick={() => store.load()} />
          </div>
        </div>
      </div>
    )
  }
  // 无待审批项、无错误：不占高度、不渲染。
  if (status === 'empty') return null

  const oldest = oldestPending(snapshot.items)
  const waited = oldest === null ? null : elapsedMs({ at: new Date(oldest).toISOString() }, now)
  const warn = waited !== null && waitWarning(waited)
  const waitText = waited === null ? '' : t('approval_waited', { time: formatWait(waited) })

  return (
    <div className="approval-root">
      <style>{STYLE_TEXT}</style>
      <div className="approval-dock" role="region" aria-label={t('approval_dock_label')}>
        {count > 0 && (
          <div className="approval-head">
            <span className="approval-head-count">
              <Icon name="list" size={16} />
              <span>{t('approval_waiting', { count })}</span>
            </span>
            <span className="approval-head-wait" data-warn={warn ? 'true' : 'false'}>
              {waitText}
            </span>
            <span className="approval-head-spacer" />
            {count > 1 && (
              <button
                type="button"
                className="approval-fan"
                data-open={fanned ? 'true' : 'false'}
                aria-expanded={fanned ? 'true' : 'false'}
                aria-label={fanned ? t('approval_collapse_all') : t('approval_expand_all', { count })}
                title={fanned ? t('approval_collapse_all') : t('approval_expand_all', { count })}
                onClick={() => setFanned(!fanned)}
              >
                <Icon name="chevron-down" size={14} />
              </button>
            )}
            <HeadButton kind={CONFIRM_DENY_ALL} count={count} tone="danger" store={store} snapshot={snapshot} t={t} />
            <HeadButton kind={CONFIRM_APPROVE_ALL} count={count} tone="accent" store={store} snapshot={snapshot} t={t} />
          </div>
        )}
        {!snapshot.connected && (
          <div className="approval-danger-inline" data-role="offline">
            <span>{t('approval_offline')}</span>
          </div>
        )}
        {snapshot.error !== null && (
          <div className="approval-danger-inline" data-role="batch-error" data-source={snapshot.error.kind}>
            <span>{t(snapshot.error.kind === 'load' ? 'approval_load_failed' : 'approval_failed')}</span>
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
        {count > 0 &&
          (stacked ? (
            <div className="approval-deck" ref={deckRef}>
              <div
                className="approval-peeks"
                data-depths={Math.min(2, count - 1)}
                aria-hidden="true"
                onClick={() => setFanned(true)}
              >
                {count > 2 && (
                  <Peek key={pending[(frontIndex + 2) % count].id} item={pending[(frontIndex + 2) % count]} depth={2} snapshot={snapshot} t={t} />
                )}
                <Peek key={pending[(frontIndex + 1) % count].id} item={pending[(frontIndex + 1) % count]} depth={1} snapshot={snapshot} t={t} />
              </div>
              <Item key={pending[frontIndex].id} item={pending[frontIndex]} store={store} snapshot={snapshot} t={t} />
            </div>
          ) : (
            <div className="approval-list">
              {pending.map((item) => (
                <Item key={item.id} item={item} store={store} snapshot={snapshot} t={t} />
              ))}
            </div>
          ))}
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

// 窥视卡：堆叠态下后卡只露顶部一条（逐级收窄 + 变暗 + 退后），装饰性（aria-hidden），
// 点击/滚轮交互由容器承载；key = item.id，轮换时重挂以播滑入动效。
function Peek(props: { item: Rec; depth: number; snapshot: ApprovalSnapshot; t: T }) {
  const { item, depth, snapshot, t } = props
  const presentation = itemPresentation(item, snapshot.refs, t)
  return (
    <div className="approval-peek" data-depth={depth} data-kind={presentation.view.kind} data-tone={itemTone(item)}>
      <span className="approval-item-tool">{presentation.lead}</span>
      <span className="approval-item-summary">{presentation.summary}</span>
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
