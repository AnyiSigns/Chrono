// 记忆页：v1 为版本提升预留（不 pin 记忆族、不含 memory.* 命令），显示依赖未就绪。

import { el, icon } from './dom.js'
import { section } from './ui-parts.js'

export function renderMemory(ctx, content) {
  content.appendChild(
    section(ctx, null, [
      el(ctx.doc, 'div', { class: 'settings-empty' }, [
        icon(ctx.doc, 'brain', 20),
        el(ctx.doc, 'div', { text: ctx.text('settings_memory_pending') }),
        el(ctx.doc, 'div', { class: 'settings-empty-hint', text: ctx.text('settings_memory_pending_hint') }),
      ]),
    ]),
  )
}
