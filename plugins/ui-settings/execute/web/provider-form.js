// 厂商表单（引导页与模型页共用）：选入口（模板 / 自定义）→ 地址 / 密钥 → 获取模型 → 勾选 → 完成。
// 密钥只填本体：引用名与取值面由代码内部固定（`local` + 自动名），不进界面。
// 模型由对话输入框选择，此处只勾选该厂商开放哪些模型，不设「默认模型」。
// 结构：连接组（protocol / url / key）+ 模型组（获取 → 勾选，手填自定义 id 收为次级入口），组间有发丝分隔。
// 模型组取模型按钮常驻组头右侧（空态即拉取入口，有模型后为刷新入口）；模型列表是常驻容器，
// 空态只是容器内的一句提示，拉取结果与手填 id 落同一处，不随空态换框。
// 交互：勾选与添加只重建列表内容，不重载整页（不丢焦点 / 滚动）；Enter 在地址 / 密钥上取模型、在自定义模型上添加。
// 文案克制：入口行卡只留名称与一句说明，说明性文字一律不进表单。

import { el, icon, iconButton, labeledButton, textButton } from './dom.js'
import { errorBar, field } from './ui-parts.js'
import { addModelIds, CUSTOM_PROTOCOLS, selectableTemplates, validateBaseUrl } from './onboarding.js'

/** 协议身份 → 界面可读名（下拉只显示可读名，写值仍用身份）。 */
const PROTOCOL_TEXT_KEYS = {
  'openai-chat': 'settings_protocol_openai_chat',
  'openai-responses': 'settings_protocol_openai_responses',
  'anthropic-messages': 'settings_protocol_anthropic_messages',
}

/** 新建厂商入口：模板与自定义两张通栏行卡，各自进对应表单（不塞进同一个下拉）。 */
export function renderProviderEntry(ctx, containerNode, templates, onPick) {
  containerNode.appendChild(
    el(ctx.doc, 'div', { class: 'settings-entry-list' }, [
      entryCard(ctx, 'sparkles', 'settings_add_provider', () => onPick('template'), {
        disabled: selectableTemplates(templates).length === 0,
      }),
      entryCard(ctx, 'pencil-line', 'settings_add_custom_provider', () => onPick('custom')),
    ]),
  )
}

/** 入口行卡：图标块 + 名称与一句说明 + 右侧箭头；整卡可点，悬停时图标块反色、箭头前移。 */
function entryCard(ctx, iconName, labelKey, onClick, options = {}) {
  const doc = ctx.doc
  const button = el(doc, 'button', { class: 'settings-entry', attrs: { type: 'button' } })
  if (options.disabled === true) button.disabled = true
  button.appendChild(el(doc, 'span', { class: 'settings-entry-icon' }, [icon(doc, iconName, 20)]))
  button.appendChild(
    el(doc, 'span', { class: 'settings-entry-main' }, [
      el(doc, 'span', { class: 'settings-entry-label', text: ctx.text(labelKey) }),
      el(doc, 'span', { class: 'settings-entry-hint', text: ctx.text(`${labelKey}_hint`) }),
    ]),
  )
  button.appendChild(el(doc, 'span', { class: 'settings-entry-chevron' }, [icon(doc, 'chevron-right', 16)]))
  button.addEventListener('click', onClick)
  return button
}

/** 下拉控件去壳：原生箭头读作浏览器默认件，改用 sprite 箭头（标签仍关联内层 select）。 */
function wrapSelect(ctx, select) {
  const doc = ctx.doc
  return el(doc, 'span', { class: 'settings-select-wrap' }, [
    select,
    el(doc, 'span', { class: 'settings-select-chevron', attrs: { 'aria-hidden': 'true' } }, [icon(doc, 'chevron-down', 16)]),
  ])
}

