// 通用页：主题三卡片、语言（置灰只读）、通知分组（含浏览器权限状态）、配置导入 / 导出。
// 即时保存 + 150ms 行高亮；主题切换由壳写 config（唯一一次写）。

import { el, icon, labeledButton, textButton } from './dom.js'
import { row, section } from './ui-parts.js'
import { emptyConfig, setNotify } from './config-model.js'
import {
  canRequestPermission,
  mergeToggles,
  NOTIFY_KEYS,
  permissionMessageKey,
  permissionTone,
  toggleValue,
  togglesDisabled,
} from './notify.js'

const THEME_CARDS = [
  { id: 'day', icon: 'sun' },
  { id: 'night', icon: 'moon' },
  { id: 'system', icon: 'monitor' },
]

export function renderGeneral(ctx, content) {
  const doc = ctx.doc
  content.appendChild(section(ctx, 'settings_theme', [themeCards(ctx)]))
  content.appendChild(
    section(ctx, 'settings_language', [
      row(ctx, ctx.text('settings_language'), el(doc, 'span', { class: 'settings-muted', text: ctx.text('settings_language_locked') })),
    ]),
  )
  content.appendChild(section(ctx, 'settings_notify', notifyGroup(ctx)))
  content.appendChild(configActions(ctx))
}

function themeCards(ctx) {
  const doc = ctx.doc
  const cards = el(doc, 'div', { class: 'settings-theme-cards', dataset: { savedKey: 'theme' } })
  for (const card of THEME_CARDS) {
    const selected = ctx.currentThemePref() === card.id
    const wrap = el(doc, 'div', { class: 'settings-theme-wrap' })
    const button = el(doc, 'button', {
      class: 'settings-theme-card',
      attrs: { type: 'button', 'aria-pressed': selected ? 'true' : 'false' },
    })
    button.appendChild(icon(doc, card.icon, 20))
    button.appendChild(el(doc, 'span', { text: ctx.text(`settings_theme_${card.id}`) }))
    button.addEventListener('click', () => {
      void ctx.setTheme(card.id).then(() => ctx.render())
    })
    wrap.appendChild(button)
    if (selected) {
      const check = icon(doc, 'check', 16)
      check.setAttribute('class', 'settings-theme-check')
      wrap.appendChild(check)
    }
    cards.appendChild(wrap)
  }
  return cards
}

function notifyGroup(ctx) {
  const doc = ctx.doc
  const rows = []
  for (const key of NOTIFY_KEYS) {
    const toggle = el(doc, 'input', { attrs: { type: 'checkbox' } })
    toggle.checked = toggleValue(ctx.state.notify, key)
    toggle.disabled = togglesDisabled(ctx.state.permission)
    toggle.addEventListener('change', async () => {
      const next = mergeToggles(ctx.state.notify, { [key]: toggle.checked })
      await ctx.writeConfig(setNotify(ctx.state.config ?? emptyConfig(), key, toggle.checked), `notify:${key}`)
      ctx.state.notify = next
      ctx.render()
    })
    rows.push(row(ctx, ctx.text(`settings_notify_${key}`), toggle, { savedKey: `notify:${key}` }))
  }
  return [permissionRow(ctx), ...rows]
}

function permissionRow(ctx) {
  const doc = ctx.doc
  const value = el(doc, 'span', { class: 'settings-row-value' }, [
    el(doc, 'span', { class: 'settings-dot', dataset: { tone: permissionTone(ctx.state.permission) } }),
    el(doc, 'span', { text: ctx.text(permissionMessageKey(ctx.state.permission)) }),
    canRequestPermission(ctx.state.permission)
      ? textButton(doc, ctx.text('settings_notify_request'), () => void ctx.requestPermission())
      : null,
  ])
  return el(doc, 'div', { class: 'settings-row' }, [
    el(doc, 'span', { class: 'settings-row-label', text: ctx.text('settings_notify_permission') }),
    value,
  ])
}

function configActions(ctx) {
  const doc = ctx.doc
  const actions = el(doc, 'div', { class: 'settings-row-value', dataset: { savedKey: 'import' } }, [
    labeledButton(doc, 'download', ctx.text('settings_export'), () => ctx.exportConfig()),
    labeledButton(doc, 'upload', ctx.text('settings_import'), () => ctx.importConfig()),
  ])
  return section(ctx, null, [
    el(doc, 'div', { class: 'settings-row' }, [
      el(doc, 'span', {
        class: 'settings-row-label',
        text: `${ctx.text('settings_import')} / ${ctx.text('settings_export')}`,
      }),
      actions,
    ]),
  ])
}
