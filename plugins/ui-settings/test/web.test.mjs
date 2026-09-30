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
  formAuthRef,
  formToValue,
  onboardingFromEntry,
  selectableTemplates,
  validateAuthRef,
  validateBaseUrl,
  validateProbe,
  vendorTemplates,
  vendorTemplatesFromResult,
} from '../execute/web/onboarding.ts'
import { listText, pluginSubParts, skillTitle, splitList } from '../execute/web/settings-model.ts'
import { createViewContext } from '../execute/web/view-context.ts'
import { joinMeta } from '../execute/web/config-model.ts'
import { graphMeta, graphView, ledgerDetailText, ledgerTitle, scopeMeta } from '../execute/web/health.ts'
import { lookupMessage, parseMessages, UI_TEXT } from '../execute/web/messages.ts'
import { loadTab } from '../execute/web/data-load.ts'

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
  assert.equal(validateAuthRef(null), null, '无引用 = 匿名，放行')
  assert.equal(validateAuthRef(undefined), null, '无引用 = 匿名，放行')

  assert.equal(validateProbe({ base_url: 'https://x', auth_kind: 'env', auth_name: 'K' }), null)
  assert.equal(validateProbe({ base_url: '', auth_kind: 'env', auth_name: 'K' }), 'settings_required')
  assert.equal(
    validateProbe({ base_url: 'https://x', auth_kind: 'local', auth_name: '', secret_value: '' }),
    null,
    '空 key = 匿名，探测放行',
  )
})

