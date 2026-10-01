// 图标 sprite 引用与图标按钮外壳：各 slot 插件客户端半边共用的原子组件。
// sprite 默认取壳资产，插件自带图标基路径时经 `icons` 覆盖；无 label 时对辅助技术隐藏。

import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** 缺省图标 sprite（壳同源资产）。 */
const DEFAULT_ICONS = '/assets/icons.v2.svg'

export function Icon(props: {
  name: string
  icons?: string
  size?: number
  label?: string
  className?: string
}): ReactNode {
  const { name, icons = DEFAULT_ICONS, size = 16, label = '', className } = props
  const named = label.length > 0
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
      className={className}
      role={named ? 'img' : undefined}
      aria-label={named ? label : undefined}
      aria-hidden={named ? undefined : true}
    >
      <use href={`${icons}#${name}`} />
    </svg>
  )
}

export type IconButtonProps = {
  /** 必须带可及名（`aria-label`）。 */
  label: string
  name: string
  icons?: string
  size?: number
  /** 危险动作标记（落 `data-danger`）。 */
  danger?: boolean
  /** 是否挂原生 `title`；有自绘 tooltip 时置 false，避免双层提示。 */
  showTitle?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'name' | 'aria-label'>

export function IconButton(props: IconButtonProps): ReactNode {
  const { name, label, icons, size, danger, showTitle = true, className, ...rest } = props
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={showTitle ? label : undefined}
      data-danger={danger === true ? 'true' : undefined}
      {...rest}
    >
      <Icon icons={icons} name={name} size={size} label={label} />
    </button>
  )
}
