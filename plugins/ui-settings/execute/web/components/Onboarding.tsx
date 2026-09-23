// 引导页视图：整页铺满的居中单列（标题区 → 任务区），无左栏、无对话框卡片、无步骤条。
// 流程：入口（添加厂商 / 添加自定义厂商）→ 连接 + 模型表单。

import { useVc } from './ui.tsx'
import { ProviderEntry, ProviderForm } from './ProviderForm.tsx'

export function Onboarding() {
  const vc = useVc()
  const form = vc.state.onboarding ?? vc.defaultOnboarding()
  vc.state.onboarding = form
  const onEntry = form.templateIdentity === ''
  const titleKey = onEntry
    ? 'settings_onboarding_welcome'
    : form.templateIdentity === 'custom'
      ? 'settings_add_custom_provider'
      : 'settings_add_provider'
  return (
    <div className="settings-guide">
      <div className="settings-guide-inner">
        <div className="settings-guide-hero">
          {onEntry ? <div className="settings-guide-eyebrow">{vc.text('settings_onboarding_title')}</div> : null}
          <div className="settings-guide-hero-title" role="heading" aria-level={1}>
            {vc.text(titleKey)}
          </div>
          {onEntry ? <div className="settings-guide-hero-sub">{vc.text('settings_onboarding_subtitle')}</div> : null}
        </div>
        {onEntry ? (
          <ProviderEntry
            templates={form.templates}
            onPick={(entry) => {
              vc.chooseEntry(form, entry)
              vc.render()
            }}
          />
        ) : (
          <ProviderForm
            form={form}
            options={{
              submitLabel: vc.text('settings_complete'),
              busyLabel: vc.text('settings_completing'),
              primaryTone: 'ink',
              onSubmit: () => vc.commitProvider(form, { closeOnSuccess: true }),
              onBack: () => {
                form.templateIdentity = ''
                form.error = null
                vc.render()
              },
            }}
          />
        )}
      </div>
    </div>
  )
}