/** 渲染厂商表单到 `containerNode`；`options` = `{submitLabel, busyLabel, primaryTone?, onSubmit, onBack?, onCancel?}`。 */
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
    connection.appendChild(
      field(ctx, ctx.text('settings_protocol'), protocolSelect, { frame: (node) => wrapSelect(ctx, node) }),
    )
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
    connection.appendChild(
      field(ctx, ctx.text('settings_vendor'), templateSelect, { frame: (node) => wrapSelect(ctx, node) }),
    )
  }

  const urlError = el(doc, 'div', { class: 'settings-field-error', attrs: { hidden: true } })
  const urlInput = el(doc, 'input', {
    class: 'settings-input settings-mono',
    attrs: { type: 'text', value: form.base_url, spellcheck: 'false', autocomplete: 'off', inputmode: 'url' },
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
    class: 'settings-input settings-mono',
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
  // 取模型按钮常驻组头右侧：空态是拉取入口，有模型后是刷新入口，不再随空态在页内换位。
  // 模型列表是常驻容器：空态只是容器内的一句提示，拉取结果与手动添加的 id 都落在同一处。
  const fetchLabel = () => (form.loading ? ctx.text('settings_fetching') : ctx.text('settings_fetch_models'))
  const fetchButton = labeledButton(doc, 'rotate-ccw', fetchLabel(), () => ctx.fetchModels(form), {
    class: 'settings-btn settings-models-fetch',
    disabled: form.loading,
  })
  if (form.loading) fetchButton.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))

  const models = el(doc, 'div', { class: 'settings-form-fields settings-model-group' })

  const bulkBar = el(doc, 'div', { class: 'settings-models-bar' })
  const countNode = el(doc, 'span', { class: 'settings-models-count' })
  bulkBar.appendChild(countNode)

  // 筛选收成图标：默认只露搜索图标，点开才出现窄输入框；它排在批量动作之后，右端与列表容器右侧对齐。
  let filter = ''
  const filterInput = el(doc, 'input', {
    class: 'settings-input settings-model-filter-input',
    attrs: {
      type: 'text',
      placeholder: ctx.text('settings_model_filter'),
      'aria-label': ctx.text('settings_model_filter'),
      spellcheck: 'false',
      autocomplete: 'off',
    },
  })
  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase()
    rebuildPicks()
  })
  filterInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    filterInput.value = ''
    filter = ''
    setFilterOpen(false)
    rebuildPicks()
  })
  filterInput.addEventListener('blur', () => {
    if (filterInput.value.trim().length === 0) setFilterOpen(false)
  })
  const filterToggle = iconButton(doc, 'search', ctx.text('settings_model_filter'), () => setFilterOpen(true))
  const filterWrap = el(doc, 'span', { class: 'settings-model-filter' }, [filterToggle, filterInput])

  bulkBar.appendChild(
    el(doc, 'span', { class: 'settings-models-actions' }, [
      textButton(doc, ctx.text('settings_models_select_all'), () => selectAllVisible()),
      textButton(doc, ctx.text('settings_models_clear'), () => clearSelection()),
      filterWrap,
    ]),
  )
  models.appendChild(bulkBar)

  /** 筛选框开合：点图标展开并聚焦；空值失焦或 Esc 收回为图标。 */
  function setFilterOpen(open) {
    filterToggle.hidden = open
    filterInput.hidden = !open
    if (open) filterInput.focus()
  }
  setFilterOpen(false)

  // 两级容器：外框 `settings-model-frame` 定高限并滚，内层 `settings-model-list` 只承载行；
  // 两者都只在建表时创建一次，之后只重建行，不换容器。
  const picksFrame = el(doc, 'div', { class: 'settings-model-frame' })
  const picks = el(doc, 'div', {
    class: 'settings-model-list',
    attrs: { role: 'group', 'aria-label': ctx.text('settings_models_pick') },
  })
  picksFrame.appendChild(picks)
  models.appendChild(picksFrame)

  const customModel = el(doc, 'input', {
    class: 'settings-input settings-mono',
    attrs: {
      type: 'text',
      placeholder: ctx.text('settings_custom_model_placeholder'),
      spellcheck: 'false',
      autocomplete: 'off',
    },
  })
  customModel.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    addCustomModels()
  })
  const addModel = textButton(doc, ctx.text('settings_add_model'), () => addCustomModels())
  const customRow = el(doc, 'div', { class: 'settings-custom-model' }, [customModel, addModel])
  const customToggle = labeledButton(doc, 'plus', ctx.text('settings_custom_model_more'), () => setCustomOpen(true, true), {
    class: 'settings-btn settings-subentry-btn',
  })
  models.appendChild(el(doc, 'div', { class: 'settings-custom-entry' }, [customToggle, customRow]))
  setCustomOpen(form.customOpen === true)

  /** 手填自定义 id 是次级入口：默认收起，点开后只留输入行并聚焦。 */
  function setCustomOpen(open, focus = false) {
    form.customOpen = open
    customToggle.hidden = open
    customRow.hidden = !open
    if (open && focus) customModel.focus()
  }

  containerNode.appendChild(formSection(ctx, 'settings_section_models', [models], { action: fetchButton }))

  if (form.error !== null) containerNode.appendChild(errorBar(ctx, form.error))

  const actions = el(doc, 'div', { class: 'settings-guide-actions' })
  if (typeof options.onBack === 'function') {
    const back = textButton(doc, ctx.text('settings_back'), () => options.onBack())
    back.classList.add('settings-action-lead')
    actions.appendChild(back)
  }
  const submit = textButton(doc, form.busy ? options.busyLabel : options.submitLabel, () => options.onSubmit(), {
    tone: options.primaryTone ?? 'accent',
    disabled: form.busy || form.selected.length === 0,
  })
  if (form.busy) submit.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  actions.appendChild(submit)
  containerNode.appendChild(actions)

  rebuildPicks()

  /** 当前筛选下的可见模型 id。 */
  function visibleModels() {
    if (filter.length === 0) return form.models
    return form.models.filter((id) => id.toLowerCase().includes(filter))
  }

  /**
   * 重建列表内容（获取模型 / 添加自定义 / 筛选后调用），不动其它字段；空列表渲染容器内的空态提示。
   * `freshIds` 为本次新增的 id：只给这些行加入场动画，让「追加」看得出来，筛选 / 全选重建不重复播。
   */
  function rebuildPicks(freshIds) {
    picks.replaceChildren()
    if (form.models.length === 0) {
      picks.appendChild(el(doc, 'div', { class: 'settings-model-empty', text: ctx.text('settings_empty_models') }))
      return
    }
    const visible = visibleModels()
    if (visible.length === 0) {
      picks.appendChild(el(doc, 'div', { class: 'settings-model-empty', text: ctx.text('settings_empty_filter') }))
      return
    }
    for (const id of visible) {
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
      const row = el(doc, 'label', { class: 'settings-check' }, [
        checkbox,
        el(doc, 'span', { class: 'settings-check-main', text: id }),
      ])
      if (freshIds !== undefined && freshIds.has(id)) row.classList.add('settings-check-in')
      picks.appendChild(row)
    }
  }

  /** 勾选态 → 计数 / 批量动作与筛选可见性 / 主按钮可用性（就地同步，不重渲染）。 */
  function sync() {
    const empty = form.models.length === 0
    const ready = form.selected.length > 0
    submit.disabled = form.busy || !ready
    countNode.textContent = ctx.text('settings_models_selected', { count: form.selected.length, total: form.models.length })
    // 只隐去不撤位：加第一个模型时这一条不改变占位，外框不被往下挤（看着像追加而非替换）。
    bulkBar.dataset.empty = empty ? 'true' : 'false'
    filterWrap.hidden = empty || form.models.length <= 8
  }

  /** 全选当前筛选下的可见模型。 */
  function selectAllVisible() {
    const next = new Set(form.selected)
    for (const id of visibleModels()) next.add(id)
    form.selected = [...next].sort()
    rebuildPicks()
    sync()
  }

  function clearSelection() {
    form.selected = []
    rebuildPicks()
    sync()
  }

  /** 追加自定义模型 id：只重建勾选区并回焦输入框，避免整页重渲染丢焦点。 */
  function addCustomModels() {
    const added = addModelIds(form, customModel.value)
    if (added.length === 0) return
    customModel.value = ''
    rebuildPicks(new Set(added))
    sync()
    customModel.focus()
  }

  sync()
}

