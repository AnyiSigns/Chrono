// `ui-settings` 客户端半边入口（slot = overlay）：契约 '2' + `register(ctx)`。
// 壳提供唯一 React 运行时与 slot 宿主；本模块只注册组件、装配 React-free 视图上下文。
// 业务状态住 store（`view-context.ts`），叶子纯模型住同目录 `*.ts`（零 react import）。

import type { SlotContext } from '@chrono/ui-contract'
import { App, VcContext } from './components/App.tsx'
import { createViewContext } from './view-context.ts'

export const contract = '2'

export function register(ctx: SlotContext): void {
  const { vc, dispose } = createViewContext(ctx)
  // 视图上下文住 register 作用域：组件卸载不 dispose，错误边界重挂后仍是同一实例。
  function Overlay(props: { ctx: SlotContext }) {
    props.ctx.useStore(vc.store)
    return (
      <VcContext.Provider value={vc}>
        <App />
      </VcContext.Provider>
    )
  }
  const registered = ctx.slots.register({ name: 'overlay' }, Overlay)
  // 注册被拒（陈旧装载）：刚建的视图上下文立即 dispose，避免第二份在途。
  if (registered !== true) dispose()
}
