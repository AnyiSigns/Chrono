// UI 客户端半边契约（纯类型，零运行时代码）：slot 注册、壳 api、React-free store 绑定。
//
// 单一来源：壳实现本契约（`plugins/ui-shell/execute/web/lib/slots.js`），插件经 tsconfig `paths`
// 以 `@chrono/ui-contract` 引用。只用 `import type` —— esbuild 会擦除，构建期不产生任何模块依赖，
// 故不违反「插件不 import 宿主 / 内核 / 其他插件包」的运行期红线。

import type { ComponentType } from 'react'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface EventRecord {
  impl: string
  topic: string
  payload: Json
}

export interface ToastInput {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  text: string
  action?: string | { label?: string; run?: () => void }
}

/** 壳提供给每个客户端半边的 api（浏览器侧唯一能力面）。 */
export interface ChronoApi {
  tokens: { css: string; icons: string; messages: string }
  theme: {
    get(): string
    set(pref: string): Promise<Json>
    subscribe(callback: (pref: string) => void): () => void
  }
  navigate(path: string): void
  submit(directive: Json | Json[], options?: { thread?: string }): Promise<Json>
  command(name: string, args?: Json, options?: { thread?: string }): Promise<Json>
  cancel(run: string): Promise<Json>
  asset: {
    put(mime: string, bytes: string): Promise<Json>
    get(sha256: string): Promise<Json>
  }
  events: {
    subscribe(topic: string, callback: (payload: Json, record: EventRecord) => void): () => void
    onAny(callback: (record: EventRecord) => void): () => void
    connected(): boolean
  }
  toast(input: ToastInput): number
  uiState: {
    get(key: string): unknown
    set(key: string, value: unknown): void
    subscribe(key: string, callback: (value: unknown) => void): () => void
  }
}

/** React-free store：业务状态的唯一真源。 */
export interface ReadableStore<S> {
  getSnapshot(): S
  subscribe(listener: (snapshot: S) => void): () => void
}

export type SlotTarget = string | { name: string; children?: string[] }

/** 组件收到的 ctx：壳 api + 本插件身份 + store 绑定钩子 + slot 注册表。 */
export interface SlotContext extends ChronoApi {
  pluginId: string
  useStore<S>(store: ReadableStore<S>): S
  useStore<S, T>(store: ReadableStore<S>, selector: (snapshot: S) => T): T
  slots: {
    register(target: SlotTarget, Component: ComponentType<{ ctx: SlotContext }>): boolean
    Outlet: ComponentType<{ name: string }>
  }
}

/** 客户端半边模块契约：`export const contract = '2'` + `export function register(ctx)`。 */
export interface SlotModule {
  contract: '2'
  register(ctx: SlotContext): void | Promise<void>
}
