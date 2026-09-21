// `ui-settings` 浏览器视图层新增纯函数测试（node --test）：
// 厂商模板归一（model.vendors 结果 / 身份投影）、表单校验共用件、表单预填 / 回填、文案兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  applyTemplate,
  CUSTOM_TEMPLATE_IDENTITY,
  defaultOnboarding,
  formToValue,
  onboardingFromEntry,
  selectableTemplates,
  validateAuthRef,
  validateBaseUrl,
  validateProbe,
  vendorTemplates,
  vendorTemplatesFromResult,
} from '../execute/web/onboarding.js'
import { listText, splitList } from '../execute/web/settings-model.js'
import { lookupMessage, parseMessages, UI_TEXT } from '../execute/web/messages.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHARED_MESSAGES = resolve(HERE, '..', '..', 'ui-shell', 'execute', 'web', 'messages.v1.json')

/** 壳的共享文案表（单一文案来源）。 */
function sharedTable() {
  return parseMessages(readFileSync(SHARED_MESSAGES, 'utf8'))
}

test('model.vendors 结果归一为厂商模板（与身份投影同形）', () => {
  const templates = vendorTemplatesFromResult({
    ok: true,
    vendors: [
      { identity: 'vendor-deepseek', default_base_url: 'https://api.deepseek.com/v1', default_auth_ref_name: 'DEEPSEEK_API_KEY', default_reasoning: ['low', 'high'] },
      { identity: 'vendor-custom' },
      { identity: 42 },
    ],
  })
  assert.deepEqual(templates.map((item) => item.identity), ['vendor-custom', 'vendor-deepseek'])
  assert.equal(templates[1].key, 'deepseek')
  assert.equal(templates[1].default_base_url, 'https://api.deepseek.com/v1')
  assert.deepEqual(templates[1].default_reasoning, ['low', 'high'])
  assert.deepEqual(vendorTemplatesFromResult({ ok: false }), [])
  assert.deepEqual(vendorTemplatesFromResult(null), [])
})

test('可选模板去掉与显式 custom 选项重复的 vendor-custom', () => {
  const all = vendorTemplates({
    'vendor-custom': { body: { sdk: 'custom' } },
    'vendor-deepseek': { body: { sdk: 'deepseek' } },
  })
  assert.equal(all.length, 2)
  assert.deepEqual(selectableTemplates(all).map((item) => item.identity), ['vendor-deepseek'])
  assert.deepEqual(selectableTemplates(null), [])
  assert.equal(CUSTOM_TEMPLATE_IDENTITY, 'vendor-custom')
})

test('表单校验共用件：地址形态 / 密钥引用 / 探测前置', () => {
  assert.equal(validateBaseUrl('https://x/v1'), null)
  assert.equal(validateBaseUrl('http://x'), null)
  assert.equal(validateBaseUrl(''), 'settings_required')
  assert.equal(validateBaseUrl('ftp://x'), 'settings_bad_url')
  assert.equal(validateBaseUrl('not a url'), 'settings_bad_url')

  assert.equal(validateAuthRef({ kind: 'env', name: 'K' }), null)
  assert.equal(validateAuthRef({ kind: 'local', name: 'K' }), null)
  assert.equal(validateAuthRef({ kind: 'env', name: '' }), 'settings_required')
  assert.equal(validateAuthRef({ kind: 'bogus', name: 'K' }), 'settings_required')
  assert.equal(validateAuthRef(null), 'settings_required')

  assert.equal(validateProbe({ base_url: 'https://x', auth_kind: 'env', auth_name: 'K' }), null)
  assert.equal(validateProbe({ base_url: '', auth_kind: 'env', auth_name: 'K' }), 'settings_required')
  assert.equal(validateProbe({ base_url: 'https://x', auth_kind: 'env', auth_name: '' }), 'settings_required')
})

