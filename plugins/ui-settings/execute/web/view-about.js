// 关于页：版本、宿主地址、插件数（不渲染账本链头）。

import { el } from './dom.js'
import { row, section } from './ui-parts.js'
import { pluginCount } from './settings-model.js'
import { PLUGIN_VERSION } from './version.js'

export function renderAbout(ctx, content) {
  const doc = ctx.doc
  const host = doc.defaultView?.location?.host ?? ''
  content.appendChild(
    section(ctx, null, [
      row(ctx, ctx.text('settings_about_version'), el(doc, 'span', { class: 'settings-list-meta', text: PLUGIN_VERSION })),
      row(ctx, ctx.text('settings_about_host'), el(doc, 'span', { class: 'settings-list-meta', text: host })),
      row(
        ctx,
        ctx.text('settings_about_plugins'),
        el(doc, 'span', { class: 'settings-list-meta', text: String(pluginCount(ctx.state.identities)) }),
      ),
    ]),
  )
}
