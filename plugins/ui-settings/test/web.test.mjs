// `ui-settings` 浏览器视图层新增纯函数测试（node --test）：
// 厂商模板归一（model.vendors 结果 / 身份投影）、表单校验共用件、表单预填 / 回填、文案兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  applyTemplate,
  chooseEntry,
  CUSTOM_AUTH_REF_NAME,
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
import {
  editSlotPayload,
  editTextPatch,
  filterByWorkspace,
  formatTtl,
  highlightSegments,
  layerEntries,
  layerTitleKey,
  MEMORY_LAYERS,
  memoryBrowseState,
  memorySearch,
  memorySearchState,
  memoryView,
  normalizeLayer,
  pinPatch,
  summaryLists,
  ttlState,
  workspaceOptions,
} from '../execute/web/memory-model.js'
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
  assert.equal(form.auth_kind, 'local', '取值面固定本地（不进界面）')

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
  assert.equal(form.auth_name, CUSTOM_AUTH_REF_NAME, '自定义给默认引用名')

  const value = formToValue({ ...form, templateIdentity: 'custom', protocol: 'anthropic-messages', auth_kind: 'local', auth_name: 'A', selected: ['m1'] })
  assert.equal(value.protocol, 'anthropic-messages')
  assert.deepEqual(value.auth_ref, { kind: 'local', name: 'A' })
  assert.deepEqual(value.models, ['m1'])
  assert.equal(value.model, undefined, '写值不带默认模型')
  const preset = formToValue({ ...form, templateIdentity: 'vendor-deepseek' })
  assert.equal(preset.protocol, undefined, '预设厂商不带 protocol')
})

test('新建入口：模板取首个模板预填，自定义清空并给默认引用名', () => {
  const form = defaultOnboarding()
  form.templates = vendorTemplates({
    'vendor-deepseek': {
      body: { sdk: 'deepseek', default_base_url: 'https://api.deepseek.com/v1', default_auth_ref_name: 'K' },
    },
    'vendor-openai': {
      body: { sdk: 'openai', default_base_url: 'https://api.openai.com/v1', default_auth_ref_name: 'OPENAI_API_KEY' },
    },
  })
  chooseEntry(form, 'custom')
  assert.equal(form.templateIdentity, 'custom')
  assert.equal(form.key, 'custom')
  assert.equal(form.base_url, '')
  assert.equal(form.auth_name, CUSTOM_AUTH_REF_NAME)
  chooseEntry(form, 'template')
  assert.equal(form.templateIdentity, 'vendor-deepseek', '取排序首个模板')
  assert.equal(form.key, 'deepseek')
  assert.equal(form.base_url, 'https://api.deepseek.com/v1')
  assert.equal(form.auth_name, 'K')

  const empty = defaultOnboarding()
  chooseEntry(empty, 'template')
  assert.equal(empty.templateIdentity, 'custom', '无模板时模板入口回落自定义，不抛')
})

test('列表文本回填与解析互逆（splitList / listText）', () => {
  assert.equal(listText(['a', 'b']), 'a, b')
  assert.equal(listText(undefined), '')
  assert.deepEqual(splitList(listText(['a', 'b'])), ['a', 'b'])
})

test('编辑表单：已保存厂商 → 预填 base_url，模型原样保留', () => {
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
  assert.deepEqual(form.models, ['a'])
  const blank = onboardingFromEntry('custom', null)
  assert.equal(blank.mode, 'edit')
  assert.equal(blank.base_url, '')
})

