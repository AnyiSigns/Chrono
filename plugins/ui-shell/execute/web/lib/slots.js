// slot 注册表与 React 挂载宿主：插件客户端半边经 `register(ctx)` 把组件注册进命名 slot。
// 壳不认识业务，只提供 outlet、单一 React 运行时与每 slot 的 error boundary。
//
// 契约（客户端半边模块）：
//   export const contract = '2'
//   export function register(ctx) { ctx.slots.register({ name, children }, Component) }
// `name` 为目标 slot；`children` 声明本组件提供的子 slot（组件内用 `ctx.slots.Outlet` 落位）。
// 顶层 slot（sidebar / main / dock / composer / topbar / overlay）直接映射到壳页面的
// `[data-slot="<name>"]` 元素；嵌套 slot 由父组件的 `<Outlet name="…"/>` 创建。

import { Component, createElement, useEffect, useRef, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'

/** 顶层 slot 名（壳页面已提供 outlet 元素）。 */
export const TOP_SLOTS = ['sidebar', 'main', 'dock', 'composer', 'topbar', 'overlay']

function isName(value) {
  return typeof value === 'string' && value.length > 0
}

/** 目标归一：字符串或 `{name, children}` 都接受。 */
function normalizeTarget(target) {
  if (isName(target)) return { name: target, children: [] }
  if (target !== null && typeof target === 'object' && isName(target.name)) {
    const children = Array.isArray(target.children)
      ? target.children.filter((item) => isName(item))
      : []
    return { name: target.name, children }
  }
  return null
}

/** 每 slot 的 error boundary：抛错只坏本 slot，渲染占位卡 + 重试。 */
class SlotErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
    this.retry = this.retry.bind(this)
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    if (typeof this.props.onError === 'function') this.props.onError(error)
  }

  retry() {
    this.setState({ failed: false })
    if (typeof this.props.onRetry === 'function') this.props.onRetry()
  }

  render() {
    if (this.state.failed === true) {
      return createElement(
        'div',
        { className: 'shell-slot-failed' },
        createElement('div', { className: 'shell-slot-failed-title' }, this.props.title),
        createElement('div', null, this.props.body),
        createElement('button', { type: 'button', onClick: this.retry }, this.props.action),
      )
    }
    return this.props.children
  }
}

/** 父组件用来落位子 slot 的 outlet：挂载后把 DOM 元素交给注册表，卸载时交还。 */
function makeOutlet(host) {
  return function Outlet(props) {
    const name = isName(props.name) ? props.name : ''
    const ref = useRef(null)
    useEffect(() => {
      if (name.length === 0) return undefined
      host.attachOutlet(name, ref.current)
      return () => host.detachOutlet(name)
    }, [name])
    return createElement('div', { 'data-slot-outlet': name, ref })
  }
}

/**
 * 建 slot 宿主。`options.msg(code)` 取文案；`options.api` 为壳 api（注入各插件 ctx）。
 * 返回 `{ ctxFor(pluginId), register(pluginId, target, Component) }`。
 */
export function createSlotHost(options) {
  const slots = new Map()
  const msg = typeof options.msg === 'function' ? options.msg : () => ({ title: '', body: '', action: '' })
  const api = options.api ?? {}

  function slotOf(name) {
    let slot = slots.get(name)
    if (slot === undefined) {
      slot = { name, element: null, entries: [] }
      slots.set(name, slot)
    }
    return slot
  }

  function topElement(name) {
    if (typeof document === 'undefined') return null
    return document.querySelector(`[data-slot="${name}"]`)
  }

  function detachElement(container) {
    if (container.root !== null) {
      container.root.unmount()
      container.root = null
    }
    if (container.el.parentNode !== null) container.el.parentNode.removeChild(container.el)
  }

  function renderEntry(slot, entry) {
    if (entry.container === null) {
      const el = document.createElement('div')
      el.className = 'shell-slot-app'
      el.dataset.slotApp = entry.pluginId
      slot.element.appendChild(el)
      entry.container = { el, root: createRoot(el) }
    }
    const failure = msg('ui_boot_failed')
    const surface = createElement(
      SlotErrorBoundary,
      {
        title: failure.title,
        body: failure.body,
        action: failure.action ?? '',
        onError: (error) => {
          if (typeof options.log === 'function') {
            options.log(`slot ${slot.name} (${entry.pluginId}) failed: ${String(error)}`)
          }
        },
        onRetry: () => renderEntry(slot, entry),
      },
      createElement(entry.Component, { ctx: entry.ctx }),
    )
    entry.container.root.render(surface)
  }

  function flush(name) {
    const slot = slotOf(name)
    if (slot.element === null) return
    for (const entry of slot.entries) {
      if (entry.mounted === true) continue
      entry.mounted = true
      renderEntry(slot, entry)
    }
  }

  function register(pluginId, target, Component) {
    const normalized = normalizeTarget(target)
    if (normalized === null || typeof Component !== 'function') {
      if (typeof options.log === 'function') options.log(`slot register rejected: ${pluginId}`)
      return false
    }
    for (const child of normalized.children) slotOf(child)
    const slot = slotOf(normalized.name)
    slot.entries.push({
      pluginId,
      Component,
      ctx: ctxFor(pluginId),
      container: null,
      mounted: false,
    })
    if (slot.element === null) slot.element = topElement(normalized.name)
    flush(normalized.name)
    return true
  }

  function attachOutlet(name, element) {
    const slot = slotOf(name)
    slot.element = element
    flush(name)
  }

  function detachOutlet(name) {
    const slot = slots.get(name)
    if (slot === undefined) return
    slot.element = null
    for (const entry of slot.entries) {
      if (entry.container !== null) detachElement(entry.container)
      entry.container = null
      entry.mounted = false
    }
  }

  const Outlet = makeOutlet({ attachOutlet, detachOutlet })

  /**
   * 把 React-free store 绑成 React hook（壳侧唯一 uSES 集成点）：
   * `useStore(store)` 返回快照；`useStore(store, selector)` 返回投影。
   * selector 必须返回稳定引用或原始值（uSES 要求 getSnapshot 可缓存）。
   */
  function useStore(store, selector) {
    const pick = typeof selector === 'function' ? selector : (snapshot) => snapshot
    return useSyncExternalStore(
      (notify) => store.subscribe(() => notify()),
      () => pick(store.getSnapshot()),
    )
  }

  function ctxFor(pluginId) {
    return {
      ...api,
      pluginId,
      useStore,
      slots: {
        register: (target, Component) => register(pluginId, target, Component),
        Outlet,
      },
    }
  }

  return { ctxFor, register, Outlet, attachOutlet, detachOutlet }
}
