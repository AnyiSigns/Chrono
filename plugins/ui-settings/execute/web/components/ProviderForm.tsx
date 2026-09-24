// 厂商表单（引导页与模型页共用）：选入口（模板 / 自定义）→ 地址 / 密钥 → 获取模型 → 勾选 → 完成。
// 密钥只填本体：引用名与取值面由代码内部固定（`local` + 自动名），不进界面。
// 模型由对话输入框选择，此处只勾选该厂商开放哪些模型，不设「默认模型」。
// 原 `provider-form.js` 的 React 替代：吃 `form` 视图模型，动作经 vc。

import { useState } from 'react'
import { Field, Icon, LabeledButton, TextButton, useVc } from './ui.tsx'
import { addModelIds, CUSTOM_PROTOCOLS, selectableTemplates, validateBaseUrl } from '../onboarding.ts'

/** 协议身份 → 界面可读名（下拉只显示可读名，写值仍用身份）。 */
const PROTOCOL_TEXT_KEYS: { [key: string]: string } = {
  'openai-chat': 'settings_protocol_openai_chat',
  'openai-responses': 'settings_protocol_openai_responses',
  'anthropic-messages': 'settings_protocol_anthropic_messages',
}

/** 新建厂商入口：模板与自定义两张通栏行卡。 */
export function ProviderEntry(props: { templates: any[]; onPick: (entry: string) => void }) {
  const vc = useVc()
  const entryCard = (iconName: string, labelKey: string, onClick: () => void, disabled: boolean) => (
    <button type="button" className="settings-entry" disabled={disabled} onClick={onClick}>
      <span className="settings-entry-icon">
        <Icon name={iconName} size={20} />
      </span>
      <span className="settings-entry-main">
        <span className="settings-entry-label">{vc.text(labelKey)}</span>
        <span className="settings-entry-hint">{vc.text(`${labelKey}_hint`)}</span>
      </span>
      <span className="settings-entry-chevron">
        <Icon name="chevron-right" size={16} />
      </span>
    </button>
  )
  return (
    <div className="settings-entry-list">
      {entryCard('sparkles', 'settings_add_provider', () => props.onPick('template'), selectableTemplates(props.templates).length === 0)}
      {entryCard('pencil-line', 'settings_add_custom_provider', () => props.onPick('custom'), false)}
    </div>
  )
}

/** 下拉控件去壳：改用 sprite 箭头。 */
function SelectWrap(props: { children: any }) {
  return (
    <span className="settings-select-wrap">
      {props.children}
      <span className="settings-select-chevron" aria-hidden="true">
        <Icon name="chevron-down" size={16} />
      </span>
    </span>
  )
}