/** 编辑模式：只改地址（模型 / 密钥 / 档案元数据原样保留）。 */
function renderEditFields(ctx, containerNode, form, options) {
  const doc = ctx.doc
  const fields = el(doc, 'div', { class: 'settings-form-fields' })
  fields.appendChild(
    field(ctx, ctx.text('settings_edit_provider'), el(doc, 'span', { class: 'settings-list-meta', text: form.key })),
  )
  const urlInput = el(doc, 'input', {
    class: 'settings-input settings-mono',
    attrs: { type: 'text', value: form.base_url, spellcheck: 'false', autocomplete: 'off', inputmode: 'url' },
  })
  urlInput.addEventListener('input', () => {
    form.base_url = urlInput.value
  })
  fields.appendChild(field(ctx, ctx.text('settings_base_url'), urlInput, { required: true }))
  containerNode.appendChild(fields)

  if (form.error !== null) containerNode.appendChild(errorBar(ctx, form.error))

  const submit = textButton(doc, form.busy ? options.busyLabel : options.submitLabel, () => options.onSubmit(), {
    tone: options.primaryTone ?? 'accent',
    disabled: form.busy,
  })
  if (form.busy) submit.appendChild(el(doc, 'span', { class: 'settings-breathe-ring' }))
  const cancel = textButton(doc, ctx.text('settings_cancel'), () => options.onCancel?.())
  containerNode.appendChild(el(doc, 'div', { class: 'settings-guide-actions' }, [submit, cancel]))
}

/** 表单分组：组名 + 可选右侧动作 + 子节点（组间由样式加发丝分隔线）。 */
function formSection(ctx, titleKey, children, options = {}) {
  const doc = ctx.doc
  const node = el(doc, 'div', { class: 'settings-form-section' })
  const head = el(doc, 'div', { class: 'settings-form-section-head' }, [
    el(doc, 'div', { class: 'settings-form-section-title', text: ctx.text(titleKey) }),
  ])
  if (options.action !== undefined && options.action !== null) {
    head.appendChild(el(doc, 'div', { class: 'settings-form-section-action' }, [options.action]))
  }
  node.appendChild(head)
  for (const child of children) node.appendChild(child)
  return node
}
