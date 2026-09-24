// `ui-composer` 客户端半边（slot = composer）：React 组件 + React-free store 绑定。
// 契约：`export const contract = '2'` + `register(ctx)` 把 App 注册进 composer slot。
// 业务状态住 `store.ts`（配置 / 输入 / 附件 / 待发队列 / 在途回合）；组件只渲染快照、调动作。
// 叶子纯模块（model / attach / dropdown / messages / run-model）零 react import。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from 'react'
import type { SlotContext } from '@chrono/ui-contract'

import { STYLE_TEXT } from './styles.ts'
import { createComposerStore } from './store.ts'
import type { Chip, ComposerSnapshot, ComposerStore } from './store.ts'
import type { AssetRef } from './attach.ts'
import { activeIndexFor, moveActive, optionId } from './dropdown.ts'
import {
  currentModelOf,
  currentReasoningOf,
  currentVendorOf,
  isRecord,
  messageRowLabel,
  modelsOf,
  PERMISSIONS,
  permissionDescCode,
  permissionIcon,
  permissionLabelCode,
  queueEntry,
  sourceRows,
  threadKeyOf,
  trimmedRows,
  usageView,
} from './model.ts'

export const contract = '2'

const MAX_CHIPS = 4
const TOOLTIP_DELAY_MS = 400

interface Env {
  ctx: SlotContext
  store: ComposerStore
  snapshot: ComposerSnapshot
  t(code: string, vars?: unknown): string
}

const EnvCtx = createContext<Env | null>(null)

function useEnv(): Env {
  const env = useContext(EnvCtx)
  if (env === null) throw new Error('composer env missing')
  return env
}

// ---- 原子组件 ----

function Icon({
  name,
  size = 16,
  label = '',
}: {
  name: string
  size?: number
  label?: string
}): ReactNode {
  const { ctx } = useEnv()
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
      role={label.length > 0 ? 'img' : undefined}
      aria-label={label.length > 0 ? label : undefined}
      aria-hidden={label.length > 0 ? undefined : true}
    >
      <use href={`${ctx.tokens.icons}#${name}`} />
    </svg>
  )
}

const POPOVER_VIEWPORT_MARGIN = 8

/**
 * 弹层视口收纳：打开 / 内容变化后量取矩形，水平越界用 translateX 收进视口；
 * 垂直越界时在 above / below 间翻转，`resize` 时重算。在绘制前执行避免抖动。
 */
function useClampPopover(
  ref: RefObject<HTMLDivElement | null>,
  open: boolean,
  preferred: 'above' | 'below',
  token: string,
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || el === null) return undefined
    const clamp = (): void => {
      el.dataset.placement = preferred
      el.style.transform = ''
      let rect = el.getBoundingClientRect()
      if (preferred === 'above' && rect.top < POPOVER_VIEWPORT_MARGIN) {
        el.dataset.placement = 'below'
        rect = el.getBoundingClientRect()
      } else if (
        preferred === 'below' &&
        rect.bottom > window.innerHeight - POPOVER_VIEWPORT_MARGIN
      ) {
        el.dataset.placement = 'above'
        rect = el.getBoundingClientRect()
      }
      const right = window.innerWidth - POPOVER_VIEWPORT_MARGIN
      let shift = 0
      if (rect.left < POPOVER_VIEWPORT_MARGIN) shift = POPOVER_VIEWPORT_MARGIN - rect.left
      else if (rect.right > right) shift = right - rect.right
      if (shift !== 0) el.style.transform = `translateX(${shift}px)`
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [open, preferred, token, ref])
}

interface DropdownOption {
  value: string
  label: string
  description?: string
  icon?: string
}

