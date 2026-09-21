// 插件页（只读）：身份名 + 状态 + 世代短哈希 + pins 摘要。人可见只读，不做管理入口。

import { el } from './dom.js'
import { emptyState } from './ui-parts.js'
import { identityRows } from './settings-model.js'

export function renderPlugins(ctx, content) {
  const rows = identityRows(ctx.state.identities)
  if (rows.length === 0) {
    content.appendChild(emptyState(ctx, 'settings_empty_plugins', 'settings_empty_plugins_hint'))
    return
  }
  const doc = ctx.doc
  const list = el(doc, 'div', { class: 'settings-list' })
  for (const rowData of rows) {
    const pins = Object.keys(rowData.pins)
    list.appendChild(
      el(doc, 'div', { class: 'settings-list-item' }, [
        el(doc, 'span', { class: 'settings-list-main', text: rowData.id }),
        el(doc, 'span', {
          class: 'settings-list-meta',
          text: rowData.retired ? ctx.text('settings_plugins_retired') : ctx.text('settings_plugins_active'),
        }),
        el(doc, 'span', { class: 'settings-list-meta', text: rowData.activeShort }),
        el(doc, 'span', { class: 'settings-list-meta', text: pins.length > 0 ? pins.join(',') : '-' }),
      ]),
    )
  }
  content.appendChild(list)
}