test('界面文案单一来源：编排新增键登记在共享表，本地仅骨架兜底', () => {  const table = sharedTable()
  assert.ok(table !== null, '共享表应可解析')
  for (const code of [
    'settings_orch_scope',
    'settings_orch_links',
    'settings_orch_rollback_failed',
    'settings_orch_rollback_unverified',
    'settings_edit_provider',
    'settings_secret_save',
    'settings_secret_update',
    'settings_save_edit',
    'settings_api_key',
    'settings_custom_model',
    'settings_add_model',
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

test('记忆三档切换与工作区筛选', () => {
  assert.deepEqual(MEMORY_LAYERS, ['l1', 'l2', 'l3'])
  assert.equal(normalizeLayer('l2'), 'l2')
  assert.equal(normalizeLayer('bogus'), 'l1')
  assert.equal(layerTitleKey('l3'), 'settings_memory_layer_l3')

  const view = memoryView({
    ok: true,
    at: 'now',
    l1: [{ id: 'c-1', summary: { goal: 'g' } }],
    l2: [{ id: 'w1', summary: {}, sources: ['c-1'] }],
    l3: [
      { id: 'm-1', text: 'a', workspace: 'w1' },
      { id: 'm-2', text: 'b', workspace: '' },
      null,
    ],
  })
  assert.equal(view.ok, true)
  assert.equal(view.l1.length, 1)
  assert.equal(view.l3.length, 2, 'null 条目被过滤')
  assert.deepEqual(layerEntries(view, 'l3').map((entry) => entry.id), ['m-1', 'm-2'])
  assert.deepEqual(workspaceOptions(view), ['w1'])
  assert.equal(filterByWorkspace(layerEntries(view, 'l3'), 'l3', 'w1').map((entry) => entry.id).join(','), 'm-1,m-2')
  assert.equal(filterByWorkspace(layerEntries(view, 'l2'), 'l2', 'w1').length, 1)
  assert.equal(filterByWorkspace(layerEntries(view, 'l2'), 'l2', '').length, 1)
  assert.deepEqual(memoryView(null), { ok: false, at: null, l1: [], l2: [], l3: [] })
})

test('记忆 TTL 格式与过期状态', () => {
  assert.equal(formatTtl(0), '0m')
  assert.equal(formatTtl(30_000), '<1m')
  assert.equal(formatTtl(45 * 60_000), '45m')
  assert.equal(formatTtl(3 * 3_600_000 + 12 * 60_000), '3h 12m')
  assert.equal(formatTtl(2 * 86_400_000 + 4 * 3_600_000), '2d 4h')
  assert.equal(formatTtl(null), '')
  assert.deepEqual(ttlState({ ttl_remaining_ms: 0 }), { expired: true, ms: 0 })
  assert.deepEqual(ttlState({ ttl_remaining_ms: 1000 }), { expired: false, ms: 1000 })
  assert.deepEqual(ttlState({}), { expired: false, ms: null })
})

test('记忆摘要四列表归一', () => {
  const summary = summaryLists({ goal: 'g', facts: ['a', 1], decisions: ['d'], open_questions: [], files: ['f'] })
  assert.equal(summary.goal, 'g')
  assert.deepEqual(summary.facts, ['a'])
  assert.deepEqual(summary.decisions, ['d'])
  assert.deepEqual(summary.open_questions, [])
  assert.deepEqual(summary.files, ['f'])
  assert.deepEqual(summaryLists(null), { goal: '', facts: [], decisions: [], open_questions: [], files: [] })
})

test('记忆搜索归一与命中高亮 / 无匹配', () => {
  const result = memorySearch({ ok: true, recall: [{ entry_id: 'm-1', entry_hash: 'h', text: 'Alpha note', score: 0.9, meta: {} }, null] })
  assert.equal(result.count, 1)
  assert.equal(result.recall[0].entry_id, 'm-1')
  assert.deepEqual(memorySearch(null), { ok: false, recall: [], count: 0 })
  assert.deepEqual(memorySearch({ ok: true, recall: [] }).recall, [], '无匹配 = 空 recall')

  assert.deepEqual(highlightSegments('Alpha note alpha', 'alpha'), [
    { text: 'Alpha', hit: true },
    { text: ' note ', hit: false },
    { text: 'alpha', hit: true },
  ])
  assert.deepEqual(highlightSegments('abc', ''), [{ text: 'abc', hit: false }])
  assert.deepEqual(highlightSegments('abc', 'zzz'), [{ text: 'abc', hit: false }])
  assert.deepEqual(highlightSegments('a.b', '.'), [
    { text: 'a', hit: false },
    { text: '.', hit: true },
    { text: 'b', hit: false },
  ], '正则元字符按字面处理')
})

test('记忆浏览 / 搜索三态判定', () => {
  const view = memoryView({ ok: true, l1: [{ id: 'c-1' }], l2: [], l3: [{ id: 'm-1', workspace: 'w1' }] })
  assert.equal(memoryBrowseState(view, false, 'l1', ''), 'ready')
  assert.equal(memoryBrowseState(view, false, 'l2', ''), 'empty')
  assert.equal(memoryBrowseState(view, false, 'l3', 'other'), 'empty', '工作区筛选后无条目 = 空')
  assert.equal(memoryBrowseState(view, true, 'l1', ''), 'degraded')
  assert.equal(memoryBrowseState(null, false, 'l3', ''), 'empty')

  assert.equal(memorySearchState(true, false, null), 'busy')
  assert.equal(memorySearchState(false, true, null), 'degraded')
  assert.equal(memorySearchState(false, false, null), 'idle')
  assert.equal(memorySearchState(false, false, { ok: true, recall: [] }), 'empty')
  assert.equal(memorySearchState(false, false, { ok: true, recall: [{ entry_id: 'm-1', text: 'x' }] }), 'ready')
})

test('记忆编辑槽载荷与 patch', () => {  assert.deepEqual(editSlotPayload('update', 'l3', 'm-1', editTextPatch('x')), {
    kind: 'memory.edit',
    action: 'update',
    layer: 'l3',
    id: 'm-1',
    patch: { text: 'x' },
  })
  assert.deepEqual(editSlotPayload('pin', 'bogus', 'm-1', pinPatch(true)), {
    kind: 'memory.edit',
    action: 'pin',
    layer: 'l1',
    id: 'm-1',
    patch: { pinned: true },
  })
  assert.deepEqual(pinPatch(false), { pinned: false })
})

test('记忆新增文案登记在共享表', () => {
  const table = sharedTable()
  assert.ok(table !== null, '共享表应可解析')
  for (const code of [
    'settings_memory_layers',
    'settings_memory_layer_l1',
    'settings_memory_layer_l2',
    'settings_memory_layer_l3',
    'settings_memory_search',
    'settings_memory_search_placeholder',
    'settings_memory_search_failed',
    'settings_memory_no_match',
    'settings_memory_empty',
    'settings_memory_empty_hint',
    'settings_memory_load_failed',
    'settings_memory_edit_failed',
    'settings_memory_ttl',
    'settings_memory_expired',
    'settings_memory_pin',
    'settings_memory_unpin',
    'settings_memory_confirm_delete',
    'settings_memory_score',
  ]) {
    assert.equal(lookupMessage(table, code).body.includes(code), false, `${code} 未入共享表`)
  }
  assert.equal(lookupMessage(table, 'settings_memory_no_match').body, '无匹配')
  assert.equal(table.settings_memory_pending, undefined, '占位死键已移除')
  assert.equal(table.settings_memory_pending_hint, undefined, '占位死键已移除')
})