function Dropdown(props: {
  prefix: string
  label: string
  align?: 'end'
  iconName?: string
  valueText: string
  triggerTitle: string
  disabled: boolean
  open: boolean
  options: DropdownOption[]
  activeIndex: number
  selectedValue: string | null
  fetching?: boolean
  chevronHidden?: boolean
  ariaPressed?: 'true' | 'false'
  triggerRef: RefObject<HTMLButtonElement | null>
  popoverRef: RefObject<HTMLDivElement | null>
  onTrigger: () => void
  onSelect: (value: string) => void
  onKey: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}): ReactNode {
  useClampPopover(
    props.popoverRef,
    props.open,
    'above',
    `${props.options.length}:${props.selectedValue ?? ''}`,
  )
  // 键盘移动活动项后把它滚进可视区（弹层 max-height 内可滚动）。
  useEffect(() => {
    if (!props.open || props.activeIndex < 0) return
    const active = document.getElementById(optionId(props.prefix, props.activeIndex))
    active?.scrollIntoView({ block: 'nearest' })
  }, [props.open, props.activeIndex, props.prefix])
  return (
    <div className="composer-tool-wrap">
      <button
        ref={props.triggerRef}
        type="button"
        className="composer-tool"
        aria-haspopup="listbox"
        aria-expanded={props.open}
        aria-label={props.label}
        title={props.triggerTitle}
        aria-pressed={props.ariaPressed}
        disabled={props.disabled}
        onClick={props.onTrigger}
      >
        {props.fetching === true ? (
          <span className="composer-tool-icon">
            <span className="composer-chip-breathe" />
          </span>
        ) : typeof props.iconName === 'string' && props.iconName.length > 0 ? (
          <span className="composer-tool-icon">
            <Icon name={props.iconName} size={16} />
          </span>
        ) : null}
        <span className="composer-tool-value">{props.valueText}</span>
        {props.chevronHidden === true ? null : (
          <span className="composer-tool-chevron">
            <Icon name="chevron-down" size={14} />
          </span>
        )}
      </button>
      {props.open ? (
        <div
          ref={props.popoverRef}
          className="composer-popover"
          data-placement="above"
          data-align={props.align === 'end' ? 'end' : undefined}
          role="listbox"
          tabIndex={-1}
          aria-label={props.label}
          aria-activedescendant={
            props.activeIndex >= 0 ? optionId(props.prefix, props.activeIndex) : undefined
          }
          onKeyDown={props.onKey}
        >
          {props.options.map((option, index) => (
            <div
              key={option.value}
              className="composer-option"
              role="option"
              id={optionId(props.prefix, index)}
              aria-selected={option.value === props.selectedValue}
              data-active={String(props.activeIndex === index)}
              onClick={() => props.onSelect(option.value)}
            >
              {typeof option.icon === 'string' ? (
                <span className="composer-option-icon">
                  <Icon name={option.icon} size={16} />
                </span>
              ) : null}
              <span className="composer-option-body">
                <span className="composer-option-label">{option.label}</span>
                {typeof option.description === 'string' && option.description.length > 0 ? (
                  <span className="composer-option-desc">{option.description}</span>
                ) : null}
              </span>
              {option.value === props.selectedValue ? <Icon name="check" size={16} /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 资产引用 → 可显示 URL（经 `ctx.asset.get` 取 base64 转 data URL）。 */
function useAssetUrl(source: AssetRef | null): string | null {
  const { ctx } = useEnv()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (source === null) {
      setUrl(null)
      return undefined
    }
    let alive = true
    void ctx.asset
      .get(source.sha256)
      .then((result) => {
        if (!alive) return
        if (isRecord(result) && result.ok === true && typeof result.bytes === 'string') {
          const mime =
            typeof result.mime === 'string' && result.mime.length > 0 ? result.mime : source.mime
          setUrl(`data:${mime};base64,${result.bytes}`)
        } else {
          setUrl(null)
        }
      })
      .catch(() => {
        if (alive) setUrl(null)
      })
    return () => {
      alive = false
    }
  }, [source?.sha256, source?.mime, ctx.asset])
  return url
}

function ChipView({ chip }: { chip: Chip }): ReactNode {
  const { store, t } = useEnv()
  const thumb = useAssetUrl(chip.kind === 'image' && chip.status === 'ready' ? chip.source : null)
  const reason = chip.error !== null ? t(chip.error) : t('composer_attach_failed')
  return (
    <div
      className="composer-chip"
      data-status={chip.status}
      data-kind={chip.kind}
      title={chip.status === 'failed' ? reason : undefined}
      aria-label={chip.status === 'failed' ? `${chip.name} · ${reason}` : undefined}
      onClick={chip.status === 'failed' ? () => void store.retryChip(chip.id) : undefined}
    >
      {thumb !== null ? (
        <img className="composer-chip-thumb" src={thumb} alt={chip.name} loading="lazy" />
      ) : (
        <>
          <Icon name="paperclip" size={16} />
          <span className="composer-chip-name">{chip.name}</span>
        </>
      )}
      {chip.status === 'loading' ? <span className="composer-chip-breathe" /> : null}
      <button
        type="button"
        className="composer-chip-remove"
        aria-label={t('composer_remove_attachment')}
        onClick={(event) => {
          event.stopPropagation()
          store.removeChip(chip.id)
        }}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  )
}

// ---- 输入卡 ----

function Composer(): ReactNode {
  const { store, snapshot: s, t } = useEnv()
  const [openDd, setOpenDd] = useState<'model' | 'reasoning' | 'permission' | null>(null)
  const [ddActive, setDdActive] = useState(-1)
  const [pendingOpen, setPendingOpen] = useState(false)
  const [focus, setFocus] = useState(false)
  const [dragover, setDragover] = useState(false)
  const [tipVisible, setTipVisible] = useState(false)

  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const reasoningTriggerRef = useRef<HTMLButtonElement | null>(null)
  const permissionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const pendingChipRef = useRef<HTMLButtonElement | null>(null)
  const modelPopoverRef = useRef<HTMLDivElement | null>(null)
  const reasoningPopoverRef = useRef<HTMLDivElement | null>(null)
  const permissionPopoverRef = useRef<HTMLDivElement | null>(null)
  const pendingPopoverRef = useRef<HTMLDivElement | null>(null)
  const contextTipRef = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 多行自增高：文本变化后重算高度。
  useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [s.text])

  // 打开弹层后聚焦弹层；Esc 由 document 级监听兜底。
  useEffect(() => {
    if (openDd === 'model') modelPopoverRef.current?.focus()
    else if (openDd === 'reasoning') reasoningPopoverRef.current?.focus()
    else if (openDd === 'permission') permissionPopoverRef.current?.focus()
  }, [openDd])

  useEffect(() => {
    if (pendingOpen) pendingPopoverRef.current?.focus()
  }, [pendingOpen])

  const closeOverlays = useCallback(
    (returnFocus: boolean) => {
      if (returnFocus) {
        if (openDd === 'model') modelTriggerRef.current?.focus()
        else if (openDd === 'reasoning') reasoningTriggerRef.current?.focus()
        else if (openDd === 'permission') permissionTriggerRef.current?.focus()
        else if (pendingOpen) pendingChipRef.current?.focus()
      }
      setOpenDd(null)
      setPendingOpen(false)
    },
    [openDd, pendingOpen],
  )

  useEffect(() => {
    if (openDd === null && !pendingOpen) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeOverlays(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openDd, pendingOpen, closeOverlays])

  useEffect(
    () => () => {
      if (tipTimerRef.current !== null) clearTimeout(tipTimerRef.current)
    },
    [],
  )

  // ---- 下拉选项与选中值 ----

  const modelOptions: DropdownOption[] = modelsOf(s.config).map((item) => ({
    value: `${item.vendor}::${item.id}`,
    label: item.name,
    description: item.vendor,
  }))
  const modelVendor = currentVendorOf(s.config)
  const modelId = currentModelOf(s.config)
  const modelSelected = modelVendor !== null && modelId !== null ? `${modelVendor}::${modelId}` : null
  const modelValueText = (() => {
    const current = modelsOf(s.config).find(
      (item) => item.id === s.model && item.vendor === modelVendor,
    )
    return current !== undefined ? current.name : s.model !== null ? s.model : t('composer_no_model')
  })()

  const permissionOptions: DropdownOption[] = PERMISSIONS.map((value) => ({
    value,
    label: t(permissionLabelCode(value)),
    description: t(permissionDescCode(value)),
    icon: permissionIcon(value),
  }))
  const permissionValueText = t(permissionLabelCode(s.permission))

  const reasoningOptions: DropdownOption[] =
    s.reasoning.status === 'ready'
      ? s.reasoning.options.map((value) => ({ value, label: value }))
      : []
  const reasoningSelected = s.reasoning.status === 'ready' ? s.reasoning.value : null
  const reasoningOn = currentReasoningOf(s.config) === s.reasoning.value
  const reasoningValueText = (() => {
    if (s.reasoning.status === 'fetching') return t('composer_reasoning_fetching')
    if (s.reasoning.collapsed) {
      return reasoningOn ? t('composer_reasoning_on') : t('composer_reasoning_off')
    }
    const current =
      typeof s.reasoning.value === 'string' ? s.reasoning.value : currentReasoningOf(s.config)
    return typeof current === 'string' ? current : ''
  })()

  function openDropdownFor(
    kind: 'model' | 'reasoning' | 'permission',
    options: DropdownOption[],
    selected: string | null,
  ): void {
    if (options.length === 0) return
    const index = options.findIndex((option) => option.value === selected)
    setDdActive(activeIndexFor(index, options.length))
    setOpenDd(kind)
  }

  function onSelectOption(kind: 'model' | 'reasoning' | 'permission', value: string): void {
    if (kind === 'model') void store.selectModel(value)
    else if (kind === 'reasoning') void store.selectReasoning(value)
    else void store.selectPermission(value)
    closeOverlays(true)
  }

  function onDropdownKey(
    event: ReactKeyboardEvent<HTMLDivElement>,
    kind: 'model' | 'reasoning' | 'permission',
    options: DropdownOption[],
  ): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const moved = moveActive(
        { open: true, activeIndex: ddActive },
        event.key === 'ArrowDown' ? 1 : -1,
        options.length,
      )
      setDdActive(moved.activeIndex)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = options[ddActive]
      if (option !== undefined) onSelectOption(kind, option.value)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeOverlays(true)
    }
  }

  // 引导 / 新建厂商在挂载后才写 config：打开模型下拉前重读一次，免得列表停在挂载时空态。
  async function onModelTrigger(): Promise<void> {
    if (openDd === 'model') {
      closeOverlays(false)
      return
    }
    closeOverlays(false)
    const config = await store.refreshConfig()
    if (config === null) return
    const vendor = currentVendorOf(config)
    const model = currentModelOf(config)
    openDropdownFor(
      'model',
      modelsOf(config).map((item) => ({
        value: `${item.vendor}::${item.id}`,
        label: item.name,
        description: item.vendor,
      })),
      vendor !== null && model !== null ? `${vendor}::${model}` : null,
    )
  }

  function onReasoningTrigger(): void {
    if (s.reasoning.status !== 'ready') return
    if (s.reasoning.collapsed) {
      void store.selectReasoning(reasoningOn ? null : s.reasoning.value)
      return
    }
    if (openDd === 'reasoning') {
      closeOverlays(false)
      return
    }
    closeOverlays(false)
    openDropdownFor('reasoning', reasoningOptions, reasoningSelected)
  }

  function onPermissionTrigger(): void {
    if (openDd === 'permission') {
      closeOverlays(false)
      return
    }
    closeOverlays(false)
    openDropdownFor('permission', permissionOptions, s.permission)
  }

  // ---- 附件 ----

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    void store.addFiles(event.target.files)
    event.target.value = ''
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragover(true)
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragover(false)
    if (event.dataTransfer !== null) void store.addFiles(event.dataTransfer.files)
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const items = event.clipboardData !== null ? event.clipboardData.items : null
    if (items === null) return
    const files: File[] = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file !== null) files.push(file)
      }
    }
    if (files.length > 0) void store.addFiles(files)
  }

  // ---- 输入 ----

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || composingRef.current) return
    event.preventDefault()
    void store.send()
  }

  // ---- 待发队列 ----

  function onPendingToggle(): void {
    if (pendingOpen) {
      closeOverlays(false)
      return
    }
    closeOverlays(false)
    if (s.queue.length === 0) return
    setPendingOpen(true)
  }

  function onRemovePending(id: string): void {
    const count = store.removePending(id)
    if (count === 0) closeOverlays(true)
  }

  // ---- 上下文用量行 ----

  const usage = s.usage[threadKeyOf(s.activeThread)]
  const view = usageView(usage)
  const rows = sourceRows(usage)
  const trimmed = trimmedRows(usage)
  const tipShown = tipVisible && (rows.length > 0 || trimmed.length > 0)

  useClampPopover(pendingPopoverRef, pendingOpen, 'below', String(s.queueCount))
  useClampPopover(contextTipRef, tipShown, 'above', `${rows.length}:${trimmed.length}`)

  function scheduleTip(): void {
    if (!isRecord(usage)) return
    if (tipTimerRef.current !== null) clearTimeout(tipTimerRef.current)
    tipTimerRef.current = setTimeout(() => {
      tipTimerRef.current = null
      setTipVisible(true)
    }, TOOLTIP_DELAY_MS)
  }

  function hideTip(): void {
    if (tipTimerRef.current !== null) {
      clearTimeout(tipTimerRef.current)
      tipTimerRef.current = null
    }
    setTipVisible(false)
  }

  const expanded = s.attachExpanded || s.attachments.length <= MAX_CHIPS
  const visibleChips = expanded ? s.attachments : s.attachments.slice(0, MAX_CHIPS)
  const maskVisible = openDd !== null || pendingOpen
  const running = s.running

  return (
    <div className="composer-root">
      {maskVisible ? (
        <div className="composer-mask" onClick={() => closeOverlays(false)} />
      ) : null}
      <div
        className="composer-card"
        data-focus={focus ? 'true' : 'false'}
        data-dragover={dragover ? 'true' : 'false'}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          const next = event.relatedTarget
          if (next instanceof Node && event.currentTarget.contains(next)) return
          setDragover(false)
        }}
        onDrop={onDrop}
      >
        <div className="composer-pending-wrap">
          <button
            ref={pendingChipRef}
            type="button"
            className="composer-pending"
            hidden={s.queueCount === 0}
            aria-live="polite"
            aria-atomic="true"
            aria-label={
              s.queueCount > 0 ? t('composer_pending', { count: s.queueCount }) : undefined
            }
            onClick={onPendingToggle}
          >
            {s.queueCount > 0 ? t('composer_pending', { count: s.queueCount }) : ''}
          </button>
          {pendingOpen ? (
            <div
              ref={pendingPopoverRef}
              className="composer-popover"
              data-placement="below"
              role="dialog"
              tabIndex={-1}
              aria-label={t('composer_pending_title')}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                closeOverlays(true)
              }}
            >
              <div className="composer-popover-title">{t('composer_pending_title')}</div>
              {s.queue.map((message, index) => {
                const label = messageRowLabel(message, t)
                const { id } = queueEntry(message)
                return (
                  <div key={`${id}-${index}`} className="composer-popover-row">
                    <span className="composer-popover-row-text">{label}</span>
                    <button
                      type="button"
                      className="composer-popover-remove"
                      aria-label={t('composer_pending_remove')}
                      onClick={() => onRemovePending(id)}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>

        {s.attachments.length > 0 ? (
          <div className="composer-attach-row">
            {visibleChips.map((chip) => (
              <ChipView key={chip.id} chip={chip} />
            ))}
            {expanded ? null : (
              <button
                type="button"
                className="composer-chip"
                onClick={() => store.expandAttachments()}
              >
                {t('composer_more_chip', { count: s.attachments.length - MAX_CHIPS })}
              </button>
            )}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          placeholder={t('composer_placeholder')}
          aria-label={t('composer_placeholder')}
          value={s.text}
          onChange={(event) => store.setText(event.target.value)}
          onKeyDown={onInputKeyDown}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onPaste={onPaste}
        />

        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <button
              type="button"
              className="composer-tool"
              aria-label={t('composer_attach')}
              title={t('composer_attach')}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="plus" size={16} />
            </button>

            <Dropdown
              prefix="composer-model"
              label={t('composer_model')}
              valueText={modelValueText}
              triggerTitle={`${t('composer_model')} ${modelValueText}`}
              disabled={s.config === null}
              open={openDd === 'model'}
              options={modelOptions}
              activeIndex={openDd === 'model' ? ddActive : -1}
              selectedValue={modelSelected}
              triggerRef={modelTriggerRef}
              popoverRef={modelPopoverRef}
              onTrigger={() => void onModelTrigger()}
              onSelect={(value) => onSelectOption('model', value)}
              onKey={(event) => onDropdownKey(event, 'model', modelOptions)}
            />

            {s.reasoning.status !== 'hidden' && s.reasoning.status !== 'failed' ? (
              <Dropdown
                prefix="composer-reasoning"
                label={t('composer_reasoning')}
                valueText={reasoningValueText}
                triggerTitle={`${t('composer_reasoning')} ${reasoningValueText}`}
                disabled={s.reasoning.status !== 'ready' || s.config === null}
                open={openDd === 'reasoning'}
                options={reasoningOptions}
                activeIndex={openDd === 'reasoning' ? ddActive : -1}
                selectedValue={reasoningSelected}
                fetching={s.reasoning.status === 'fetching'}
                chevronHidden={s.reasoning.status === 'fetching' || s.reasoning.collapsed}
                ariaPressed={s.reasoning.collapsed ? (reasoningOn ? 'true' : 'false') : undefined}
                triggerRef={reasoningTriggerRef}
                popoverRef={reasoningPopoverRef}
                onTrigger={onReasoningTrigger}
                onSelect={(value) => onSelectOption('reasoning', value)}
                onKey={(event) => onDropdownKey(event, 'reasoning', reasoningOptions)}
              />
            ) : null}

            {s.reasoning.status === 'failed' ? (
              <span className="composer-inline-error">
                <span>{t('composer_reasoning_failed')}</span>
                <button
                  type="button"
                  className="composer-inline-retry"
                  onClick={() => void store.ensureReasoning()}
                >
                  {t('composer_retry')}
                </button>
              </span>
            ) : null}

            {s.error !== null ? (
              <span className="composer-inline-error">{t(s.error)}</span>
            ) : null}
          </div>

          <div className="composer-toolbar-right">
            <Dropdown
              prefix="composer-permission"
              label={t('composer_permission')}
              align="end"
              iconName={permissionIcon(s.permission)}
              valueText={permissionValueText}
              triggerTitle={`${t('composer_permission')} ${permissionValueText}`}
              disabled={s.config === null}
              open={openDd === 'permission'}
              options={permissionOptions}
              activeIndex={openDd === 'permission' ? ddActive : -1}
              selectedValue={s.permission}
              triggerRef={permissionTriggerRef}
              popoverRef={permissionPopoverRef}
              onTrigger={onPermissionTrigger}
              onSelect={(value) => onSelectOption('permission', value)}
              onKey={(event) => onDropdownKey(event, 'permission', permissionOptions)}
            />
            <button
              type="button"
              className="composer-send"
              data-mode={running ? 'stop' : 'send'}
              aria-label={running ? t('composer_stop') : t('composer_send')}
              title={running ? t('composer_stop') : t('composer_send')}
              disabled={s.sending || (!running && !s.canSend)}
              onClick={() => {
                if (running) void store.stop()
                else void store.send()
              }}
            >
              <span className="composer-send-icon" data-icon="send">
                <Icon name="arrow-up" size={20} />
              </span>
              <span className="composer-send-icon" data-icon="stop">
                <Icon name="square" size={16} />
              </span>
            </button>
          </div>
        </div>
      </div>

      {view !== null ? (
        <div
          className="composer-context"
          data-tone={view.tone}
          tabIndex={0}
          aria-live="polite"
          aria-atomic="true"
          aria-describedby={tipShown ? 'composer-context-tip' : undefined}
          onMouseEnter={scheduleTip}
          onMouseLeave={hideTip}
          onFocus={scheduleTip}
          onBlur={hideTip}
        >
          <span className="composer-context-text">
            {view.full
              ? t('composer_context_full', { used: view.usedText, budget: view.budgetText })
              : t('composer_context', { used: view.usedText, budget: view.budgetText })}
          </span>
          {tipShown ? (
            <div
              ref={contextTipRef}
              className="composer-popover"
              data-placement="above"
              role="tooltip"
              id="composer-context-tip"
            >
              {rows.map((row) => (
                <div key={row.key} className="composer-tooltip-row">
                  <span>{row.code !== null ? t(row.code) : row.key}</span>
                  <span>{row.text}</span>
                </div>
              ))}
              {trimmed.length > 0 ? (
                <>
                  <div className="composer-tooltip-note">
                    {t('composer_trimmed', { count: trimmed.length })}
                  </div>
                  {trimmed.map((item, index) => {
                    const label = item.label.length > 0 ? item.label : t('composer_trimmed')
                    const text =
                      item.reason.length > 0
                        ? t('composer_trimmed_reason', { reason: item.reason })
                        : label
                    return (
                      <div key={`${label}-${index}`} className="composer-tooltip-note">
                        {text}
                      </div>
                    )
                  })}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <input ref={fileRef} type="file" multiple hidden onChange={onFileChange} />
    </div>
  )
}

// ---- 应用 ----

function App({ ctx }: { ctx: SlotContext }): ReactNode {
  const storeRef = useRef<ComposerStore | null>(null)
  if (storeRef.current === null) storeRef.current = createComposerStore(ctx)
  const store = storeRef.current
  const snapshot = ctx.useStore(store)

  useEffect(() => {
    void store.init()
    return () => store.dispose()
  }, [store])

  const env = useMemo<Env>(
    () => ({ ctx, store, snapshot, t: store.t }),
    [ctx, store, snapshot],
  )

  return (
    <EnvCtx.Provider value={env}>
      <style>{STYLE_TEXT}</style>
      <Composer />
    </EnvCtx.Provider>
  )
}

export function register(ctx: SlotContext): void {
  ctx.slots.register({ name: 'composer' }, App)
}
