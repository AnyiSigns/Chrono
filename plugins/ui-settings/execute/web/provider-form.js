// 厂商表单（引导页与模型页共用）：选入口（模板 / 自定义）→ 地址 / 密钥 → 获取模型 → 勾选 → 完成。
// 密钥只填本体：引用名与取值面由代码内部固定（`local` + 自动名），不进界面。
// 模型由对话输入框选择，此处只勾选该厂商开放哪些模型，不设「默认模型」。
// 结构：连接组（protocol / url / key）+ 模型组（获取 → 勾选，手填自定义 id 收为次级入口），组间有分隔。
// 交互：勾选与添加只重建勾选区，不整页重渲染（不丢焦点 / 滚动）；Enter 在地址 / 密钥上取模型、在自定义模型上添加。

import { el, icon, labeledButton, textButton } from './dom.js'
import { emptyState, errorBar, field, row } from './ui-parts.js'
import { addModelIds, CUSTOM_PROTOCOLS, selectableTemplates, validateBaseUrl } from './onboarding.js'

/** 协议身份 → 界面可读名（下拉只显示可读名，写值仍用身份）。 */
const PROTOCOL_TEXT_KEYS = {
  'openai-chat': 'settings_protocol_openai_chat',
  'openai-responses': 'settings_protocol_openai_responses',
  'anthropic-messages': 'settings_protocol_anthropic_messages',
}

/** 新建厂商入口：模板与自定义两张并列卡片，各自进对应表单（不塞进同一个下拉）。 */
export function renderProviderEntry(ctx, containerNode, templates, onPick) {
  containerNode.appendChild(
    el(ctx.doc, 'div', { class: 'settings-entry-list' }, [
      entryCard(ctx, 'sparkles', 'settings_add_provider', 'settings_add_provider_hint', () => onPick('template'), {
        disabled: selectableTemplates(templates).length === 0,
      }),
      entryCard(ctx, 'pencil-line', 'settings_add_custom_provider', 'settings_add_custom_provider_hint', () => onPick('custom')),
    ]),
  )
}

/** 入口卡片：图标 + 名称 + 一行说明 + 右箭头；整卡可点。 */
function entryCard(ctx, iconName, labelKey, hintKey, onClick, options = {}) {
  const doc = ctx.doc
  const button = el(doc, 'button', { class: 'settings-entry', attrs: { type: 'button' } })
  if (options.disabled === true) button.disabled = true
  button.appendChild(el(doc, 'span', { class: 'settings-entry-icon' }, [icon(doc, iconName, 18)]))
  button.appendChild(
    el(doc, 'span', { class: 'settings-entry-body' }, [
      el(doc, 'span', { class: 'settings-entry-label', text: ctx.text(labelKey) }),
      el(doc, 'span', { class: 'settings-entry-hint', text: ctx.text(hintKey) }),
    ]),
  )
  button.appendChild(el(doc, 'span', { class: 'settings-entry-chevron' }, [icon(doc, 'chevron-right', 16)]))
  button.addEventListener('click', onClick)
  return button
}

