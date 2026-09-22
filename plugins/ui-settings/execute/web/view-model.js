// 模型页：上区已保存厂商（编辑地址 / 更新密钥 / 删除），下区模板与自定义新建。
// 新建与引导页共用同一厂商表单；密钥状态来自只读命令 `secrets.status`。
// 当前模型不在本页选择：由对话输入框选择模型时写 `config.vendor` / `config.model`。

import { el, textButton } from './dom.js'
import { emptyState, section } from './ui-parts.js'
import { isRecord, providerList, removeProvider } from './config-model.js'
import { onboardingFromEntry } from './onboarding.js'
import { renderProviderEntry, renderProviderForm } from './provider-form.js'

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
  content.appendChild(newProviderSection(ctx))
}

function providerRow(ctx, key, entry) {
  const doc = ctx.doc
  const ref = isRecord(entry.auth_ref) ? entry.auth_ref : {}
  const refName = typeof ref.name === 'string' ? ref.name : ''
  const hasSecret = ctx.state.secrets[refName] === true
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
      await ctx.writeConfig(removeProvider(ctx.state.config ?? {}, key), `provider:${key}`)
      ctx.render()
    },
    { tone: 'danger' },
  )
  return el(doc, 'div', { class: 'settings-list-item', dataset: { savedKey: `provider:${key}` } }, [
    el(doc, 'span', { class: 'settings-list-main', text: `${key} · ${entry.base_url ?? ''}` }),
    el(doc, 'span', { class: 'settings-list-meta' }, [
      el(doc, 'span', { class: 'settings-dot', dataset: { tone: hasSecret ? 'success' : 'danger' } }),
      el(doc, 'span', {
        text: hasSecret ? ctx.text('settings_secret_present') : ctx.text('settings_secret_absent'),
      }),
    ]),
    editButton(ctx, key, entry),
    secretEditor(ctx, key, refName),
    remove,
  ])
}

/** 改：打开编辑表单改 `base_url`（密钥 / 模型 / 档案元数据原样保留）。 */
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

function newProviderSection(ctx) {
  const doc = ctx.doc
  const form = ctx.state.providerForm
  if (form === null) {
    const node = el(doc, 'div', {})
    renderProviderEntry(ctx, node, ctx.state.vendors ?? [], (entry) => {
      const next = ctx.defaultOnboarding()
      next.templates = ctx.state.vendors ?? []
      ctx.chooseEntry(next, entry)
      ctx.state.providerForm = next
      ctx.state.editingProvider = null
      ctx.render()
    })
    return section(ctx, 'settings_models_templates', [node])
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
    onBack: () => {
      ctx.state.providerForm = null
      ctx.render()
    },
  })
  return section(ctx, 'settings_models_templates', [node])
}
