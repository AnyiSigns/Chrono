// 模型页：上区已保存厂商（增删改 / 切默认模型 / 密钥引用状态），下区模板与自定义新建。
// 新建与引导页共用同一厂商表单；密钥状态来自只读命令 `secrets.status`。

import { el, textButton } from './dom.js'
import { emptyState, row, section } from './ui-parts.js'
import { emptyConfig, enabledModelIds, isRecord, providerList, removeProvider, setParams, setSelection } from './config-model.js'
import { onboardingFromEntry } from './onboarding.js'
import { renderProviderForm } from './provider-form.js'

export function renderModel(ctx, content) {
  const doc = ctx.doc
  const providers = providerList(ctx.state.config)
  if (providers.length === 0) {
    content.appendChild(section(ctx, 'settings_models_saved', [emptyState(ctx, 'settings_no_provider', 'settings_no_provider_hint')]))
  } else {
    const list = el(doc, 'div', { class: 'settings-list' })
    for (const item of providers) list.appendChild(providerRow(ctx, item.key, item.entry))
    content.appendChild(section(ctx, 'settings_models_saved', [list]))
  }
  content.appendChild(paramsSection(ctx))
  content.appendChild(newProviderSection(ctx))
}

function providerRow(ctx, key, entry) {
  const doc = ctx.doc
  const models = enabledModelIds(entry)
  const current = isRecord(ctx.state.config) ? ctx.state.config : emptyConfig()
  const select = el(doc, 'select', {
    class: 'settings-select',
    attrs: { 'aria-label': ctx.text('settings_default_model') },
  })
  for (const id of models) select.appendChild(el(doc, 'option', { text: id, attrs: { value: id } }))
  select.value = current.vendor === key && typeof current.model === 'string' ? current.model : (models[0] ?? '')
  select.addEventListener('change', async () => {
    await ctx.writeConfig(setSelection(ctx.state.config ?? emptyConfig(), key, select.value), `provider:${key}`)
    ctx.render()
  })
  const remove = textButton(
    doc,
    ctx.state.pendingRemove === key ? ctx.text('settings_confirm') : ctx.text('settings_remove_provider'),
    async () => {
      if (ctx.state.pendingRemove !== key) {
        ctx.state.pendingRemove = key
        ctx.render()
        return
      }
      ctx.state.pendingRemove = null
      await ctx.writeConfig(removeProvider(ctx.state.config ?? emptyConfig(), key), `provider:${key}`)
      ctx.render()
    },
    { tone: 'danger' },
  )
  const ref = isRecord(entry.auth_ref) ? entry.auth_ref : {}
  const refName = typeof ref.name === 'string' ? ref.name : ''
  const hasSecret = ctx.state.secrets[refName] === true
  return el(doc, 'div', { class: 'settings-list-item', dataset: { savedKey: `provider:${key}` } }, [
    el(doc, 'span', { class: 'settings-list-main', text: `${key} · ${entry.base_url ?? ''}` }),
    el(doc, 'span', { class: 'settings-list-meta' }, [
      el(doc, 'span', { class: 'settings-dot', dataset: { tone: hasSecret ? 'success' : 'danger' } }),
      el(doc, 'span', {
        text: `${refName} · ${hasSecret ? ctx.text('settings_secret_present') : ctx.text('settings_secret_absent')}`,
      }),
    ]),
    select,
    refreshButton(ctx, key),
    editButton(ctx, key, entry),
    secretEditor(ctx, key, refName),
    remove,
  ])
}

/** 重拉档案：调 `model.profile` 刷新该厂商的 context_window / max_output / reasoning / modalities。 */
function refreshButton(ctx, key) {
  return textButton(ctx.doc, ctx.text('settings_refresh_profile'), () => void ctx.refreshProvider(key))
}

/** 改：打开编辑表单改 `base_url` / `auth_ref`（与引导页表单同形）。 */
function editButton(ctx, key, entry) {
  return textButton(ctx.doc, ctx.text('settings_edit_provider'), () => {
    ctx.state.providerForm = onboardingFromEntry(key, entry)
    ctx.state.editingProvider = key
    ctx.render()
  })
}

/** 每厂商密钥更新入口：只显掩码、不回显本体；保存后刷新「已读到 / 未读到」点。 */
function secretEditor(ctx, key, refName) {
  const doc = ctx.doc
  const input = el(doc, 'input', {
    class: 'settings-input',
    attrs: {
      type: 'password',
      value: '',
      placeholder: ctx.text('settings_secret_placeholder'),
      'aria-label': ctx.text('settings_secret_update'),
      autocomplete: 'off',
    },
  })
  const save = textButton(doc, ctx.text('settings_secret_save'), async () => {
    const value = input.value
    input.value = ''
    await ctx.saveProviderSecret(refName, value, `provider:${key}`)
  })
  return el(doc, 'span', { class: 'settings-row-value' }, [input, save])
}

function paramsSection(ctx) {
  const doc = ctx.doc
  const current = isRecord(ctx.state.config) ? ctx.state.config : emptyConfig()
  const params = isRecord(current.params) ? current.params : {}
  const reasoning = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'text', value: typeof params.reasoning === 'string' ? params.reasoning : '' },
  })
  const temperature = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'number', step: '0.1', value: params.temperature === undefined ? '' : String(params.temperature) },
  })
  const maxTokens = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'number', value: params.max_tokens === undefined ? '' : String(params.max_tokens) },
  })
  const save = textButton(doc, ctx.text('settings_save_params'), async () => {
    const patch = {}
    if (temperature.value !== '') patch.temperature = Number(temperature.value)
    if (maxTokens.value !== '') patch.max_tokens = Number(maxTokens.value)
    if (reasoning.value !== '') patch.reasoning = reasoning.value
    await ctx.writeConfig(setParams(ctx.state.config ?? emptyConfig(), patch), 'params')
    ctx.render()
  })
  return section(ctx, null, [
    row(ctx, ctx.text('settings_reasoning'), reasoning),
    row(ctx, ctx.text('settings_temperature'), temperature),
    row(ctx, ctx.text('settings_max_tokens'), maxTokens),
    el(doc, 'div', { class: 'settings-guide-actions', dataset: { savedKey: 'params' } }, [save]),
  ])
}

function newProviderSection(ctx) {
  const doc = ctx.doc
  const form = ctx.state.providerForm
  if (form === null) {
    return section(ctx, 'settings_models_templates', [
      textButton(doc, ctx.text('settings_new_provider'), () => {
        ctx.state.providerForm = ctx.defaultOnboarding()
        ctx.state.providerForm.templates = ctx.state.vendors ?? []
        ctx.state.editingProvider = null
        ctx.render()
      }),
    ])
  }
  const node = el(doc, 'div', {})
  if (form.mode === 'edit') {
    renderProviderForm(ctx, node, form, {
      submitLabel: ctx.text('settings_save_edit'),
      busyLabel: ctx.text('settings_completing'),
      onSubmit: () => ctx.commitProviderEdit(form, form.editKey),
      onCancel: () => {
        ctx.state.providerForm = null
        ctx.state.editingProvider = null
        ctx.render()
      },
    })
    return section(ctx, 'settings_edit_provider', [node])
  }
  renderProviderForm(ctx, node, form, {
    submitLabel: ctx.text('settings_complete'),
    busyLabel: ctx.text('settings_completing'),
    onSubmit: () => ctx.commitProvider(form, { resetForm: () => { ctx.state.providerForm = null } }),
  })
  return section(ctx, 'settings_models_templates', [node])
}