/** 渲染厂商表单到 `containerNode`；`options` = `{submitLabel, busyLabel, onSubmit, onBack?, onCancel?}`。 */
export function renderProviderForm(ctx, containerNode, form, options) {
  const doc = ctx.doc
  if (form.mode === 'edit') {
    renderEditFields(ctx, containerNode, form, options)
    return
  }
  const isCustom = form.templateIdentity === 'custom'

  // ---- 连接组 ----
  const connection = el(doc, 'div', { class: 'settings-form-fields' })
  if (isCustom) {
    const protocolSelect = el(doc, 'select', { class: 'settings-select' })
    for (const protocol of CUSTOM_PROTOCOLS) {
      const textKey = PROTOCOL_TEXT_KEYS[protocol]
      protocolSelect.appendChild(
        el(doc, 'option', { text: textKey === undefined ? protocol : ctx.text(textKey), attrs: { value: protocol } }),
      )
    }
    protocolSelect.value = form.protocol
    protocolSelect.addEventListener('change', () => {
      form.protocol = protocolSelect.value
    })
    connection.appendChild(field(ctx, ctx.text('settings_protocol'), protocolSelect))
  } else {
    const templateSelect = el(doc, 'select', { class: 'settings-select' })
    for (const template of selectableTemplates(form.templates)) {
      const label = template.key.length > 0 ? template.key : template.identity
      templateSelect.appendChild(el(doc, 'option', { text: label, attrs: { value: template.identity } }))
    }
    templateSelect.value = form.templateIdentity
    templateSelect.addEventListener('change', () => {
      ctx.applyTemplate(form, templateSelect.value)
      ctx.render()
    })
    connection.appendChild(field(ctx, ctx.text('settings_vendor'), templateSelect))
  }

  const urlError = el(doc, 'div', { class: 'settings-field-error', attrs: { hidden: true } })
  const urlInput = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'text', value: form.base_url, spellcheck: 'false', autocomplete: 'off' },
  })
  urlInput.addEventListener('input', () => {
    form.base_url = urlInput.value
    if (!urlError.hidden && validateBaseUrl(form.base_url) === null) showUrlError(null)
  })
  urlInput.addEventListener('blur', () => {
    showUrlError(form.base_url.length === 0 ? null : validateBaseUrl(form.base_url))
  })
  urlInput.addEventListener('keydown', onEnterFetch)
  const urlField = field(ctx, ctx.text('settings_base_url'), urlInput, { required: true })
  urlField.appendChild(urlError)
  connection.appendChild(urlField)

  const secretInput = el(doc, 'input', {
    class: 'settings-input',
    attrs: {
      type: 'password',
      value: form.secret_value,
      placeholder: ctx.text('settings_secret_placeholder'),
      spellcheck: 'false',
      autocomplete: 'off',
    },
  })
  secretInput.addEventListener('input', () => {
    form.secret_value = secretInput.value
  })
  secretInput.addEventListener('keydown', onEnterFetch)
  connection.appendChild(field(ctx, ctx.text('settings_api_key'), secretInput))

  containerNode.appendChild(formSection(ctx, 'settings_section_connection', [connection]))

  /** 地址行内错误：只标错误态与 aria，不整页重渲染。 */
  function showUrlError(code) {
    urlError.textContent = code === null ? '' : ctx.text(code)
    urlError.hidden = code === null
    if (code === null) urlInput.removeAttribute('aria-invalid')
    else urlInput.setAttribute('aria-invalid', 'true')
  }

  /** Enter 在地址 / 密钥上 = 取模型（表单里自然的下一步）。 */
  function onEnterFetch(event) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (!form.loading) ctx.fetchModels(form)
  }

  // ---- 模型组 ----
  const models = el(doc, 'div', { class: 'settings-form-fields' })
  const fetchButton = labeledButton(
    doc,
    'rotate-ccw',
    form.loading ? ctx.text('settings_fetching') : ctx.text('settings_fetch_models'),
    () => ctx.fetchModels(form),
    { disabled: form.loading },
  )
  if (form.loading) fetchButton.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  models.appendChild(row(ctx, ctx.text('settings_models_pick'), fetchButton))

  const picks = el(doc, 'div', {
    class: 'settings-model-picks',
    attrs: { role: 'group', 'aria-label': ctx.text('settings_models_pick') },
  })
  models.appendChild(picks)

  const needModel = el(doc, 'div', { class: 'settings-inline-hint', text: ctx.text('settings_need_model') })
  needModel.hidden = form.selected.length > 0
  models.appendChild(needModel)

  const customModel = el(doc, 'input', {
    class: 'settings-input',
    attrs: {
      type: 'text',
      placeholder: ctx.text('settings_custom_model_placeholder'),
      spellcheck: 'false',
      autocomplete: 'off',
    },
  })
  const addModel = labeledButton(doc, 'plus', ctx.text('settings_add_model'), () => addCustomModels())
  customModel.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    addCustomModels()
  })
  const customRow = row(
    ctx,
    ctx.text('settings_custom_model'),
    el(doc, 'div', { class: 'settings-custom-model' }, [customModel, addModel]),
  )
  const customToggle = labeledButton(doc, 'plus', ctx.text('settings_custom_model_more'), () => setCustomOpen(true), {
    class: 'settings-btn settings-subentry-btn',
  })
  models.appendChild(customToggle)
  models.appendChild(customRow)
  setCustomOpen(form.customOpen === true)

  /** 手填自定义 id 是次级入口：默认收起，点开后只留输入行。 */
  function setCustomOpen(open) {
    form.customOpen = open
    customToggle.hidden = open
    customRow.hidden = !open
  }

  containerNode.appendChild(formSection(ctx, 'settings_section_models', [models]))

  if (form.error !== null) containerNode.appendChild(errorBar(ctx, form.error))

  const actions = el(doc, 'div', { class: 'settings-guide-actions' })
  if (typeof options.onBack === 'function') {
    const back = textButton(doc, ctx.text('settings_back'), () => options.onBack())
    back.classList.add('settings-action-lead')
    actions.appendChild(back)
  }
  const submit = textButton(doc, form.busy ? options.busyLabel : options.submitLabel, () => options.onSubmit(), {
    tone: 'accent',
    disabled: form.busy || form.selected.length === 0,
  })
  if (form.busy) submit.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  actions.appendChild(submit)
  containerNode.appendChild(actions)

  rebuildPicks()

  /** 重建勾选区（获取模型 / 添加自定义后调用），不动其它字段。 */
  function rebuildPicks() {
    picks.replaceChildren()
    if (form.models.length === 0) {
      picks.appendChild(emptyState(ctx, 'settings_empty_models', 'settings_empty_models_hint'))
      return
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
        sync()
      })
      picks.appendChild(el(doc, 'label', { class: 'settings-check' }, [checkbox, el(doc, 'span', { text: id })]))
    }
  }

  /** 勾选态 → 主按钮可用性 / 缺项提示（就地同步，不重渲染）。 */
  function sync() {
    const ready = form.selected.length > 0
    submit.disabled = form.busy || !ready
    needModel.hidden = ready
  }

  /** 追加自定义模型 id：只重建勾选区并回焦输入框，避免整页重渲染丢焦点。 */
  function addCustomModels() {
    if (addModelIds(form, customModel.value).length === 0) return
    customModel.value = ''
    rebuildPicks()
    sync()
    customModel.focus()
  }
}

