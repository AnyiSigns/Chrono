// 引导页视图：无配置时整页居中卡片；先选入口（添加厂商 / 添加自定义厂商），再进对应表单。
// 错误条由表单自身渲染（此处不再重复）。

import { el } from './dom.js'
import { renderProviderEntry, renderProviderForm } from './provider-form.js'

export function renderOnboarding(ctx) {
  const form = ctx.state.onboarding ?? ctx.defaultOnboarding()
  ctx.state.onboarding = form
  const card = el(ctx.doc, 'div', { class: 'settings-guide-card' }, [
    el(ctx.doc, 'div', { class: 'settings-guide-head' }, [
      el(ctx.doc, 'div', { class: 'settings-guide-title', text: ctx.text('settings_onboarding_title') }),
      el(ctx.doc, 'div', { class: 'settings-guide-intro', text: ctx.text('settings_onboarding_intro') }),
    ]),
  ])
  const content = el(ctx.doc, 'div', {})
  card.appendChild(content)
  if (form.templateIdentity === '') {
    renderProviderEntry(ctx, content, form.templates, (entry) => {
      ctx.chooseEntry(form, entry)
      ctx.render()
    })
  } else {
    renderProviderForm(ctx, content, form, {
      submitLabel: ctx.text('settings_complete'),
      busyLabel: ctx.text('settings_completing'),
      onSubmit: () => ctx.commitProvider(form, { closeOnSuccess: true }),
      onBack: () => {
        form.templateIdentity = ''
        form.error = null
        ctx.render()
      },
    })
  }
  return el(ctx.doc, 'div', { class: 'settings-guide' }, [card])
}