/** 渲染厂商表单；`options` = `{submitLabel, busyLabel, primaryTone?, onSubmit, onBack?, onCancel?}`。 */
export function ProviderForm(props: { form: any; options: any }) {
  const vc = useVc()
  const form = props.form
  const options = props.options
  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')

  if (form.mode === 'edit') {
    return (
      <>
        <div className="settings-form-fields">
          <Field label={vc.text('settings_vendor')} labelable={false}>
            <span className="settings-list-meta">{form.key}</span>
          </Field>
          <Field label={vc.text('settings_base_url')} required>
            <input
              className="settings-input settings-mono"
              type="text"
              value={form.base_url}
              spellCheck={false}
              autoComplete="off"
              inputMode="url"
              onChange={(event) => {
                form.base_url = event.target.value
                vc.render()
              }}
            />
          </Field>
        </div>
        {form.error !== null ? <ErrorBarInline code={form.error.code} /> : null}
        <div className="settings-guide-actions">
          <TextButton
            label={form.busy ? options.busyLabel : options.submitLabel}
            tone={options.primaryTone ?? 'accent'}
            disabled={form.busy}
            onClick={() => options.onSubmit()}
          >
            {form.busy ? <span className="settings-breathe-ring" /> : null}
          </TextButton>
          <TextButton label={vc.text('settings_cancel')} onClick={() => options.onCancel?.()} />
        </div>
      </>
    )
  }

  const isCustom = form.templateIdentity === 'custom'
  const visibleModels = filter.length === 0 ? form.models : form.models.filter((id: string) => id.toLowerCase().includes(filter))
  const empty = form.models.length === 0
  const fetchLabel = form.loading ? vc.text('settings_fetching') : vc.text('settings_fetch_models')

  const onEnterFetch = (event: any) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (!form.loading) vc.fetchModels(form)
  }

  const addCustom = () => {
    const added = addModelIds(form, customText)
    if (added.length === 0) return
    setCustomText('')
    vc.render()
  }

  const showUrlError = (code: string | null) => {
    setUrlError(code)
  }

  return (
    <>
      <div className="settings-form-section">
        <div className="settings-form-section-head">
          <div className="settings-form-section-title">{vc.text('settings_section_connection')}</div>
        </div>
        <div className="settings-form-fields">
          {isCustom ? (
            <Field label={vc.text('settings_protocol')} labelable={false}>
              <SelectWrap>
                <select
                  className="settings-select"
                  value={form.protocol}
                  aria-label={vc.text('settings_protocol')}
                  onChange={(event) => {
                    form.protocol = event.target.value
                    vc.render()
                  }}
                >
                  {CUSTOM_PROTOCOLS.map((protocol) => (
                    <option key={protocol} value={protocol}>
                      {vc.text(PROTOCOL_TEXT_KEYS[protocol] ?? protocol)}
                    </option>
                  ))}
                </select>
              </SelectWrap>
            </Field>
          ) : (
            <Field label={vc.text('settings_vendor')} labelable={false}>
              <SelectWrap>
                <select
                  className="settings-select"
                  value={form.templateIdentity}
                  aria-label={vc.text('settings_vendor')}
                  onChange={(event) => {
                    vc.applyTemplate(form, event.target.value)
                    vc.render()
                  }}
                >
                  {selectableTemplates(form.templates).map((template: any) => (
                    <option key={template.identity} value={template.identity}>
                      {template.key.length > 0 ? template.key : template.identity}
                    </option>
                  ))}
                </select>
              </SelectWrap>
            </Field>
          )}
          <Field
            label={vc.text('settings_base_url')}
            required
            error={urlError !== null ? <div className="settings-field-error">{vc.text(urlError)}</div> : null}
          >
            <input
              className="settings-input settings-mono"
              type="text"
              value={form.base_url}
              spellCheck={false}
              autoComplete="off"
              inputMode="url"
              aria-invalid={urlError !== null ? 'true' : undefined}
              onChange={(event) => {
                form.base_url = event.target.value
                if (urlError !== null && validateBaseUrl(form.base_url) === null) setUrlError(null)
                vc.render()
              }}
              onBlur={() => showUrlError(form.base_url.length === 0 ? null : validateBaseUrl(form.base_url))}
              onKeyDown={onEnterFetch}
            />
          </Field>
          <Field label={vc.text('settings_api_key')}>
            <input
              className="settings-input settings-mono"
              type="password"
              value={form.secret_value}
              placeholder={vc.text('settings_secret_placeholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                form.secret_value = event.target.value
                vc.render()
              }}
              onKeyDown={onEnterFetch}
            />
          </Field>
        </div>
      </div>

      <div className="settings-form-section">
        <div className="settings-form-section-head">
          <div className="settings-form-section-title">{vc.text('settings_section_models')}</div>
          <div className="settings-form-section-action">
            <LabeledButton
              icon="rotate-ccw"
              label={fetchLabel}
              className="settings-btn settings-models-fetch"
              disabled={form.loading}
              onClick={() => vc.fetchModels(form)}
            >
              {form.loading ? <span className="settings-breathe-ring" /> : null}
            </LabeledButton>
          </div>
        </div>
        <div className="settings-form-fields settings-model-group">
          <div className="settings-models-bar" data-empty={empty ? 'true' : 'false'}>
            <span className="settings-models-count">
              {vc.text('settings_models_selected', { count: form.selected.length, total: form.models.length })}
            </span>
            <span className="settings-models-actions">
              <TextButton
                label={vc.text('settings_models_select_all')}
                onClick={() => {
                  const next = new Set<string>(form.selected)
                  for (const id of visibleModels) next.add(id)
                  form.selected = [...next].sort()
                  vc.render()
                }}
              />
              <TextButton
                label={vc.text('settings_models_clear')}
                onClick={() => {
                  form.selected = []
                  vc.render()
                }}
              />
              {!empty && form.models.length > 8 ? (
                <span className="settings-model-filter">
                  {!filterOpen ? (
                    <button type="button" className="settings-iconbtn" aria-label={vc.text('settings_model_filter')} title={vc.text('settings_model_filter')} onClick={() => setFilterOpen(true)}>
                      <Icon name="search" size={16} label={vc.text('settings_model_filter')} />
                    </button>
                  ) : (
                    <input
                      className="settings-input settings-model-filter-input"
                      type="text"
                      autoFocus
                      placeholder={vc.text('settings_model_filter')}
                      aria-label={vc.text('settings_model_filter')}
                      spellCheck={false}
                      autoComplete="off"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value.trim().toLowerCase())}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        event.preventDefault()
                        setFilter('')
                        setFilterOpen(false)
                      }}
                      onBlur={(event) => {
                        if (event.target.value.trim().length === 0) setFilterOpen(false)
                      }}
                    />
                  )}
                </span>
              ) : null}
            </span>
          </div>
          <div className="settings-model-frame">
            <div className="settings-model-list" role="group" aria-label={vc.text('settings_models_pick')}>
              {form.models.length === 0 ? (
                <div className="settings-model-empty">{vc.text('settings_empty_models')}</div>
              ) : visibleModels.length === 0 ? (
                <div className="settings-model-empty">{vc.text('settings_empty_filter')}</div>
              ) : (
                visibleModels.map((id: string) => (
                  <label className="settings-check" key={id}>
                    <input
                      type="checkbox"
                      checked={form.selected.includes(id)}
                      onChange={(event) => {
                        if (event.target.checked) {
                          if (!form.selected.includes(id)) form.selected.push(id)
                        } else {
                          form.selected = form.selected.filter((item: string) => item !== id)
                        }
                        vc.render()
                      }}
                    />
                    <span className="settings-check-main">{id}</span>
                  </label>
                ))
              )}
            </div>
          </div>
          <div className="settings-custom-entry">
            {!form.customOpen ? (
              <button
                type="button"
                className="settings-btn settings-subentry-btn"
                onClick={() => {
                  form.customOpen = true
                  vc.render()
                }}
              >
                <Icon name="plus" size={16} />
                {vc.text('settings_custom_model_more')}
              </button>
            ) : (
              <div className="settings-custom-model">
                <input
                  className="settings-input settings-mono"
                  type="text"
                  autoFocus
                  placeholder={vc.text('settings_custom_model_placeholder')}
                  spellCheck={false}
                  autoComplete="off"
                  value={customText}
                  onChange={(event) => setCustomText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    addCustom()
                  }}
                />
                <TextButton label={vc.text('settings_add_model')} onClick={addCustom} />
              </div>
            )}
          </div>
        </div>
      </div>

      {form.error !== null ? <ErrorBarInline code={form.error.code} /> : null}

      <div className="settings-guide-actions">
        {typeof options.onBack === 'function' ? (
          <span className="settings-action-lead">
            <TextButton label={vc.text('settings_back')} onClick={() => options.onBack()} />
          </span>
        ) : null}
        <TextButton
          label={form.busy ? options.busyLabel : options.submitLabel}
          tone={options.primaryTone ?? 'accent'}
          disabled={form.busy || form.selected.length === 0}
          onClick={() => options.onSubmit()}
        >
          {form.busy ? <span className="settings-breathe-ring" /> : null}
        </TextButton>
      </div>
    </>
  )
}

/** 行内错误条（不依赖 Section 上下文）。 */
function ErrorBarInline(props: { code: string }) {
  const vc = useVc()
  return (
    <div className="settings-error" role="alert">
      <Icon name="alert-circle" size={16} />
      <span>{vc.text(props.code)}</span>
    </div>
  )
}
