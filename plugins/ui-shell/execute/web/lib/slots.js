// slot 注册表与 React 挂载宿主：插件客户端半边经 `register(ctx)` 把组件注册进命名 slot。
// 壳不认识业务，只提供 outlet、单一 React 运行时与每 slot 的 error boundary。
//
// 契约（客户端半边模块）：
//   export const contract = '2'
//   export function register(ctx) { ctx.slots.register({ name, children }, Component) }
// `name` 为目标 slot；`children` 声明本组件提供的子 slot（组件内用 `ctx.slots.Outlet` 落位）。
// 顶层 slot（sidebar / main / dock / composer / topbar / overlay）直接映射到壳页面的
// `[data-slot="<name>"]` 元素；嵌套 slot 由父组件的 `<Outlet name="…"/>` 创建。
//
// 纯簿记（目标归一 / epoch 拒绝 / 幂等替换 / outlet 绑定）在 `slot-registry.js`，可脱离浏览器单测；
// 本文件只在其上挂 React 渲染与错误边界。

import { Component, createElement, useEffect, useRef, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createSlotRegistry, normalizeTarget } from './slot-registry.js'

export { normalizeTarget }

/** 顶层 slot 名（壳页面已提供 outlet 元素）。 */
export const TOP_SLOTS = ['sidebar', 'main', 'dock', 'composer', 'topbar', 'overlay']

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
    const name = typeof props.name === 'string' ? props.name : ''
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
 * 返回 `{ ctxFor(pluginId), register(pluginId, target, Component), Outlet, attachOutlet, detachOutlet }`。
 */
export function createSlotHost(options) {
  const msg = typeof options.msg === 'function' ? options.msg : () => ({ title: '', body: '', action: '' })
  const api = options.api ?? {}
  const registry = createSlotRegistry({ currentEpoch: options.currentEpoch })

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
      createElement(entry.payload.Component, { ctx: entry.payload.ctx }),
    )
    entry.container.root.render(surface)
  }

  function flush(name) {
    const slot = registry.slotOf(name)
    if (slot.element === null) return
    for (const entry of slot.entries) {
      if (entry.mounted === true) continue
      entry.mounted = true
      renderEntry(slot, entry)
    }
  }

  /** 卸一个条目：卸载其 React 根（触发组件 cleanup，如 store.dispose）。 */
  function disposeEntry(entry) {
    if (entry.container !== null) {
      detachElement(entry.container)
      entry.container = null
    }
    entry.mounted = false
  }

  function register(pluginId, target, Component, epoch) {
    if (typeof Component !== 'function') {
      if (typeof options.log === 'function') options.log(`slot register rejected: ${pluginId}`)
      return false
    }
    const outcome = registry.register(pluginId, target, epoch, { Component, ctx: ctxFor(pluginId) })
    if (!outcome.ok) {
      if (typeof options.log === 'function') options.log(`slot register ${outcome.reason}: ${pluginId}`)
      return false
    }
    // 幂等：同插件同 slot 的旧条目由注册簿移出，这里卸其 React 根。
    for (const old of outcome.removed) disposeEntry(old)
    if (registry.elementOf(outcome.name) === null) {
      registry.setElement(outcome.name, topElement(outcome.name))
    }
    flush(outcome.name)
    return true
  }

  function attachOutlet(name, element) {
    registry.setElement(name, element)
    flush(name)
  }

  function detachOutlet(name) {
    const slot = registry.slotOf(name)
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

  function ctxFor(pluginId, epoch) {
    return {
      ...api,
      pluginId,
      useStore,
      slots: {
        register: (target, Component) => register(pluginId, target, Component, epoch),
        Outlet,
      },
    }
  }

  return { ctxFor, register, Outlet, attachOutlet, detachOutlet }
}
