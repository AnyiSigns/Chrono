// 引导页视图：整页铺满的居中单列（标题区 → 任务区），无左栏、无对话框卡片、无步骤条。
// 流程：入口（添加厂商 / 添加自定义厂商）→ 连接 + 模型表单；表单分组名即流程结构，不再另设进度指示。
// 文案克制：入口页眉标 + 欢迎语 + 一句说明，表单页只留入口名与操作；错误条由表单自身渲染。
// 单色：不引 accent，层级只靠字阶、留白与发丝线。

import { el } from './dom.js'
import { renderProviderEntry, renderProviderForm } from './provider-form.js'

export function renderOnboarding(ctx) {
  const form = ctx.state.onboarding ?? ctx.defaultOnboarding()
  ctx.state.onboarding = form
  const onEntry = form.templateIdentity === ''

  const inner = el(ctx.doc, 'div', { class: 'settings-guide-inner' }, [guideHero(ctx, onEntry, form)])
  if (onEntry) {
    renderProviderEntry(ctx, inner, form.templates, (entry) => {
      ctx.chooseEntry(form, entry)
      ctx.render()
    })
  } else {
    renderProviderForm(ctx, inner, form, {
      submitLabel: ctx.text('settings_complete'),
      busyLabel: ctx.text('settings_completing'),
      primaryTone: 'ink',
      onSubmit: () => ctx.commitProvider(form, { closeOnSuccess: true }),
      onBack: () => {
        form.templateIdentity = ''
        form.error = null
        ctx.render()
      },
    })
  }
  return el(ctx.doc, 'div', { class: 'settings-guide' }, [inner])
}

/** 标题区：入口页为眉标（开始使用）+ 欢迎语 + 说明句；表单页只留入口名（眉标与说明句在此冗余）。 */
function guideHero(ctx, onEntry, form) {
  const doc = ctx.doc
  const titleKey = onEntry
    ? 'settings_onboarding_welcome'
    : form.templateIdentity === 'custom'
      ? 'settings_add_custom_provider'
      : 'settings_add_provider'
  return el(doc, 'div', { class: 'settings-guide-hero' }, [
    onEntry
      ? el(doc, 'div', { class: 'settings-guide-eyebrow', text: ctx.text('settings_onboarding_title') })
      : null,
    el(doc, 'div', {
      class: 'settings-guide-hero-title',
      text: ctx.text(titleKey),
      attrs: { role: 'heading', 'aria-level': '1' },
    }),
    onEntry
      ? el(doc, 'div', { class: 'settings-guide-hero-sub', text: ctx.text('settings_onboarding_subtitle') })
      : null,
  ])
}
