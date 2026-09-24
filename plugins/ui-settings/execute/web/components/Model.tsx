// 模型页：上区已保存厂商（编辑地址 / 更新密钥 / 删除），下区模板与自定义新建。
// 新建与引导页共用同一厂商表单；密钥状态来自只读命令 `secrets.status`。
// 当前模型不在本页选择：由对话输入框选择模型时写 `config.vendor` / `config.model`。

import { useState } from 'react'
import { EmptyState, Section, TextButton, useVc } from './ui.tsx'
import { isRecord, providerList, removeProvider } from '../config-model.ts'
import { onboardingFromEntry } from '../onboarding.ts'
import { ProviderEntry, ProviderForm } from './ProviderForm.tsx'

export function ModelPanel() {
  const vc = useVc()
  const providers = providerList(vc.state.config)
  return (
    <>
      {providers.length === 0 ? (
        <Section nameKey="settings_models_saved">
          <EmptyState nameKey="settings_no_provider" hintKey="settings_no_provider_hint" />
        </Section>
      ) : (
        <Section nameKey="settings_models_saved">
          <div className="settings-list">
            {providers.map((item) => (
              <ProviderRow item={item} key={item.key} />
            ))}
          </div>
        </Section>
      )}
      <NewProviderSection />
    </>
  )
}

function ProviderRow(props: { item: any }) {
  const vc = useVc()
  const key = props.item.key
  const entry = props.item.entry
  const ref = isRecord(entry.auth_ref) ? entry.auth_ref : {}
  const refName = typeof ref.name === 'string' ? ref.name : ''
  const hasSecret = vc.state.secrets[refName] === true
  const pending = vc.state.pendingRemove === key
  return (
    <div className="settings-list-item" data-saved-key={`provider:${key}`} data-saved={vc.state.savedKey === `provider:${key}` ? 'true' : undefined}>
      <span className="settings-list-main">{`${key} · ${entry.base_url ?? ''}`}</span>
      <span className="settings-list-meta">
        <span className="settings-dot" data-tone={hasSecret ? 'success' : 'danger'} />
        <span>{hasSecret ? vc.text('settings_secret_present') : vc.text('settings_secret_absent')}</span>
      </span>
      <TextButton
        label={vc.text('settings_edit_provider')}
        onClick={() => {
          vc.state.providerForm = onboardingFromEntry(key, entry)
          vc.state.editingProvider = key
          vc.render()
        }}
      />
      <SecretEditor refName={refName} providerKey={key} />
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
          if (!result.ok) vc.state.error = { code: result.code, message: '' }
          vc.render()
        }}
      />
    </div>
  )
}

/** 每厂商密钥更新入口：只显掩码、不回显本体；保存后刷新「已读到 / 未读到」点。 */
function SecretEditor(props: { refName: string; providerKey: string }) {
  const vc = useVc()
  const [value, setValue] = useState('')
  return (
    <span className="settings-row-value">
      <input
        className="settings-input"
        type="password"
        value={value}
        placeholder={vc.text('settings_secret_placeholder')}
        aria-label={vc.text('settings_secret_update')}
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
      />
      <TextButton
        label={vc.text('settings_secret_save')}
        onClick={async () => {
          const next = value
          setValue('')
          await vc.saveProviderSecret(props.refName, next, `provider:${props.providerKey}`)
        }}
      />
    </span>
  )
}

function NewProviderSection() {
  const vc = useVc()
  const form = vc.state.providerForm
  if (form === null) {
    return (
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
    )
  }
  if (form.mode === 'edit') {
    return (
      <Section nameKey="settings_edit_provider">
        <ProviderForm
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
  return (
    <Section nameKey="settings_models_templates">
      <ProviderForm
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