test('密钥引用按「是否有值」决定：空 key 走匿名（不引用 secret）', () => {
  assert.equal(formAuthRef({ auth_kind: 'local', auth_name: 'A', secret_value: '' }), null)
  assert.deepEqual(formAuthRef({ auth_kind: 'local', auth_name: 'A', secret_value: 'sk' }), {
    kind: 'local',
    name: 'A',
  })
  assert.deepEqual(formAuthRef({ auth_kind: 'local', auth_name: '', secret_value: 'sk' }), {
    kind: 'local',
    name: CUSTOM_AUTH_REF_NAME,
  })
  assert.equal(formAuthRef({ auth_kind: 'env', auth_name: '', secret_value: '' }), null)
  assert.deepEqual(formAuthRef({ auth_kind: 'env', auth_name: 'ENV_K', secret_value: '' }), {
    kind: 'env',
    name: 'ENV_K',
  })
  const anon = formToValue({ vendor: 'vendor-custom', key: 'custom', base_url: 'u', selected: [], auth_kind: 'local', auth_name: 'A', secret_value: '' })
  assert.equal(anon.auth_ref, null, '空 key 写值不带 auth_ref')
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

  const value = formToValue({ ...form, templateIdentity: 'custom', protocol: 'anthropic-messages', auth_kind: 'local', auth_name: 'A', secret_value: 'sk', selected: ['m1'] })
  assert.equal(value.protocol, 'anthropic-messages')
  assert.deepEqual(value.auth_ref, { kind: 'local', name: 'A' })
  assert.deepEqual(value.models, ['m1'])
  assert.equal(value.model, undefined, '写值不带默认模型')
  const anon = formToValue({ ...form, templateIdentity: 'custom', auth_kind: 'local', auth_name: 'A', secret_value: '', selected: ['m1'] })
  assert.equal(anon.auth_ref, null, '空 key = 匿名')
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
    'settings_desc_general',
    'settings_desc_model',
    'settings_desc_plugins',
    'settings_desc_skills',
    'settings_desc_orchestration',
    'settings_desc_about',
    'settings_plugins_generation',
    'settings_plugins_deps',
    'settings_orch_codes',
    'settings_orch_nodes',
    'settings_orch_edges',
    'settings_orch_rollback_hint',
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

// ── 组件文案组装下推到纯模块 ────────────────────────────────────────────────

/** 测试翻译器：带变量时把变量值拼进码后（断言可预期）。 */
function fakeT(code, vars) {
  return vars === undefined ? code : `${code}(${Object.values(vars).join(',')})`
}

test('joinMeta：过滤非空串后以 ` · ` 连接', () => {
  assert.equal(joinMeta(['a', '', null, undefined, 'b']), 'a · b')
  assert.equal(joinMeta([]), '')
  assert.equal(joinMeta(['', null]), '')
})

test('技能行主文本与插件副文本片段（纯模块）', () => {
  assert.equal(skillTitle({ id: 'sk-1', name: 'A', description: 'D' }), 'A · D')
  assert.equal(skillTitle({ id: 'sk-1' }), 'sk-1')
  assert.equal(skillTitle({ id: 'sk-1', name: 'A' }), 'A')
  assert.equal(skillTitle(null), '')

  assert.deepEqual(pluginSubParts({ activeShort: 'abcdef01', pins: { a: 'x', b: 'y' } }, (code) => code), [
    'settings_plugins_generation abcdef01',
    'settings_plugins_deps a, b',
  ])
  assert.deepEqual(pluginSubParts({ activeShort: '', pins: {} }, (code) => code), [])
  assert.deepEqual(pluginSubParts(null, (code) => code), [])
})

test('编排图 / Scope / 台账文案组装（纯模块）', () => {
  const view = graphView({
    body: { graph: { def: 'abcd' }, nodes: { tail: null, count: 0 } },
    refs: { abcd: { nodes: ['n1'], edges: [{ from: [0, 'o'], to: [1, 'i'] }] } },
  })
  assert.equal(graphMeta(view, fakeT), 'settings_orch_contract abcd · settings_orch_nodes 1 · settings_orch_edges 1')

  const scope = { index: 0, id: 'a2', contract_id: 'a2', persona: 'Q', scope: 'global', autonomy: 'high', links: 'l1', success_rate: 0.9 }
  assert.equal(
    scopeMeta(scope, fakeT),
    'settings_orch_contract a2 · settings_orch_persona Q · settings_orch_scope settings_orch_scope_global · settings_orch_autonomy high · settings_orch_links l1 · settings_orch_success 90%',
  )
  assert.equal(scopeMeta({ ...scope, persona: '', autonomy: '', links: '', success_rate: null }, fakeT), 'settings_orch_contract a2 · settings_orch_persona - · settings_orch_scope settings_orch_scope_global · settings_orch_autonomy - · settings_orch_success -')

  assert.equal(ledgerTitle({ id: 'v1', label: 'accepted' }), 'v1 · accepted')
  assert.equal(
    ledgerDetailText('verdicts', { proposal_ids: ['p1'], evidence_ids: ['e1'], gate: { mechanical: 'm' }, adopted_gen: 2, at: 'now' }),
    'proposal p1 · evidence e1 · gate m · gen 2 · now',
  )
  assert.equal(ledgerDetailText('proposals', { evidence_ids: ['e1'], patch: { def: 'd' } }), 'evidence e1 · patch d')
  assert.equal(ledgerDetailText('evidence', { traces: [{ def: 't1' }], cluster_key: { attributable_to: 'x' } }), 'trace t1 · attributable_to x')
  assert.equal(ledgerDetailText('evidence', {}), '-')
})

// ── tab 装载令牌：慢的旧装载不覆盖已切走后的新状态 ─────────────────────────

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeLoadCtx(routes) {
  return {
    doc: { defaultView: null },
    state: {
      loading: false,
      loadingCount: 0,
      loadingNote: false,
      loadError: null,
      skillProjection: null,
      identities: null,
      config: null,
      vendors: null,
      secrets: {},
      orch: { graph: null, scopes: null, health: null, degraded: { graph: false, scopes: false, health: false } },
    },
    render: () => {},
    armLoadingNote: () => {},
    clearLoadingNote: () => {},
    loadVendors: async () => {},
    runCommand: async (name) => {
      const route = routes[name]
      return route === undefined ? { ok: true, value: null } : route()
    },
  }
}

test('loadTab：慢的旧装载在切走后被丢弃', async () => {
  let releaseSkills = null
  const ctx = fakeLoadCtx({
    'settings.skills': () => new Promise((resolve) => { releaseSkills = resolve }),
    'settings.identities': async () => ({ ok: true, value: { id: 'new' } }),
  })
  const slow = loadTab(ctx, 'skills')
  await flush()
  await loadTab(ctx, 'plugins')
  releaseSkills({ ok: true, value: { body: { version: 1, skills: [{ id: 'stale' }] } } })
  await slow
  assert.equal(ctx.state.skillProjection, null, '过期装载结果被丢弃')
  assert.deepEqual(ctx.state.identities, { id: 'new' })
})

test('loadTab general：config.read 失败置页面级 loadError，不按空态起步', async () => {
  const ctx = fakeLoadCtx({ 'config.read': async () => ({ ok: false, code: 'boom' }) })
  await loadTab(ctx, 'general')
  assert.deepEqual(ctx.state.loadError, { code: 'boom', message: '' })
  assert.equal(ctx.state.config, null)
})

test('loadTab general：读成功写 config；退避后仍回落 body 归 not_loaded', async () => {
  const okCtx = fakeLoadCtx({
    'config.read': async () => ({ ok: true, value: { active: 'a'.repeat(64), body: { version: 1 } } }),
  })
  await loadTab(okCtx, 'general')
  assert.deepEqual(okCtx.state.config, { version: 1 })
  assert.equal(okCtx.state.loadError, null)

  const fallbackCtx = fakeLoadCtx({
    'config.read': async () => ({ ok: true, value: { active: 'a'.repeat(64), body: { tree: 'x' } } }),
  })
  await loadTab(fallbackCtx, 'general')
  assert.deepEqual(fallbackCtx.state.loadError, { code: 'not_loaded', message: '' })
})

test('writeConfig：命令回世界写计划（status=done、value=null）算成功，不误报 not_loaded', async () => {
  const api = {
    command: async () => ({ ok: true, status: 'done', value: null }),
    submit: async () => ({ ok: true, status: 'done' }),
  }
  const { vc, dispose } = createViewContext(api)
  try {
    const body = {
      version: 1,
      params: {},
      permission: 'review',
      ui: { theme: 'system', style: '', sidebar_width: 260 },
      providers: {},
    }
    const result = await vc.writeConfig(body)
    assert.equal(result.ok, true)
    assert.equal(result.refused, false)
    assert.deepEqual(vc.state.config, body)
  } finally {
    dispose()
  }
})

test('loadTab skills：失败置页面级 loadError', async () => {
  const skills = fakeLoadCtx({ 'settings.skills': async () => ({ ok: false, code: 'boom' }) })
  await loadTab(skills, 'skills')
  assert.deepEqual(skills.state.loadError, { code: 'boom', message: '' })
})
