// 设置视图共用 React 片段：图标 / 按钮 / 字段 / 行 / 分组 / 空态 / 加载 / 错误条。
// 可及性：字段与行标签对可标控件用 `htmlFor`，复合控件用 `aria-label`。
// 本文件是原 `dom.js` / `ui-parts.js` 的 React 替代；视图模型仍由纯模块产出。

import { cloneElement, createContext, useContext, useId, type ReactNode } from 'react'

export const VcContext = createContext<any>(null)

export function useVc(): any {
  return useContext(VcContext)
}

/** 图标 sprite：`<svg><use/></svg>`；带 label 时补可及名，否则 aria-hidden。 */
export function Icon(props: { name: string; size?: number; label?: string; className?: string }) {
  const size = props.size ?? 16
  const label = props.label ?? ''
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
      className={props.className}
      role={label.length > 0 ? 'img' : undefined}
      aria-label={label.length > 0 ? label : undefined}
      aria-hidden={label.length > 0 ? undefined : true}
    >
      <use href={`/assets/icons.v2.svg#${props.name}`} />
    </svg>
  )
}

/** 图标按钮：命中区 ≥24×24，必须带 aria-label。 */
export function IconButton(props: { name: string; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="settings-iconbtn"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.name} size={16} label={props.label} />
    </button>
  )
}

/** 文字按钮：命中区含横向 padding。 */
export function TextButton(props: {
  label: string
  onClick?: () => void
  tone?: string
  disabled?: boolean
  className?: string
  children?: ReactNode
}) {
  const className = props.className ?? 'settings-btn'
  return (
    <button
      type="button"
      className={className}
      data-tone={props.tone}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
      {props.label}
    </button>
  )
}

/** 图标 + 文字按钮：图标仅装饰（aria-hidden），可及名由文字承担。 */
export function LabeledButton(props: {
  icon: string
  label: string
  onClick?: () => void
  tone?: string
  disabled?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <TextButton
      label={props.label}
      onClick={props.onClick}
      tone={props.tone}
      disabled={props.disabled}
      className={props.className}
    >
      <Icon name={props.icon} size={16} />
      {props.children}
    </TextButton>
  )
}

/** 表单字段：label + 控件；可标控件用 `htmlFor`，复合控件退化为分组 `aria-label`。 */
export function Field(props: { label: string; required?: boolean; labelable?: boolean; children: any; error?: ReactNode }) {
  const autoId = useId()
  const labelable = props.labelable !== false
  const childId = props.children?.props?.id
  const id = typeof childId === 'string' && childId.length > 0 ? childId : autoId
  const control = labelable
    ? cloneElement(props.children, { id, 'aria-required': props.required === true ? 'true' : undefined })
    : props.children
  return (
    <div className="settings-field">
      {labelable ? (
        <label className="settings-field-label" htmlFor={id}>
          {props.label}
          {props.required === true ? <span className="settings-required-mark" aria-hidden="true">*</span> : null}
        </label>
      ) : (
        <span className="settings-field-label">{props.label}</span>
      )}
      {control}
      {props.error}
    </div>
  )
}

/** 行式只读 / 控件行：label 左、控件右。 */
export function Row(props: { label: string; children: ReactNode; savedKey?: string; valueClassName?: string }) {
  const vc = useVc()
  const saved = typeof props.savedKey === 'string' && vc?.state?.savedKey === props.savedKey
  return (
    <div className="settings-row" data-saved-key={props.savedKey} data-saved={saved ? 'true' : undefined}>
      <span className="settings-row-label">{props.label}</span>
      <span className={props.valueClassName ?? 'settings-row-value'}>{props.children}</span>
    </div>
  )
}

/** 统一页头：页标题 + 一行导语；每页固定结构，标题复用 tab 文案键。 */
export function PanelHead(props: { titleKey: string; descKey: string }) {
  const vc = useVc()
  return (
    <div className="settings-panel-head">
      <div className="settings-panel-title">{vc.text(props.titleKey)}</div>
      <div className="settings-panel-desc">{vc.text(props.descKey)}</div>
    </div>
  )
}

/** 拨杆开关：行内布尔开关（role="switch"）；`label` 作可及名，不显示。 */
export function Toggle(props: { checked: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked ? 'true' : 'false'}
      aria-label={props.label}
      title={props.label}
      className="settings-switch"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="settings-switch-thumb" aria-hidden="true" />
    </button>
  )
}

/** 分组：可选分组名 + 子节点。 */
export function Section(props: { nameKey?: string | null; children: ReactNode }) {
  const vc = useVc()
  return (
    <div className="settings-section">
      {props.nameKey !== null && props.nameKey !== undefined ? (
        <div className="settings-group-name">{vc.text(props.nameKey)}</div>
      ) : null}
      {props.children}
    </div>
  )
}

/** 行内错误条：danger 竖线 + 人话 + 可选 [重试]。 */
export function ErrorBar(props: { code: string; onRetry?: () => void }) {
  const vc = useVc()
  return (
    <div className="settings-error" role="alert">
      <Icon name="alert-circle" size={16} />
      <span>{vc.text(props.code)}</span>
      {props.onRetry !== undefined ? <TextButton label={vc.text('settings_retry')} onClick={props.onRetry} /> : null}
    </div>
  )
}

/** 统一空态：图标 + 说明 + 可选提示。 */
export function EmptyState(props: { nameKey: string; hintKey?: string }) {
  const vc = useVc()
  return (
    <div className="settings-empty">
      <Icon name="info" size={20} />
      <div>{vc.text(props.nameKey)}</div>
      {props.hintKey !== undefined ? <div className="settings-empty-hint">{vc.text(props.hintKey)}</div> : null}
    </div>
  )
}

/** 块级加载：居中呼吸条；`note` 为 >8s 追加。 */
export function BlockLoading(props: { note?: boolean }) {
  const vc = useVc()
  return (
    <div className="settings-block-loading">
      <div className="settings-breathe" />
      {props.note === true ? <div>{vc.text('settings_loading_more')}</div> : null}
    </div>
  )
}

/** 依赖未就绪降级条。 */
export function DependencyMissing() {
  const vc = useVc()
  return (
    <div className="settings-warning-bar">
      <Icon name="alert-triangle" size={16} />
      <span>{`${vc.text('settings_dependency_missing')} · ${vc.text('settings_dependency_missing_hint')}`}</span>
    </div>
  )
}