/** 编辑模式：只改地址（模型 / 密钥 / 档案元数据原样保留）。 */
function renderEditFields(ctx, containerNode, form, options) {
  const doc = ctx.doc
  const fields = el(doc, 'div', { class: 'settings-form-fields' })
  fields.appendChild(
    field(ctx, ctx.text('settings_edit_provider'), el(doc, 'span', { class: 'settings-list-meta', text: form.key })),
  )
  const urlInput = el(doc, 'input', {
    class: 'settings-input',
    attrs: { type: 'text', value: form.base_url, spellcheck: 'false', autocomplete: 'off' },
  })
  urlInput.addEventListener('input', () => {
    form.base_url = urlInput.value
  })
  fields.appendChild(field(ctx, ctx.text('settings_base_url'), urlInput, { required: true }))
  containerNode.appendChild(fields)

  if (form.error !== null) containerNode.appendChild(errorBar(ctx, form.error))

  const submit = textButton(doc, form.busy ? options.busyLabel : options.submitLabel, () => options.onSubmit(), {
    tone: 'accent',
    disabled: form.busy,
  })
  if (form.busy) submit.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  const cancel = textButton(doc, ctx.text('settings_cancel'), () => options.onCancel?.())
  containerNode.appendChild(el(doc, 'div', { class: 'settings-guide-actions' }, [submit, cancel]))
}

/** 表单分组：组名 + 子节点（组间由样式加分隔线）。 */
function formSection(ctx, titleKey, children) {
  const node = el(ctx.doc, 'div', { class: 'settings-form-section' })
  node.appendChild(el(ctx.doc, 'div', { class: 'settings-form-section-title', text: ctx.text(titleKey) }))
  for (const child of children) node.appendChild(child)
  return node
}