test('表单初始态 / 预填 / 写值（模板只是预填来源）', () => {
  const form = defaultOnboarding()
  assert.equal(form.templateIdentity, '')
  assert.equal(form.vendor, 'vendor-custom')
  assert.equal(form.protocol, 'openai-chat')

  form.templates = vendorTemplates({
    'vendor-deepseek': {
      body: { sdk: 'deepseek', default_base_url: 'https://api.deepseek.com/v1', default_auth_ref_name: 'K' },
    },
  })
  applyTemplate(form, 'vendor-deepseek')
  assert.equal(form.vendor, 'vendor-deepseek')
  assert.equal(form.key, 'deepseek')
  assert.equal(form.base_url, 'https://api.deepseek.com/v1')
  assert.equal(form.auth_name, 'K')

  applyTemplate(form, 'custom')
  assert.equal(form.vendor, 'vendor-custom')
  assert.equal(form.key, 'custom')
  assert.equal(form.base_url, '')

  const value = formToValue({ ...form, templateIdentity: 'custom', protocol: 'anthropic-messages', auth_kind: 'local', auth_name: 'A', selected: ['m1'], model: 'm1' })
  assert.equal(value.protocol, 'anthropic-messages')
  assert.deepEqual(value.auth_ref, { kind: 'local', name: 'A' })
  assert.deepEqual(value.models, ['m1'])
  const preset = formToValue({ ...form, templateIdentity: 'vendor-deepseek' })
  assert.equal(preset.protocol, undefined, '预设厂商不带 protocol')
})

test('列表文本回填与解析互逆（splitList / listText）', () => {
  assert.equal(listText(['a', 'b']), 'a, b')
  assert.equal(listText(undefined), '')
  assert.deepEqual(splitList(listText(['a', 'b'])), ['a', 'b'])
})

test('编辑表单：已保存厂商 → 预填 base_url / auth_ref，模型原样保留', () => {
  assert.equal(defaultOnboarding().mode, 'form')
  const form = onboardingFromEntry('deepseek', {
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    auth_ref: { kind: 'local', name: 'DEEPSEEK_API_KEY' },
    models: { 'a': { enabled: true }, 'b': { enabled: false } },
    protocol: 'openai-chat',
  })
  assert.equal(form.mode, 'edit')
  assert.equal(form.editKey, 'deepseek')
  assert.equal(form.key, 'deepseek')
  assert.equal(form.base_url, 'https://api.deepseek.com/v1')
  assert.equal(form.auth_kind, 'local')
  assert.equal(form.auth_name, 'DEEPSEEK_API_KEY')
  assert.deepEqual(form.models, ['a'])
  assert.equal(form.model, 'a')
  const blank = onboardingFromEntry('custom', null)
  assert.equal(blank.mode, 'edit')
  assert.equal(blank.base_url, '')
  assert.equal(blank.auth_kind, 'env')
})

test('界面文案单一来源：编排新增键登记在共享表，本地仅骨架兜底', () => {
  const table = sharedTable()
  assert.ok(table !== null, '共享表应可解析')
  for (const code of [
    'settings_orch_scope',
    'settings_orch_links',
    'settings_orch_rollback_failed',
    'settings_orch_rollback_unverified',
    'settings_refresh_profile',
    'settings_edit_provider',
    'settings_secret_save',
    'settings_secret_update',
    'settings_save_edit',
  ]) {
    assert.equal(lookupMessage(table, code).body.includes(code), false, `${code} 未入共享表`)
  }
  assert.equal(lookupMessage(table, 'settings_orch_rollback_unverified').body, '回滚未验证')
  assert.equal(table.settings_orch_rollback_done, undefined, '回滚成功文案不存在（只显未验证）')
  assert.equal(table.settings_loading, undefined, '死键不存在')
  // 本地兜底表只留骨架键，不承载业务文案
  assert.equal(UI_TEXT.settings_orch_scope, undefined)
  assert.equal(UI_TEXT.settings_theme_day, undefined)
  assert.equal(typeof UI_TEXT.settings_title, 'string')
  assert.equal(lookupMessage(null, 'settings_orch_scope').body.includes('settings_orch_scope'), true, '非骨架键落 unknown')
})
