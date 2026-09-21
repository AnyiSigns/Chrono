// 引导页视图：无配置时整页居中卡片；模板与自定义共用同一厂商表单。

import { el } from './dom.js'
import { errorBar } from './ui-parts.js'
import { renderProviderForm } from './provider-form.js'

export function renderOnboarding(ctx) {
  const form = ctx.state.onboarding ?? ctx.defaultOnboarding()
  ctx.state.onboarding = form
  const card = el(ctx.doc, 'div', { class: 'settings-guide-card' }, [
    el(ctx.doc, 'div', { class: 'settings-guide-title', text: ctx.text('settings_title') }),
    el(ctx.doc, 'div', { class: 'settings-guide-intro', text: ctx.text('settings_required') }),
  ])
  const content = el(ctx.doc, 'div', {})
  card.appendChild(content)
  renderProviderForm(ctx, content, form, {
    submitLabel: ctx.text('settings_complete'),
    busyLabel: ctx.text('settings_completing'),
    onSubmit: () => ctx.commitProvider(form, { closeOnSuccess: true }),
  })
  if (form.error !== null) card.appendChild(errorBar(ctx, form.error))
  return el(ctx.doc, 'div', { class: 'settings-guide' }, [card])
}
