// 模型页：无表单时 = 已保存厂商卡片 + 新建入口；有表单时 = 聚焦的表单视图（标题按入口区分）。
// 新建与引导页共用同一厂商表单；密钥状态来自只读命令 `secrets.status`。
// 当前模型不在本页选择：由对话输入框选择模型时写 `config.vendor` / `config.model`。

import { useState } from 'react'
import { EmptyState, Section, TextButton, useVc } from './ui.tsx'
import { isRecord, providerList, removeProvider } from '../config-model.ts'
import { CUSTOM_AUTH_REF_NAME, onboardingFromEntry } from '../onboarding.ts'
import { ProviderEntry, ProviderForm } from './ProviderForm.tsx'

export function ModelPanel() {
  const vc = useVc()
  const form = vc.state.providerForm
  if (form !== null) return <ProviderFormView form={form} />
  const providers = providerList(vc.state.config)
  return (
    <>
      <Section nameKey="settings_models_saved">
        {providers.length === 0 ? (
          <EmptyState nameKey="settings_no_provider" hintKey="settings_no_provider_hint" />
        ) : (
          <div className="settings-provider-list">
            {providers.map((item) => (
              <ProviderCard item={item} key={item.key} />
            ))}
          </div>
        )}
      </Section>
      <Section nameKey="settings_models_templates">
        <ProviderEntry
          templates={vc.state.vendors ?? []}
          onPick={(entry) => {
            const next = vc.defaultOnboarding()
            next.templates = vc.state.vendors ?? []
            vc.chooseEntry(next, entry)
            vc.state.providerForm = next
            vc.state.editingProvider = null
            vc.render()
          }}
        />
      </Section>
    </>
  )
}

/** 表单视图：创建 / 编辑共用一个聚焦视图，标题按入口区分。 */
function ProviderFormView(props: { form: any }) {
  const vc = useVc()
  const form = props.form
  if (form.mode === 'edit') {
    return (
      <Section nameKey="settings_edit_provider">
        <ProviderForm
          key={`edit:${form.editKey}`}
          form={form}
          options={{
            submitLabel: vc.text('settings_save_edit'),
            busyLabel: vc.text('settings_completing'),
            onSubmit: () => vc.commitProviderEdit(form, form.editKey),
            onCancel: () => {
              vc.state.providerForm = null
              vc.state.editingProvider = null
              vc.render()
            },
          }}
        />
      </Section>
    )
  }
  const titleKey = form.templateIdentity === 'custom' ? 'settings_add_custom_provider' : 'settings_add_provider'
  return (
    <Section nameKey={titleKey}>
      <ProviderForm
        key={`create:${form.templateIdentity}`}
        form={form}
        options={{
          submitLabel: vc.text('settings_complete'),
          busyLabel: vc.text('settings_completing'),
          onSubmit: () =>
            vc.commitProvider(form, {
              resetForm: () => {
                vc.state.providerForm = null
              },
            }),
          onBack: () => {
            vc.state.providerForm = null
            vc.render()
          },
        }}
      />
    </Section>
  )
}

/** 已保存厂商卡片：主行 = 名称 + 密钥状态 + 操作；次行 = 地址；密钥更新按需展开。 */
function ProviderCard(props: { item: any }) {
  const vc = useVc()
  const key = props.item.key
  const entry = props.item.entry
  const ref = isRecord(entry.auth_ref) ? entry.auth_ref : {}
  const hasRef = typeof ref.name === 'string' && ref.name.length > 0
  const refName = hasRef ? (ref.name as string) : CUSTOM_AUTH_REF_NAME
  const hasSecret = hasRef && vc.state.secrets[refName] === true
  const pending = vc.state.pendingRemove === key
  const [secretOpen, setSecretOpen] = useState(false)
  return (
    <div
      className="settings-provider-card"
      data-saved-key={`provider:${key}`}
      data-saved={vc.state.savedKey === `provider:${key}` ? 'true' : undefined}
    >
      <div className="settings-provider-head">
        <span className="settings-provider-id">
          <span className="settings-provider-name">{key}</span>
          <span className="settings-dot" data-tone={hasSecret ? 'success' : 'muted'} />
          <span className="settings-list-meta">
            {!hasRef
              ? vc.text('settings_secret_anonymous')
              : hasSecret
                ? vc.text('settings_secret_present')
                : vc.text('settings_secret_absent')}
          </span>
        </span>
        <span className="settings-provider-actions">
          <TextButton
            label={vc.text('settings_edit_provider')}
            onClick={() => {
              vc.state.providerForm = onboardingFromEntry(key, entry)
              vc.state.editingProvider = key
              vc.render()
            }}
          />
          <TextButton
            label={pending ? vc.text('settings_confirm') : vc.text('settings_remove_provider')}
            tone="danger"
            onClick={async () => {
              if (!pending) {
                vc.state.pendingRemove = key
                vc.render()
                return
              }
              vc.state.pendingRemove = null
              const result = await vc.writeConfig(removeProvider(vc.state.config ?? {}, key), `provider:${key}`)
              vc.state.error = result.ok ? null : { code: result.code, message: '' }
              vc.render()
            }}
          />
        </span>
      </div>
      {typeof entry.base_url === 'string' && entry.base_url.length > 0 ? (
        <div className="settings-provider-url settings-mono">{entry.base_url}</div>
      ) : null}
      {secretOpen ? (
        <SecretEditor refName={refName} providerKey={key} onClose={() => setSecretOpen(false)} />
      ) : (
        <div className="settings-provider-secret">
          <TextButton
            label={vc.text(hasSecret ? 'settings_secret_update' : 'settings_secret_save')}
            onClick={() => setSecretOpen(true)}
          />
        </div>
      )}
    </div>
  )
}

/** 密钥更新：只显掩码、不回显本体；保存成功即收起，状态点随 `secrets.status` 刷新。 */
function SecretEditor(props: { refName: string; providerKey: string; onClose: () => void }) {
  const vc = useVc()
  const [value, setValue] = useState('')
  const close = () => {
    setValue('')
    props.onClose()
  }
  return (
    <div className="settings-secret-editor">
      <input
        className="settings-input settings-mono"
        type="password"
        value={value}
        placeholder={vc.text('settings_secret_placeholder')}
        aria-label={vc.text('settings_secret_update')}
        autoComplete="off"
        autoFocus
        onChange={(event) => setValue(event.target.value)}
      />
      <TextButton
        label={vc.text('settings_secret_save')}
        onClick={async () => {
          // 失败保留已输入值（行内错误条由 TabContent 呈现），用户可直接改后重试。
          const saved = await vc.saveProviderSecret(props.refName, value, props.providerKey)
          if (saved) close()
        }}
      />
      <TextButton label={vc.text('settings_cancel')} onClick={close} />
    </div>
  )
}
