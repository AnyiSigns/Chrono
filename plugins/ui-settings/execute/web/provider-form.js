// 厂商表单（引导页与模型页共用）：模板 / 自定义 → 地址 / 密钥引用 → 获取模型 → 勾选 → 默认模型。
// 模板与自定义只是预填来源不同；`auth_ref` 只存引用，密钥本体经 `api/secrets/put` 直写本地。

import { el, textButton } from './dom.js'
import { errorBar, field, row } from './ui-parts.js'
import { CUSTOM_PROTOCOLS, defaultModelChoice, selectableTemplates } from './onboarding.js'

/** 渲染厂商表单到 `containerNode`；`options` = `{submitLabel, busyLabel, onSubmit}`。 */
export function renderProviderForm(ctx, containerNode, form, options) {
  const doc = ctx.doc
  if (form.mode === 'edit') {
    renderEditFields(ctx, containerNode, form, options)
    return
  }
  const isCustom = form.templateIdentity === '' || form.templateIdentity === 'custom'

  const templateSelect = el(doc, 'select', { class: 'settings-select' })
  templateSelect.appendChild(el(doc, 'option', { text: ctx.text('settings_custom'), attrs: { value: 'custom' } }))
  for (const template of selectableTemplates(form.templates)) {
    templateSelect.appendChild(el(doc, 'option', { text: template.identity, attrs: { value: template.identity } }))
  }
  templateSelect.value = isCustom ? 'custom' : form.templateIdentity
  templateSelect.addEventListener('change', () => {
    ctx.applyTemplate(form, templateSelect.value)
    ctx.render()
  })
  containerNode.appendChild(field(ctx, ctx.text('settings_vendor'), templateSelect))

  if (isCustom) {
    const protocolSelect = el(doc, 'select', { class: 'settings-select' })
    for (const protocol of CUSTOM_PROTOCOLS) {
      protocolSelect.appendChild(el(doc, 'option', { text: protocol, attrs: { value: protocol } }))
    }
    protocolSelect.value = form.protocol
    protocolSelect.addEventListener('change', () => {
      form.protocol = protocolSelect.value
    })
    containerNode.appendChild(field(ctx, ctx.text('settings_protocol'), protocolSelect))
  }

  const urlInput = el(doc, 'input', { class: 'settings-input', attrs: { type: 'text', value: form.base_url } })
  urlInput.addEventListener('input', () => {
    form.base_url = urlInput.value
  })
  containerNode.appendChild(field(ctx, ctx.text('settings_base_url'), urlInput))

  const authKind = el(doc, 'select', {
    class: 'settings-select',
    attrs: { 'aria-label': ctx.text('settings_auth_kind') },
  })
  for (const kind of ['env', 'local']) {
    authKind.appendChild(el(doc, 'option', { text: kind, attrs: { value: kind } }))
  }
  authKind.value = form.auth_kind
  authKind.addEventListener('change', () => {
    form.auth_kind = authKind.value
  })
  const authName = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'text', value: form.auth_name, 'aria-label': ctx.text('settings_auth_name') },
  })
  authName.addEventListener('input', () => {
    form.auth_name = authName.value
  })
  containerNode.appendChild(
    field(ctx, ctx.text('settings_auth_ref'), el(doc, 'div', { class: 'settings-row-value' }, [authKind, authName])),
  )

  const secretInput = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'password', value: form.secret_value, placeholder: ctx.text('settings_secret_placeholder') },
  })
  secretInput.addEventListener('input', () => {
    form.secret_value = secretInput.value
  })
  containerNode.appendChild(field(ctx, ctx.text('settings_secret_value'), secretInput))

  const fetchButton = textButton(
    doc,
    form.loading ? ctx.text('settings_fetching') : ctx.text('settings_fetch_models'),
    () => ctx.fetchModels(form),
    { disabled: form.loading },
  )
  containerNode.appendChild(row(ctx, ctx.text('settings_models_pick'), fetchButton))
  if (form.loading) fetchButton.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))

  const picks = el(doc, 'div', { class: 'settings-model-picks' })
  if (form.models.length === 0) {
    picks.appendChild(el(doc, 'div', { class: 'settings-muted', text: ctx.text('settings_empty') }))
  }
  for (const id of form.models) {
    const checkbox = el(doc, 'input', { attrs: { type: 'checkbox' } })
    checkbox.checked = form.selected.includes(id)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!form.selected.includes(id)) form.selected.push(id)
      } else {
        form.selected = form.selected.filter((item) => item !== id)
        if (form.model === id) form.model = defaultModelChoice(form.selected, '')
      }
      ctx.render()
    })
    picks.appendChild(el(doc, 'label', { class: 'settings-check' }, [checkbox, el(doc, 'span', { text: id })]))
  }
  containerNode.appendChild(picks)

  const modelSelect = el(doc, 'select', { class: 'settings-select' })
  for (const id of form.selected) {
    modelSelect.appendChild(el(doc, 'option', { text: id, attrs: { value: id } }))
  }
  modelSelect.value = form.model
  modelSelect.addEventListener('change', () => {
    form.model = modelSelect.value
  })
  containerNode.appendChild(field(ctx, ctx.text('settings_default_model'), modelSelect))

  if (form.error !== null) containerNode.appendChild(errorBar(ctx, form.error))

  const submit = textButton(doc, form.busy ? options.busyLabel : options.submitLabel, () => options.onSubmit(), {
    tone: 'accent',
    disabled: form.busy || form.selected.length === 0,
  })
  if (form.busy) submit.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  containerNode.appendChild(el(doc, 'div', { class: 'settings-guide-actions' }, [submit]))
}

/** 编辑模式：只改地址与密钥引用（模型 / 档案元数据原样保留），与引导页表单同形。 */
function renderEditFields(ctx, containerNode, form, options) {
  const doc = ctx.doc
  containerNode.appendChild(
    field(ctx, ctx.text('settings_edit_provider'), el(doc, 'span', { class: 'settings-list-meta', text: form.key })),
  )
  const urlInput = el(doc, 'input', { class: 'settings-input', attrs: { type: 'text', value: form.base_url } })
  urlInput.addEventListener('input', () => {
    form.base_url = urlInput.value
  })
  containerNode.appendChild(field(ctx, ctx.text('settings_base_url'), urlInput))

  const authKind = el(doc, 'select', {
    class: 'settings-select',
    attrs: { 'aria-label': ctx.text('settings_auth_kind') },
  })
  for (const kind of ['env', 'local']) {
    authKind.appendChild(el(doc, 'option', { text: kind, attrs: { value: kind } }))
  }
  authKind.value = form.auth_kind
  authKind.addEventListener('change', () => {
    form.auth_kind = authKind.value
  })
  const authName = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'text', value: form.auth_name, 'aria-label': ctx.text('settings_auth_name') },
  })
  authName.addEventListener('input', () => {
    form.auth_name = authName.value
  })
  containerNode.appendChild(
    field(ctx, ctx.text('settings_auth_ref'), el(doc, 'div', { class: 'settings-row-value' }, [authKind, authName])),
  )

  if (form.error !== null) containerNode.appendChild(errorBar(ctx, form.error))

  const submit = textButton(doc, form.busy ? options.busyLabel : options.submitLabel, () => options.onSubmit(), {
    tone: 'accent',
    disabled: form.busy,
  })
  if (form.busy) submit.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  const cancel = textButton(doc, ctx.text('settings_cancel'), () => options.onCancel?.())
  containerNode.appendChild(el(doc, 'div', { class: 'settings-guide-actions' }, [submit, cancel]))
}
