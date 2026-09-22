// 厂商表单（引导页与模型页共用）：选入口（模板 / 自定义）→ 地址 / 密钥 → 获取模型 → 勾选 → 完成。
// 密钥只填本体：引用名与取值面由代码内部固定（`local` + 自动名），不进界面。
// 模型由对话输入框选择，此处只勾选该厂商开放哪些模型，不设「默认模型」。

import { el, labeledButton, textButton } from './dom.js'
import { errorBar, field, row } from './ui-parts.js'
import { addModelIds, CUSTOM_PROTOCOLS, selectableTemplates } from './onboarding.js'

/** 新建厂商入口：模板与自定义两条并列入口，各自进对应表单（不塞进同一个下拉）。 */
export function renderProviderEntry(ctx, containerNode, templates, onPick) {
  const doc = ctx.doc
  const templateBtn = labeledButton(doc, 'plus', ctx.text('settings_add_provider'), () => onPick('template'), {
    class: 'settings-btn settings-add-btn',
    disabled: selectableTemplates(templates).length === 0,
  })
  const customBtn = labeledButton(doc, 'plus', ctx.text('settings_add_custom_provider'), () => onPick('custom'), {
    class: 'settings-btn settings-add-btn',
  })
  containerNode.appendChild(el(doc, 'div', { class: 'settings-add-row' }, [templateBtn, customBtn]))
}

/** 渲染厂商表单到 `containerNode`；`options` = `{submitLabel, busyLabel, onSubmit, onBack?, onCancel?}`。 */
export function renderProviderForm(ctx, containerNode, form, options) {
  const doc = ctx.doc
  if (form.mode === 'edit') {
    renderEditFields(ctx, containerNode, form, options)
    return
  }
  const isCustom = form.templateIdentity === 'custom'

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
  } else {
    const templateSelect = el(doc, 'select', { class: 'settings-select' })
    for (const template of selectableTemplates(form.templates)) {
      templateSelect.appendChild(el(doc, 'option', { text: template.identity, attrs: { value: template.identity } }))
    }
    templateSelect.value = form.templateIdentity
    templateSelect.addEventListener('change', () => {
      ctx.applyTemplate(form, templateSelect.value)
      ctx.render()
    })
    containerNode.appendChild(field(ctx, ctx.text('settings_vendor'), templateSelect))
  }

  const urlInput = el(doc, 'input', { class: 'settings-input', attrs: { type: 'text', value: form.base_url } })
  urlInput.addEventListener('input', () => {
    form.base_url = urlInput.value
  })
  containerNode.appendChild(field(ctx, ctx.text('settings_base_url'), urlInput))

  const secretInput = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'password', value: form.secret_value, placeholder: ctx.text('settings_secret_placeholder') },
  })
  secretInput.addEventListener('input', () => {
    form.secret_value = secretInput.value
  })
  containerNode.appendChild(field(ctx, ctx.text('settings_api_key'), secretInput))

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
      }
      ctx.render()
    })
    picks.appendChild(el(doc, 'label', { class: 'settings-check' }, [checkbox, el(doc, 'span', { text: id })]))
  }
  containerNode.appendChild(picks)

  const customModel = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'text', placeholder: ctx.text('settings_custom_model_placeholder') },
  })
  const addModel = textButton(doc, ctx.text('settings_add_model'), () => {
    if (addModelIds(form, customModel.value).length === 0) return
    customModel.value = ''
    ctx.render()
  })
  containerNode.appendChild(
    row(ctx, ctx.text('settings_custom_model'), el(doc, 'div', { class: 'settings-custom-model' }, [customModel, addModel])),
  )

  if (form.error !== null) containerNode.appendChild(errorBar(ctx, form.error))

  const actions = el(doc, 'div', { class: 'settings-guide-actions' })
  if (typeof options.onBack === 'function') {
    actions.appendChild(textButton(doc, ctx.text('settings_back'), () => options.onBack()))
  }
  const submit = textButton(doc, form.busy ? options.busyLabel : options.submitLabel, () => options.onSubmit(), {
    tone: 'accent',
    disabled: form.busy || form.selected.length === 0,
  })
  if (form.busy) submit.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  actions.appendChild(submit)
  containerNode.appendChild(actions)
}

/** 编辑模式：只改地址（模型 / 密钥 / 档案元数据原样保留）。 */
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

  if (form.error !== null) containerNode.appendChild(errorBar(ctx, form.error))

  const submit = textButton(doc, form.busy ? options.busyLabel : options.submitLabel, () => options.onSubmit(), {
    tone: 'accent',
    disabled: form.busy,
  })
  if (form.busy) submit.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  const cancel = textButton(doc, ctx.text('settings_cancel'), () => options.onCancel?.())
  containerNode.appendChild(el(doc, 'div', { class: 'settings-guide-actions' }, [submit, cancel]))
}
