// `ui-settings` 纯函数层 + 服务协议测试（node --test）。
// 覆盖：配置读-改-写、导入校验、引导流程纯函数、通知权限解析、编排健康判定、
// 设置页纯函数、帧构造 / 路由 / 端口 / 静态白名单、服务握手 / ping / probe / drain（等在途后 bye）/ EOF 自退出、
// 连接态事件命名空间由身份传入、入口导出。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  batchWriteDirective,
  buildOnboardingConfig,
  configWriteDirective,
  emptyConfig,
  enabledModelIds,
  exportJson,
  notifyOf,
  providerEntry,
  providerList,
  removeProvider,
  setNotify,
  setParams,
  setUiField,
  slotWriteDirective,
  themeCardOf,
  upsertProvider,
  validateImport,
  vendorKeyOf,
} from '../execute/web/config-model.js'
import {
  addModelIds,
  buildProbeSlot,
  CUSTOM_PROTOCOLS,
  discoverErrorCode,
  discoverModels,
  templatePrefill,
  validateOnboarding,
  vendorTemplates,
} from '../execute/web/onboarding.js'
import {
  canRequestPermission,
  mergeToggles,
  normalizePermission,
  NOTIFY_KEYS,
  parseNotifyState,
  permissionFromNotifyGlobal,
  permissionMessageKey,
  permissionTone,
  toggleValue,
  togglesDisabled,
} from '../execute/web/notify.js'
import {
  graphView,
  healthView,
  ledgerLists,
  ledgerSummary,
  scopeLabel,
  scopeList,
  shortHash,
  walkTail,
} from '../execute/web/health.js'
import {
  identityRows,
  normalizeTab,
  pluginCount,
  removeSkill,
  skillFromForm,
  skillList,
  splitList,
  TABS,
  toggleSkill,
  upsertSkill,
} from '../execute/web/settings-model.js'
import { lookupMessage, parseMessages, UI_TEXT } from '../execute/web/messages.js'
import { commitProviderEdit, fetchModels, saveProviderSecret } from '../execute/web/provider-actions.js'

import { commandFrame, extractValue, interpretResponse, submitFrame, unwrapPlan } from '../execute/bridge.ts'
import {
  assembleDiscoverArgs,
  assembleEditArgs,
  assembleProfileArgs,
  assembleSearchBag,
  assembleVendorArgs,
  assembleViewArgs,
  clearMemoryEditSlots,
  clearSlotBody,
  collectVendorBodies,
  createHandlers,
  currentSessionGoal,
  findMemoryEditSlot,
  judgeHealth,
  ledgerLists as serviceLedgerLists,
  maintenanceAction,
  planPayload,
  planWriteOps,
  probeOf,
  projectionBody,
  projectionRefs,
  resolveThreshold,
} from '../execute/methods.ts'
import { DEFAULT_SETTINGS_PORT, parsePort, resolvePort } from '../execute/port.ts'
import { routeOf } from '../execute/routes.ts'
import { readWebFile, WEB_FILE_RE } from '../execute/static.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const WEB = join(PKG_ROOT, 'execute', 'web')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `chrono-ui-settings-${label}-`))
}

// ---- 配置读-改-写 ----

test('config 读-改-写：厂商增删改、选择、参数、UI 字段', () => {
  assert.equal(vendorKeyOf('vendor-deepseek'), 'deepseek')
  assert.equal(vendorKeyOf('custom'), 'custom')

  const base = emptyConfig()
  const entry = providerEntry({
    key: 'deepseek',
    base_url: 'https://api.deepseek.com/v1',
    auth_ref: { kind: 'env', name: 'DEEPSEEK_API_KEY' },
    models: ['deepseek-chat', 'deepseek-reasoner'],
  })
  assert.equal(entry.protocol, undefined)
  assert.deepEqual(Object.keys(entry.models), ['deepseek-chat', 'deepseek-reasoner'])

  const added = upsertProvider(base, 'deepseek', entry)
  assert.equal(base.providers.deepseek, undefined, '不改入参')
  assert.equal(providerList(added).length, 1)
  assert.deepEqual(enabledModelIds(added.providers.deepseek), ['deepseek-chat', 'deepseek-reasoner'])

  // 当前选择由对话输入框写：此处直接构造带 vendor / model 的 config 验证删除清选择
  const selected = { ...added, vendor: 'deepseek', model: 'deepseek-chat' }
  assert.equal(selected.vendor, 'deepseek')
  assert.equal(selected.model, 'deepseek-chat')

  const withParams = setParams(selected, { temperature: 0.2 })
  assert.equal(withParams.params.temperature, 0.2)

  const withTheme = setUiField(withParams, 'theme', 'night')
  assert.equal(withTheme.ui.theme, 'night')

  const withNotify = setNotify(withTheme, 'run_failed', false)
  assert.equal(notifyOf(withNotify).run_failed, false)

  const removed = removeProvider(withNotify, 'deepseek')
  assert.equal(removed.providers.deepseek, undefined)
  assert.equal(removed.vendor, undefined, '删除当前厂商同时清选择')
  assert.equal(removed.model, undefined)
})

test('batch 写指令：put 整值 + add_gen 绑定身份，占位符指回 put', () => {
  const directive = configWriteDirective(emptyConfig())
  assert.equal(directive.kind, 'write')
  assert.equal(directive.request.op, 'batch')
  const ops = directive.request.args.ops
  assert.equal(ops[0].op, 'put')
  assert.equal(ops[1].op, 'add_gen')
  assert.equal(ops[1].args.id, 'config')
  assert.deepEqual(ops[1].args.payload, { $n: 0 })
  assert.deepEqual(ops[1].args.sig, { $n: 0 })
  assert.equal(batchWriteDirective('skill', { version: 1 }).request.args.ops[1].args.id, 'skill')
})

test('输入槽写指令：只覆盖本线程键（清槽由服务计划携带）', () => {
  const slots = { _main: { kind: 'chat.message' }, t1: { kind: 'idle' } }
  const write = slotWriteDirective(slots, 't1', { kind: 'model.probe', url: 'u' })
  const body = write.request.args.ops[0].args.body
  assert.deepEqual(Object.keys(body.slots).sort(), ['_main', 't1'])
  assert.equal(body.slots._main.kind, 'chat.message', '其它线程键原样')
  assert.equal(body.slots.t1.kind, 'model.probe')
})

test('配置导入：合法通过，坏 JSON / 缺字段 / 坏枚举被拒', () => {
  const body = emptyConfig()
  assert.equal(validateImport(JSON.stringify(body)).ok, true)
  assert.equal(validateImport('not json').code, 'settings_import_bad_json')
  assert.equal(validateImport('[]').code, 'settings_import_bad_shape')
  const missing = { version: 1, params: {}, permission: 'review', ui: {} }
  assert.equal(validateImport(JSON.stringify(missing)).code, 'settings_import_bad_shape')
  const badEnum = { ...body, permission: 'bogus' }
  assert.equal(validateImport(JSON.stringify(badEnum)).code, 'settings_import_bad_shape')
  const badTheme = { ...body, ui: { theme: 'bogus' } }
  assert.equal(validateImport(JSON.stringify(badTheme)).code, 'settings_import_bad_shape')
  assert.match(exportJson(body), /"providers"/)
})

// ---- 引导流程 ----

test('厂商模板抽取与预填（模板只是预填来源）', () => {
  const ids = {
    'vendor-deepseek': {
      body: { sdk: 'deepseek', default_base_url: 'https://api.deepseek.com/v1', default_auth_ref_name: 'DEEPSEEK_API_KEY', default_reasoning: ['low', 'high'] },
    },
    'vendor-custom': { body: { sdk: 'custom' } },
    config: { body: { version: 1 } },
  }
  const templates = vendorTemplates(ids)
  assert.deepEqual(templates.map((item) => item.identity), ['vendor-custom', 'vendor-deepseek'])
  assert.equal(templatePrefill(templates, 'vendor-deepseek').base_url, 'https://api.deepseek.com/v1')
  assert.equal(templatePrefill(templates, 'vendor-deepseek').key, 'deepseek')
  assert.deepEqual(templatePrefill(templates, 'missing'), { key: '', base_url: '', auth_ref_name: '', sdk: '' })
  assert.deepEqual(vendorTemplates(null), [])
})

test('探测槽 / 模型列表归一 / 发现错误码', () => {
  const slot = buildProbeSlot({
    base_url: 'https://api.deepseek.com/v1',
    auth_ref: { kind: 'env', name: 'K' },
    protocol: 'openai-chat',
  })
  assert.deepEqual(slot, { kind: 'model.probe', url: 'https://api.deepseek.com/v1', auth_ref: { kind: 'env', name: 'K' }, protocol: 'openai-chat' })
  const envSlot = buildProbeSlot({ base_url: 'u', auth_ref: { kind: 'local', name: 'K' } })
  assert.equal(Object.hasOwn(envSlot, 'protocol'), false, '预设厂商不带 protocol')

  assert.deepEqual(discoverModels({ ok: true, models: ['b', 'a', 'a'] }), ['a', 'b'])
  assert.deepEqual(discoverModels({ ok: false, error: { code: 'discover_bad_url' } }), [])
  assert.deepEqual(discoverModels(null), [])
  assert.equal(discoverErrorCode({ ok: false, error: { code: 'discover_auth_failed' } }), 'discover_auth_failed')
  assert.equal(discoverErrorCode({ ok: false }), 'discover_unsupported')
  assert.equal(discoverErrorCode({ ok: true }), null)
})

test('引导表单校验：必填 / URL 形态 / 模型在勾选内', () => {
  const good = {
    base_url: 'https://api.deepseek.com/v1',
    auth_ref: { kind: 'env', name: 'K' },
    models: ['m1'],
  }
  assert.equal(validateOnboarding(good), null)
  assert.equal(validateOnboarding({ ...good, base_url: '' }), 'settings_required')
  assert.equal(validateOnboarding({ ...good, base_url: 'ftp://x' }), 'settings_bad_url')
  assert.equal(validateOnboarding({ ...good, base_url: 'not a url' }), 'settings_bad_url')
  assert.equal(validateOnboarding({ ...good, auth_ref: { kind: 'env', name: '' } }), 'settings_required')
  assert.equal(validateOnboarding({ ...good, models: [] }), 'settings_required')
  assert.deepEqual(CUSTOM_PROTOCOLS, ['openai-chat', 'openai-responses', 'anthropic-messages'])
})

test('自定义模型 id：逗号 / 空格分隔，去重、排序并默认勾选', () => {
  const form = { models: ['m1'], selected: ['m1'] }
  assert.deepEqual(addModelIds(form, 'm2, m3  m1'), ['m2', 'm3'])
  assert.deepEqual(form.models, ['m1', 'm2', 'm3'])
  assert.deepEqual(form.selected, ['m1', 'm2', 'm3'])
  assert.deepEqual(addModelIds(form, ''), [])
  assert.deepEqual(addModelIds(form, '  '), [])
})

test('引导完成：写 config 合并厂商（不写当前选择）', () => {
  const form = {
    vendor: 'vendor-deepseek',
    key: 'deepseek',
    base_url: 'https://api.deepseek.com/v1',
    auth_ref: { kind: 'env', name: 'DEEPSEEK_API_KEY' },
    models: ['deepseek-chat'],
  }
  const body = buildOnboardingConfig(emptyConfig(), form)
  assert.equal(body.vendor, undefined, '不写当前选择：由对话输入框选模型时写')
  assert.equal(body.model, undefined)
  assert.equal(body.providers.deepseek.base_url, 'https://api.deepseek.com/v1')
  assert.equal(body.providers.deepseek.auth_ref.name, 'DEEPSEEK_API_KEY')
  assert.deepEqual(Object.keys(body.providers.deepseek.models), ['deepseek-chat'])
})

// ---- 通知 ----

test('notify.state 解析：config body 形态 / 直接形态 / 权限三态', () => {
  const fromConfig = parseNotifyState({ ui: { notify: { run_failed: false } }, permission: 'granted' })
  assert.equal(fromConfig.toggles.run_failed, false)
  assert.equal(fromConfig.permission, 'granted')
  const direct = parseNotifyState({ toggles: { run_finished: false }, permission: 'denied' })
  assert.equal(direct.toggles.run_finished, false)
  assert.equal(direct.permission, 'denied')
  assert.equal(parseNotifyState(null).permission, 'unknown')
  assert.equal(parseNotifyState({ permission: 'bogus' }).permission, 'unknown')
})

test('主题偏好归一：config 用户语义与壳落 DOM 词表互通', () => {
  assert.equal(themeCardOf('day'), 'day')
  assert.equal(themeCardOf('light'), 'day')
  assert.equal(themeCardOf('night'), 'night')
  assert.equal(themeCardOf('dark'), 'night')
  assert.equal(themeCardOf('system'), 'system')
  assert.equal(themeCardOf(undefined), 'system')
  assert.equal(themeCardOf('bogus'), 'system')
})

test('权限状态取自通知前端同页全局，缺失即 unknown', () => {
  assert.equal(permissionFromNotifyGlobal({ permission: 'granted' }), 'granted')
  assert.equal(permissionFromNotifyGlobal({ permission: 'denied' }), 'denied')
  assert.equal(permissionFromNotifyGlobal({ permission: 'bogus' }), 'unknown')
  assert.equal(permissionFromNotifyGlobal({}), 'unsupported')
  assert.equal(permissionFromNotifyGlobal(null), 'unknown')
})

test('通知开关与权限口径', () => {
  assert.equal(toggleValue({ run_failed: false }, 'run_failed'), false)
  assert.equal(toggleValue({}, 'run_failed'), true)
  assert.equal(NOTIFY_KEYS.length, 10)
  assert.ok(NOTIFY_KEYS.includes('only_when_unfocused'))
  assert.equal(normalizePermission('granted'), 'granted')
  assert.equal(normalizePermission(undefined), 'unsupported')
  assert.equal(togglesDisabled('granted'), false)
  assert.equal(togglesDisabled('default'), true)
  assert.equal(togglesDisabled('denied'), true)
  assert.equal(canRequestPermission('default'), true)
  assert.equal(canRequestPermission('denied'), false)
  assert.equal(permissionTone('granted'), 'success')
  assert.equal(permissionTone('denied'), 'danger')
  assert.equal(permissionMessageKey('default'), 'settings_notify_default')
  assert.deepEqual(mergeToggles({ a: true }, { a: false, b: true, c: 'x' }), { a: false, b: true })
})

// ---- 编排健康 ----

function evolutionFixture(outcomes) {
  const refs = {}
  let prev = null
  outcomes.forEach((outcome, index) => {
    const hash = `h${index}`
    refs[hash] = { kind: 'trace', outcome, prev, refused_at: outcome === 'refused' ? { code: 'guard_denied' } : null }
    prev = { def: hash }
  })
  const last = outcomes.length > 0 ? { def: `h${outcomes.length - 1}` } : null
  return {
    body: { version: 1, trace: { tail: last, count: outcomes.length }, evidence: { tail: null, count: 0 }, proposals: { tail: null, count: 0 }, verdicts: { tail: null, count: 0 } },
    refs,
    active: null,
    gens: [],
  }
}

test('健康结果归一：状态 / 计数 / 阈值 / 拒绝码 / 回滚目标', () => {
  const view = healthView({
    ok: true,
    status: 'warning',
    consecutive_refused: 3,
    threshold: 5,
    threshold_source: 'loop-policy',
    refusal_codes: [{ code: 'guard_denied', count: 3 }],
    rollback: { payload: 'g1', seq: 1 },
  })
  assert.equal(view.present, true)
  assert.equal(view.status, 'warning')
  assert.equal(view.consecutive, 3)
  assert.equal(view.threshold, 5)
  assert.equal(view.thresholdSource, 'loop-policy')
  assert.deepEqual(view.codes, [{ code: 'guard_denied', count: 3 }])
  assert.deepEqual(view.rollback, { payload: 'g1', seq: 1 })
  assert.deepEqual(view.ledger, { verdicts: [], proposals: [], evidence: [] })

  const withLedger = healthView({
    ok: true,
    status: 'ok',
    ledger: { verdicts: [{ id: 'v1', result: 'rejected' }], proposals: [], evidence: [] },
  })
  assert.deepEqual(withLedger.ledger.verdicts, [{ id: 'v1', result: 'rejected' }])

  const degraded = healthView(null)
  assert.equal(degraded.present, false)
  assert.equal(degraded.status, 'ok')
  assert.equal(degraded.threshold, null)
  assert.equal(degraded.rollback, null)

  const bad = healthView({
    status: 'bogus',
    consecutive_refused: 'x',
    threshold: 0,
    threshold_source: 'x',
    refusal_codes: [null, { code: 'c' }],
    rollback: { seq: 2 },
  })
  assert.equal(bad.status, 'ok')
  assert.equal(bad.consecutive, 0)
  assert.equal(bad.threshold, null)
  assert.equal(bad.thresholdSource, 'default')
  assert.deepEqual(bad.codes, [{ code: 'c', count: 0 }])
  assert.equal(bad.rollback, null)
})

test('台账 tail 倒序 / 摘要 / 图与 Scope 视图', () => {
  const evolution = {
    body: {
      verdicts: { tail: { def: 'v2' }, count: 2 },
      proposals: { tail: null, count: 0 },
      evidence: { tail: null, count: 0 },
      trace: { tail: null, count: 0 },
    },
    refs: {
      v1: { kind: 'verdict', id: 'v1', result: 'rejected', proposal_ids: ['p1'], prev: null },
      v2: { kind: 'verdict', id: 'v2', result: 'accepted', proposal_ids: ['p2', 'p3'], prev: { def: 'v1' } },
    },
  }
  const lists = ledgerLists(evolution)
  assert.deepEqual(lists.verdicts.map((entry) => entry.id), ['v2', 'v1'])
  assert.deepEqual(ledgerSummary('verdicts', lists.verdicts[0]), {
    id: 'v2',
    label: 'accepted',
    detail: 'proposal p2, p3',
  })
  assert.deepEqual(ledgerSummary('proposals', { id: 'p1', class: 'binding', evidence_ids: ['ev-1'] }), {
    id: 'p1',
    label: 'binding',
    detail: 'evidence ev-1',
  })
  assert.deepEqual(ledgerSummary('evidence', { id: 'ev-1', class: 'failure_cluster', cluster_key: { code: 'c' }, n: 3, traces: [{ def: 't1' }] }), {
    id: 'ev-1',
    label: 'failure_cluster',
    detail: 'c · n 3 · trace t1',
  })
  assert.deepEqual(walkTail(evolution, 'proposals'), [])
  // 服务侧已走好的台账数组：直接归一，不再走投影 tail
  assert.deepEqual(ledgerLists({ verdicts: [{ id: 'v' }], proposals: [], evidence: [] }).verdicts, [{ id: 'v' }])

  const graph = {
    active: 'g2',
    gens: [
      { seq: 0, payload: 'g0' },
      { seq: 1, payload: 'g1' },
      { seq: 2, payload: 'g2' },
    ],
    body: { contract_id: 'c1', nodes: [{ contract_id: 'n1', impl: 'a' }], edges: [{ from: 0, to: 1, when: 'ok' }] },
  }
  const view = graphView(graph)
  assert.equal(view.contractId, 'c1')
  assert.deepEqual(view.nodes, [{ index: 0, contract_id: 'n1', impl: 'a' }])
  assert.deepEqual(view.edges, [{ from: 0, to: 1, when: 'ok' }])
  assert.deepEqual(graphView(null).nodes, [])

  const agents = {
    body: {
      version: 1,
      templates: { tail: null, count: 0 },
      instances: { tail: { def: 'i2' }, count: 2 },
      channels: { tail: null, count: 0 },
    },
    refs: {
      i1: { id: 'a1', name: 'P', scope: 'workspace', prev: null },
      i2: {
        id: 'a2',
        name: 'Q',
        scope: 'global',
        autonomy: 'high',
        links: [{ id: 'l1' }],
        success_rate: 0.9,
        prev: { def: 'i1' },
      },
    },
  }
  assert.deepEqual(scopeList(agents), [
    { index: 0, id: 'a2', contract_id: 'a2', persona: 'Q', scope: 'global', autonomy: 'high', links: 'l1', success_rate: 0.9 },
    { index: 1, id: 'a1', contract_id: 'a1', persona: 'P', scope: 'workspace', autonomy: '', links: '', success_rate: null },
  ])
  assert.deepEqual(scopeList(null), [])
  assert.equal(scopeLabel('global'), 'global')
  assert.equal(scopeLabel('w1'), 'w1')
  assert.equal(scopeLabel({ kind: 'workspace', workspace_id: 'w2' }), 'w2')
  assert.equal(scopeLabel({ kind: 'global' }), 'global')
  assert.equal(scopeLabel(null), 'global')
  assert.equal(shortHash('abcdef0123456789'), 'abcdef01')
  assert.equal(shortHash(null), '')
})

// ---- 服务侧装配 / 桥接 / 判定 ----

/** 假反向调用端口：记录调用并回固定 outcome（`{ok:true,value}` / `{ok:false,code,message}`）。 */
function fakeModel(outcome) {
  const calls = []
  return {
    calls,
    call: async (port, method, args) => {
      calls.push({ port, method, args })
      return outcome
    },
  }
}

test('服务侧厂商装配：从 ids 的 vendor-* body 收集并桥接 model.vendors', async () => {
  const ids = {
    'vendor-deepseek': { body: { sdk: 'deepseek', default_base_url: 'u' } },
    'vendor-custom': { body: { sdk: 'custom' } },
    config: { body: { version: 1 } },
  }
  assert.deepEqual(collectVendorBodies(ids), [
    { identity: 'vendor-custom', body: { sdk: 'custom' } },
    { identity: 'vendor-deepseek', body: { sdk: 'deepseek', default_base_url: 'u' } },
  ])
  assert.deepEqual(assembleVendorArgs(ids), { vendors: collectVendorBodies(ids) })

  const model = fakeModel({ ok: true, value: { ok: true, vendors: [{ identity: 'vendor-custom' }] } })
  const handlers = createHandlers({ identity: 'ui-settings', model })
  const value = await handlers.vendors(ids, { run: null, thread: null, now: 0 })
  assert.deepEqual(model.calls, [
    { port: 'model', method: 'vendors', args: { vendors: collectVendorBodies(ids) } },
  ])
  assert.deepEqual(value, {
    $directives: [{ kind: 'extern', payload: { ok: true, vendors: [{ identity: 'vendor-custom' }] } }],
  })

  const failed = fakeModel({ ok: false, code: 'not_loaded', message: 'x' })
  const failedHandlers = createHandlers({ identity: 'ui-settings', model: failed })
  const errorValue = await failedHandlers.vendors(ids, { run: null, thread: null, now: 0 })
  assert.equal(errorValue.$directives[0].payload.error.code, 'not_loaded')
})

test('服务侧档案装配：从 config 读当前选择与已勾选模型', async () => {
  const ids = {
    config: {
      body: { version: 1, vendor: 'deepseek', providers: { deepseek: { models: { a: { enabled: true }, b: {} } } } },
    },
    'vendor-deepseek': { body: { sdk: 'deepseek' } },
  }
  const assembled = assembleProfileArgs(ids)
  assert.equal(assembled.ok, true)
  assert.equal(assembled.args.vendor, 'deepseek')
  assert.deepEqual(assembled.args.ids, ['a', 'b'])
  assert.deepEqual(assembled.args.vendors, [{ identity: 'vendor-deepseek', body: { sdk: 'deepseek' } }])
  assert.equal(assembleProfileArgs({}).ok, false)
  assert.equal(assembleProfileArgs({ config: { body: { version: 1 } } }).code, 'profile_no_vendor')

  const plan = { $directives: [{ kind: 'write', request: { op: 'batch', args: { ops: [] } } }, { kind: 'extern', payload: { ok: true, changed: true } }] }
  const model = fakeModel({ ok: true, value: plan })
  const handlers = createHandlers({ identity: 'ui-settings', model })
  const value = await handlers.profile(ids, { run: null, thread: null, now: 0 })
  assert.deepEqual(value, plan)
  assert.deepEqual(model.calls, [{ port: 'model', method: 'profile', args: assembled.args }])

  const missing = await handlers.profile({}, { run: null, thread: null, now: 0 })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'profile_no_config')
})

test('服务侧发现装配与清槽：读 model.probe，计划清 _main 保留其它线程键', async () => {
  const inputBody = {
    slots: {
      _main: { kind: 'model.probe', url: 'https://x/v1', auth_ref: { kind: 'env', name: 'K' } },
      t1: { kind: 'chat.message' },
    },
  }
  assert.deepEqual(assembleDiscoverArgs(inputBody), { url: 'https://x/v1', auth_ref: { kind: 'env', name: 'K' } })
  assert.equal(probeOf({ slots: {} }), null)
  const cleared = clearSlotBody(inputBody)
  assert.equal(cleared.slots._main.kind, 'idle')
  assert.equal(cleared.slots.t1.kind, 'chat.message')
  assert.equal(inputBody.slots._main.kind, 'model.probe', '不改入参')

  const model = fakeModel({ ok: true, value: { ok: true, models: ['m1'] } })
  const handlers = createHandlers({ identity: 'ui-settings', model })
  const value = await handlers.discover(inputBody, { run: null, thread: null, now: 0 })
  const directives = value.$directives
  assert.equal(directives[0].kind, 'write')
  assert.equal(directives[0].request.op, 'batch')
  const body = directives[0].request.args.ops[0].args.body
  assert.equal(body.slots._main.kind, 'idle')
  assert.equal(body.slots.t1.kind, 'chat.message')
  assert.deepEqual(directives[1], { kind: 'extern', payload: { ok: true, models: ['m1'] } })

  const missing = await handlers.discover({ slots: { _main: { kind: 'idle' } } }, { run: null, thread: null, now: 0 })
  assert.equal(missing.$directives[0].request.args.ops[0].args.body.slots._main.kind, 'idle')
  assert.equal(missing.$directives[1].payload.ok, false)
  assert.equal(missing.$directives[1].payload.error.code, 'model_probe_missing')
})

test('服务侧健康判定：计数 / 阈值 / 拒绝码 / 回滚目标 / 缺编排图降级', () => {
  const evolution = evolutionFixture(['done', 'refused', 'refused', 'refused'])
  const ids = {
    evolution,
    'loop-policy': {
      active: 'g2',
      gens: [
        { seq: 0, payload: 'g0' },
        { seq: 1, payload: 'g1' },
        { seq: 2, payload: 'g2' },
      ],
      body: { thresholds: { consecutive_refused: 5 } },
    },
  }
  const health = judgeHealth(ids)
  assert.equal(health.status, 'warning')
  assert.equal(health.consecutive_refused, 3)
  assert.equal(health.threshold, 5)
  assert.equal(health.threshold_source, 'loop-policy')
  assert.deepEqual(health.refusal_codes, [{ code: 'guard_denied', count: 3 }])
  assert.deepEqual(health.rollback, { payload: 'g1', seq: 1 })
  assert.deepEqual(health.ledger, { verdicts: [], proposals: [], evidence: [] })

  const degraded = judgeHealth({ evolution })
  assert.equal(degraded.status, 'unhealthy')
  assert.equal(degraded.threshold, 3)
  assert.equal(degraded.threshold_source, 'default')
  assert.equal(degraded.rollback, null)
  assert.equal(judgeHealth({}).status, 'ok')
  assert.deepEqual(judgeHealth({}).ledger, { verdicts: [], proposals: [], evidence: [] })
  assert.deepEqual(resolveThreshold({ body: { thresholds: 4 } }), { value: 4, source: 'loop-policy' })
  assert.deepEqual(resolveThreshold({}), { value: 3, source: 'default' })
})

test('服务侧台账：三条 tail 倒序随健康结果返回，采纳与拒绝都在', () => {
  const evolution = {
    body: {
      verdicts: { tail: { def: 'v2' }, count: 2 },
      proposals: { tail: null, count: 0 },
      evidence: { tail: null, count: 0 },
      trace: { tail: null, count: 0 },
    },
    refs: {
      v1: { kind: 'verdict', id: 'v1', result: 'rejected', proposal_ids: ['p1'], evidence_ids: ['e1'], prev: null },
      v2: { kind: 'verdict', id: 'v2', result: 'accepted', proposal_ids: ['p2'], evidence_ids: ['e2'], prev: { def: 'v1' } },
    },
  }
  const ledger = serviceLedgerLists(evolution)
  assert.deepEqual(ledger.verdicts.map((entry) => entry.id), ['v2', 'v1'])
  const health = judgeHealth({ evolution })
  assert.deepEqual(health.ledger.verdicts.map((entry) => entry.result), ['accepted', 'rejected'])
})

// ---- 记忆命令（服务侧装配 / 桥接 / 清槽）----

function memoryIds() {
  return {
    'short-memory': {
      body: {
        version: 1,
        sessions: { 'c-1': { summary: { goal: '写排序', facts: ['f1'] }, at: '2026-01-01T00:00:00Z', expires_at: null } },
        workspaces: { w1: { summary: { goal: 'g' }, sources: ['c-1'] } },
      },
    },
    session: { body: { version: 1, current: 'c-1', conversations: [{ id: 'c-1', workspace_id: 'w1' }] } },
    'memory-store': {
      body: { tail: null, count: 1, deleted: {}, pinned: {} },
      refs: { h1: { id: 'm-1', text: 'alpha', meta: { source: 'manual', workspace: 'w1', tags: ['t'] }, chunks: [], prev: null } },
    },
    input: { body: { slots: { _main: { kind: 'idle' } } } },
  }
}

test('memory.view 装配：从投影取 #3 body + #21 body / refs，反向调 memory-maintenance.view（只读）', async () => {
  const ids = memoryIds()
  assert.deepEqual(assembleViewArgs(ids), {
    short_memory: ids['short-memory'].body,
    memory_store: ids['memory-store'].body,
    memory_store_refs: ids['memory-store'].refs,
  })
  assert.equal(projectionBody(ids, 'session').current, 'c-1')
  assert.deepEqual(projectionRefs(ids, 'nope'), {})
  assert.equal(projectionBody(ids, 'nope'), null)

  const viewValue = { ok: true, kind: 'view', at: 'now', l1: [], l2: [], l3: [] }
  const maintenance = fakeModel({ ok: true, value: viewValue })
  const handlers = createHandlers({ identity: 'ui-settings', model: maintenance, maintenance })
  const value = await handlers.view(ids, { run: null, thread: null, now: 0 })
  assert.deepEqual(maintenance.calls, [
    { port: 'memory-maintenance', method: 'view', args: assembleViewArgs(ids) },
  ])
  assert.deepEqual(value, { $directives: [{ kind: 'extern', payload: viewValue }] })
})

test('memory.search 装配：#22 真实 bag（query / goal / workspace / retrieval / memory）', async () => {
  const ids = memoryIds()
  const assembled = assembleSearchBag({ query: 'note', workspace: 'w1', tags: ['t'], limit: 5, ids })
  assert.equal(assembled.ok, true)
  assert.deepEqual(assembled.bag, {
    query: 'note',
    workspace: 'w1',
    goal: '写排序',
    retrieval: { tags: ['t'], top_k: 5 },
    memory: { body: ids['memory-store'].body, refs: ids['memory-store'].refs },
  })
  assert.equal(currentSessionGoal(ids), '写排序')
  assert.equal(currentSessionGoal({ session: { body: { current: 'x' } }, 'short-memory': { body: { sessions: {} } } }), null)

  const missing = assembleSearchBag({ query: '   ' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'memory_query_required')

  const searchValue = { ok: true, kind: 'search', recall: [], count: 0 }
  const retrieval = fakeModel({ ok: true, value: searchValue })
  const handlers = createHandlers({ identity: 'ui-settings', model: retrieval, retrieval })
  const value = await handlers.search({ query: 'note', workspace: 'w1', tags: ['t'], limit: 5, ids }, { run: null, thread: null, now: 0 })
  assert.deepEqual(retrieval.calls, [{ port: 'retrieval', method: 'search', args: assembled.bag }])
  assert.deepEqual(value, { $directives: [{ kind: 'extern', payload: searchValue }] })

  const failed = await handlers.search({ query: '  ' }, { run: null, thread: null, now: 0 })
  assert.equal(failed.$directives[0].payload.error.code, 'memory_query_required')
})

test('memory.edit 槽消费 / action 对齐 / 清槽：读 #1 槽 + #3 / #21 投影，计划含清槽', async () => {
  const ids = memoryIds()
  const inputBody = {
    slots: {
      _main: { kind: 'memory.edit', action: 'update', layer: 'l3', id: 'm-1', patch: { text: 'beta' } },
      t1: { kind: 'chat.message' },
    },
  }
  const slot = findMemoryEditSlot(inputBody)
  assert.equal(slot.id, 'm-1')
  assert.equal(findMemoryEditSlot({ slots: { _main: { kind: 'idle' } } }), null)
  assert.equal(maintenanceAction('update'), 'text')
  assert.equal(maintenanceAction('delete'), 'delete')
  assert.equal(maintenanceAction('pin'), 'pin')
  assert.equal(maintenanceAction('bogus'), null)

  const assembled = assembleEditArgs(ids, inputBody)
  assert.equal(assembled.ok, true)
  assert.equal(assembled.args.action, 'text')
  assert.equal(assembled.args.slot.action, 'update')
  assert.deepEqual(assembled.args.short_memory, ids['short-memory'].body)
  assert.deepEqual(assembled.args.memory_store_refs, ids['memory-store'].refs)

  const cleared = clearMemoryEditSlots(inputBody)
  assert.equal(cleared.slots._main.kind, 'idle')
  assert.equal(cleared.slots.t1.kind, 'chat.message')
  assert.equal(inputBody.slots._main.kind, 'memory.edit', '不改入参')

  const maintenancePlan = {
    $directives: [
      {
        kind: 'write',
        request: {
          op: 'batch',
          args: {
            ops: [
              { op: 'put', args: { body: { tail: null, count: 2 } } },
              { op: 'add_gen', args: { id: 'memory-store', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
        },
      },
      { kind: 'extern', payload: { ok: true, kind: 'edit', action: 'text', layer: 'l3', id: 'm-1', text: 'beta' } },
    ],
  }
  assert.equal(planWriteOps(maintenancePlan).length, 2)
  assert.equal(planWriteOps({ $directives: [{ kind: 'extern', payload: {} }] }).length, 0)
  assert.deepEqual(planPayload(maintenancePlan), maintenancePlan.$directives[1].payload)
  assert.deepEqual(planPayload({ plain: 1 }), { plain: 1 })

  const maintenance = fakeModel({ ok: true, value: maintenancePlan })
  const handlers = createHandlers({ identity: 'ui-settings', model: maintenance, maintenance })
  const value = await handlers.edit({ ...ids, input: { body: inputBody } }, { run: null, thread: null, now: 0 })
  assert.deepEqual(maintenance.calls, [
    { port: 'memory-maintenance', method: 'edit', args: assembled.args },
  ])
  const ops = value.$directives[0].request.args.ops
  assert.equal(ops.length, 4, '#23 写子操作 2 条 + 清槽 put + add_gen')
  assert.deepEqual(ops[0], maintenancePlan.$directives[0].request.args.ops[0])
  assert.equal(ops[2].args.body.slots._main.kind, 'idle')
  assert.equal(ops[2].args.body.slots.t1.kind, 'chat.message')
  assert.equal(ops[3].args.id, 'input')
  assert.deepEqual(ops[3].args.payload, { $n: 2 })
  assert.deepEqual(value.$directives[1], { kind: 'extern', payload: maintenancePlan.$directives[1].payload })
})

test('memory.edit 缺槽 / 端口失败：仍出清槽计划并以 extern 收口', async () => {
  const ids = memoryIds()
  const inputBody = { slots: { _main: { kind: 'idle' } } }
  const maintenance = fakeModel({ ok: true, value: { $directives: [{ kind: 'extern', payload: { ok: true } }] } })
  const handlers = createHandlers({ identity: 'ui-settings', model: maintenance, maintenance })
  const missing = await handlers.edit({ ...ids, input: { body: inputBody } }, { run: null, thread: null, now: 0 })
  assert.equal(missing.$directives[0].request.args.ops.length, 2, '仅清槽 put + add_gen')
  assert.equal(missing.$directives[0].request.args.ops[0].args.body.slots._main.kind, 'idle')
  assert.equal(missing.$directives[1].payload.error.code, 'memory_edit_slot_missing')
  assert.equal(maintenance.calls.length, 0, '缺槽不发反向调用')

  const failIds = memoryIds()
  const failInput = { slots: { _main: { kind: 'memory.edit', action: 'delete', layer: 'l3', id: 'm-1' } } }
  const failed = fakeModel({ ok: false, code: 'transport_failed', message: 'x' })
  const failedHandlers = createHandlers({ identity: 'ui-settings', model: failed, maintenance: failed })
  const value = await failedHandlers.edit({ ...failIds, input: { body: failInput } }, { run: null, thread: null, now: 0 })
  assert.equal(value.$directives[0].request.args.ops[0].args.body.slots._main.kind, 'idle')
  assert.equal(value.$directives[1].payload.error.code, 'transport_failed')
})

// ---- 设置页纯函数 ----

test('tab 表与归一', () => {
  assert.equal(TABS.length, 7)
  assert.deepEqual(TABS.map((tab) => tab.id), ['general', 'model', 'plugins', 'skills', 'memory', 'orchestration', 'about'])
  assert.equal(normalizeTab('model'), 'model')
  assert.equal(normalizeTab('bogus'), 'general')
})

test('身份只读行 / 插件计数', () => {
  const ids = {
    config: { active: 'a'.repeat(64), gens: [{ seq: 0, payload: 'a'.repeat(64) }], pins: null },
    'loop-policy': { active: null, gens: [], pins: { sandbox: 's'.repeat(64) } },
  }
  const rows = identityRows(ids)
  assert.deepEqual(rows.map((row) => row.id), ['config', 'loop-policy'])
  assert.equal(rows[0].activeShort.length, 8)
  assert.equal(rows[1].retired, true)
  assert.deepEqual(rows[1].pins, { sandbox: 's'.repeat(64) })
  assert.equal(pluginCount(ids), 2)
  assert.deepEqual(identityRows(null), [])
})

test('技能清单读写', () => {
  assert.deepEqual(skillList(null), [])
  assert.deepEqual(skillList({ body: { version: 1, skills: [{ id: 'sk-1' }, null] } }), [{ id: 'sk-1' }])
  const body = { version: 1, skills: [] }
  const added = upsertSkill(body, { id: 'sk-1', name: 'A', enabled: true })
  assert.equal(added.skills.length, 1)
  assert.equal(body.skills.length, 0, '不改入参')
  const updated = upsertSkill(added, { id: 'sk-1', name: 'B', enabled: true })
  assert.equal(updated.skills.length, 1)
  assert.equal(updated.skills[0].name, 'B')
  const disabled = toggleSkill(updated, 'sk-1', false)
  assert.equal(disabled.skills[0].enabled, false)
  const removed = removeSkill(disabled, 'sk-1')
  assert.equal(removed.skills.length, 0)
})

test('技能表单 → 条目（触发字段 / scope）', () => {
  const skill = skillFromForm(
    { name: 'T', description: 'D', keywords: 'a, b  a', file_globs: '**/*.ts', explicit: '@x', scope_kind: 'workspace', workspace_id: 'w1', body: 'B', enabled: true },
    'sk-1',
    'now',
  )
  assert.deepEqual(skill.triggers.keywords, ['a', 'b'])
  assert.deepEqual(skill.triggers.file_globs, ['**/*.ts'])
  assert.deepEqual(skill.scope, { kind: 'workspace', workspace_id: 'w1' })
  assert.equal(skill.enabled, true)
  const global = skillFromForm({ scope_kind: 'workspace', workspace_id: '' }, 'sk-2', 'now')
  assert.deepEqual(global.scope, { kind: 'global' })
  assert.deepEqual(splitList('a，b  c'), ['a', 'b', 'c'])
  assert.deepEqual(splitList(undefined), [])
})

// ---- 厂商动作（编辑 / 密钥更新 / 获取模型）----

/** 最小假 ctx：只记录写入与命令调用，驱动 provider-actions 的纯动作。 */
function fakeProviderCtx(config) {
  const writes = []
  const calls = []
  const ctx = {
    state: { config, secrets: {}, savedKey: null, error: null, providerForm: { mode: 'edit' } },
    text: (code) => code,
    render: () => {},
    announce: () => {},
    writeConfig: async (body, key) => {
      writes.push({ body, key })
      ctx.state.config = body
      return { ok: true }
    },
    runCommand: async (name, args) => {
      calls.push({ name, args })
      if (name === 'secrets.status') return { ok: true, value: [{ name: 'K', has: true }] }
      if (name === 'config.read') return { ok: true, value: ctx.state.config }
      return { ok: true, value: { ok: true, changed: true } }
    },
    postJson: async (path, body) => ({ ok: true, body }),
  }
  return { ctx, writes, calls }
}

test('编辑：只改 base_url，密钥 / 模型与档案元数据原样保留', async () => {
  const entry = {
    name: 'DeepSeek',
    base_url: 'https://old/v1',
    auth_ref: { kind: 'env', name: 'K' },
    models: { a: { enabled: true, context_window: 1000 } },
  }
  const { ctx, writes } = fakeProviderCtx({ version: 1, providers: { deepseek: entry } })
  const form = { mode: 'edit', editKey: 'deepseek', base_url: 'https://new/v1', busy: false, error: null }
  assert.equal(await commitProviderEdit(ctx, form, 'deepseek'), true)
  const saved = ctx.state.config.providers.deepseek
  assert.equal(saved.base_url, 'https://new/v1')
  assert.deepEqual(saved.auth_ref, { kind: 'env', name: 'K' }, '密钥引用原样保留')
  assert.deepEqual(saved.models, { a: { enabled: true, context_window: 1000 } })
  assert.equal(writes[0].key, 'provider:deepseek')
  assert.equal(ctx.state.providerForm, null)
})

test('编辑：地址非法即拒，不写 config', async () => {
  const { ctx, writes } = fakeProviderCtx({ version: 1, providers: { deepseek: { base_url: 'https://old/v1' } } })
  const form = { mode: 'edit', editKey: 'deepseek', base_url: 'ftp://x', busy: false, error: null }
  assert.equal(await commitProviderEdit(ctx, form, 'deepseek'), false)
  assert.equal(writes.length, 0)
  assert.equal(form.error.code, 'settings_bad_url')
})

test('密钥更新：经入站 secrets.put 后刷新状态点，不落 state', async () => {
  const { ctx } = fakeProviderCtx({ version: 1, providers: {} })
  assert.equal(await saveProviderSecret(ctx, 'K', 'top-secret', 'provider:deepseek'), true)
  assert.equal(ctx.state.secrets.K, true)
  assert.equal(ctx.state.savedKey, 'provider:deepseek')
  assert.equal(JSON.stringify(ctx.state).includes('top-secret'), false, '密钥本体不得进 state')
})

/** 获取模型的假 ctx：记录 secrets.put / 写指令 / 命令调用。 */
function fakeFetchCtx(discover) {
  const puts = []
  const writes = []
  const calls = []
  const ctx = {
    state: {},
    text: (code) => code,
    render: () => {},
    threadKey: '_main',
    armLoadingNote: () => {},
    clearLoadingNote: () => {},
    postJson: async (path, body) => {
      puts.push({ path, body })
      return { ok: true }
    },
    readSlots: async () => ({ _main: { kind: 'idle' } }),
    applyWrite: async (directive) => {
      writes.push(directive)
      return { ok: true }
    },
    runCommand: async (name, args) => {
      calls.push({ name, args })
      if (name === 'model.discover') return discover
      return { ok: true, value: null }
    },
  }
  return { ctx, puts, writes, calls }
}

/** 获取模型表单（自定义 + 本地取值面）。 */
function fetchForm(overrides = {}) {
  return {
    mode: 'form',
    templateIdentity: 'custom',
    protocol: 'openai-chat',
    base_url: 'https://api.example.com/v1',
    auth_kind: 'local',
    auth_name: 'K',
    secret_value: 'top-secret',
    models: [],
    selected: [],
    error: null,
    loading: false,
    loadingNote: false,
    ...overrides,
  }
}

test('获取模型：本地取值面先落密钥，再写探测槽并发现（默认全勾选）', async () => {
  const { ctx, puts, writes, calls } = fakeFetchCtx({ ok: true, value: { ok: true, models: ['m1', 'm2'] } })
  const form = fetchForm()
  await fetchModels(ctx, form)
  assert.deepEqual(puts, [{ path: 'api/secrets/put', body: { name: 'K', value: 'top-secret' } }])
  assert.equal(writes.length, 1, '写一次探测槽')
  assert.ok(calls.some((call) => call.name === 'model.discover'))
  assert.deepEqual(form.models, ['m1', 'm2'])
  assert.deepEqual(form.selected, ['m1', 'm2'])
  assert.equal(form.error, null)
  assert.equal(form.loading, false)
})

test('获取模型：保留手填自定义 id；env 取值面不落本地密钥；密钥落盘失败即收口', async () => {
  const manualRun = fakeFetchCtx({ ok: true, value: { ok: true, models: ['m2'] } })
  const manualForm = fetchForm({ models: ['custom-x'], selected: ['custom-x'] })
  await fetchModels(manualRun.ctx, manualForm)
  assert.deepEqual(manualForm.models, ['custom-x', 'm2'], '手填 id 与发现结果合并')
  assert.deepEqual(manualForm.selected, ['custom-x', 'm2'])

  const envRun = fakeFetchCtx({ ok: true, value: { ok: true, models: ['m1'] } })
  await fetchModels(envRun.ctx, fetchForm({ auth_kind: 'env', secret_value: 'x' }))
  assert.deepEqual(envRun.puts, [], 'env 不写本地密钥')

  const failRun = fakeFetchCtx({ ok: true, value: { ok: true, models: ['m1'] } })
  failRun.ctx.postJson = async () => ({ ok: false, code: 'bad_directive' })
  const form = fetchForm()
  await fetchModels(failRun.ctx, form)
  assert.equal(form.error.code, 'settings_secret_failed')
  assert.equal(failRun.writes.length, 0, '密钥未落盘则不探测')
})

// ---- 文案 ----

test('文案表：解析 / 未知码兜底 / 共享表单源优先、本地仅骨架兜底', () => {
  const table = parseMessages('{"locale":"zh-CN","unknown_command":{"title":"未知命令","body":"没有这个命令"}}')
  assert.equal(table.unknown_command.body, '没有这个命令')
  assert.equal(parseMessages('not json'), null)
  assert.equal(lookupMessage(table, 'no_such').body.includes('no_such'), true)
  // 共享表（壳的单一文案来源）登记后，界面文案从其取用
  const shared = parseMessages(readFileSync(join(REPO_ROOT, 'plugins', 'ui-shell', 'execute', 'web', 'messages.v1.json'), 'utf8'))
  assert.ok(shared !== null, '共享文案表应可解析')
  assert.equal(lookupMessage(shared, 'settings_theme_day').body, '日间')
  assert.equal(lookupMessage(shared, 'settings_title').body, '设置')
  // 共享表不可用时回落本地骨架兜底
  assert.equal(lookupMessage(null, 'settings_title').body, UI_TEXT.settings_title)
  assert.equal(lookupMessage(null, 'settings_orch_scope').body.includes('settings_orch_scope'), true, '非骨架键落 unknown 兜底')
})

// ---- 入站桥 / 路由 / 端口 / 静态 ----

test('入站桥帧构造、回包解释与计划解包', () => {
  assert.deepEqual(commandFrame('i', 'model.vendors', null, { thread: 't' }), {
    v: '1',
    id: 'i',
    kind: 'command',
    name: 'model.vendors',
    args: null,
    thread: 't',
  })
  assert.equal(submitFrame('i', []).kind, 'submit')
  const error = interpretResponse({ ok: true, frame: { kind: 'error', code: 'unknown_command', message: 'x' }, code: '', message: '' })
  assert.equal(error.ok, false)
  assert.equal(error.code, 'unknown_command')
  const ok = interpretResponse({
    ok: true,
    frame: { kind: 'result', observations: [{ kind: 'eval', ok: true, value: { $directives: [{ kind: 'extern', payload: { ok: true, changed: true } }] } }] },
    code: '',
    message: '',
  })
  assert.deepEqual(extractValue(ok.frame), { ok: true, changed: true })
  assert.deepEqual(unwrapPlan({ plain: 1 }), { plain: 1 })
})

test('路由判定：静态 / api 动词门禁；/events 已并入壳总线', () => {
  assert.deepEqual(routeOf('GET', '/entry.js'), { kind: 'entry' })
  assert.deepEqual(routeOf('GET', '/config-model.js'), { kind: 'web', name: 'config-model.js' })
  assert.equal(routeOf('POST', '/entry.js').kind, 'not-found')
  assert.equal(routeOf('GET', '/events').kind, 'not-found')
  assert.equal(routeOf('GET', '/api/state').kind, 'not-found')
  assert.equal(routeOf('POST', '/api/command').kind, 'api-command')
  assert.equal(routeOf('POST', '/api/submit').kind, 'api-submit')
  assert.equal(routeOf('POST', '/api/secrets/put').kind, 'api-secrets-put')
  assert.equal(routeOf('POST', '/api/secrets/delete').kind, 'api-secrets-delete')
  assert.equal(routeOf('GET', '/api/command').kind, 'not-found')
  assert.equal(routeOf('GET', '/../plugin.json').kind, 'not-found')
})

test('端口推导与静态白名单', () => {
  assert.equal(DEFAULT_SETTINGS_PORT, 8792)
  assert.equal(resolvePort({}), 8792)
  assert.equal(resolvePort({ CHRONO_UI_PORT_UI_SETTINGS: '9001' }), 9001)
  assert.equal(resolvePort({ CHRONO_UI_PORT_UI_SETTINGS: '0' }), 8792)
  assert.equal(parsePort('70000'), null)
  assert.equal(WEB_FILE_RE.test('entry.js'), true)
  assert.equal(WEB_FILE_RE.test('../x.js'), false)
  assert.equal(readWebFile(WEB, 'entry.js').includes('export async function mount'), true)
  assert.equal(readWebFile(WEB, 'nope.js'), null)
  assert.equal(readWebFile(WEB, '../plugin.json'), null)
})

// ---- 服务协议级 ----

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

test('服务协议级：hello → manifest，ping，probe，drain → bye', async () => {
  const root = tempDir('service')
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-settings'),
      CHRONO_UI_PORT_UI_SETTINGS: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = createDecoder()
  const messages = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      messages.push(message)
      for (const waiter of [...waiters]) waiter()
    }
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  function waitFor(predicate, label, timeoutMs = 10000) {
    return new Promise((resolveWait, rejectWait) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        if (predicate()) {
          resolveWait()
          return
        }
        if (Date.now() > deadline) {
          rejectWait(new Error(`timeout waiting ${label}; stderr=${stderr.join('')}`))
          return
        }
        const waiter = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          check()
        }
        waiters.push(waiter)
        setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          check()
        }, 50).unref?.()
      }
      check()
    })
  }

  try {
    child.stdin.write(encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'ui-settings', gen: 'g' }))
    await waitFor(() => messages.some((message) => message.kind === 'manifest'), 'manifest')
    const manifest = messages.find((message) => message.kind === 'manifest')
    assert.equal(manifest.identity, 'ui-settings')
    assert.deepEqual(manifest.implements, ['ui-settings'])
    assert.deepEqual(manifest.methods, { 'ui-settings': ['ping', 'vendors', 'profile', 'discover', 'health', 'view', 'search', 'edit'] })
    assert.equal(manifest.v, '1')
    assert.equal(manifest.protocol, '1')

    child.stdin.write(encodeFrame({ v: '1', id: 'c1', kind: 'call', port: 'ui-settings', method: 'ping', args: {} }))
    await waitFor(() => messages.some((message) => message.id === 'c1'), 'ping result')
    assert.equal(messages.find((message) => message.id === 'c1').value.pong, true)

    child.stdin.write(encodeFrame({ v: '1', id: 'p1', kind: 'probe' }))
    await waitFor(() => messages.some((message) => message.id === 'p1'), 'pong')
    assert.equal(messages.find((message) => message.id === 'p1').kind, 'pong')

    // 服务侧装配 + 反向调用：vendors 方法发 port.call model.vendors，回包后返回 extern 计划。
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'v1',
        kind: 'call',
        port: 'ui-settings',
        method: 'vendors',
        args: { 'vendor-deepseek': { body: { sdk: 'deepseek' } } },
      }),
    )
    await waitFor(() => messages.some((message) => message.kind === 'port.call'), 'port.call')
    const portCall = messages.find((message) => message.kind === 'port.call')
    assert.equal(portCall.port, 'model')
    assert.equal(portCall.method, 'vendors')
    assert.deepEqual(portCall.args, { vendors: [{ identity: 'vendor-deepseek', body: { sdk: 'deepseek' } }] })
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: portCall.id,
        kind: 'port.result',
        ok: true,
        value: { ok: true, vendors: [{ identity: 'vendor-deepseek' }] },
      }),
    )
    await waitFor(() => messages.some((message) => message.id === 'v1'), 'vendors result')
    assert.deepEqual(messages.find((message) => message.id === 'v1').value, {
      $directives: [{ kind: 'extern', payload: { ok: true, vendors: [{ identity: 'vendor-deepseek' }] } }],
    })

    // health 直接回结构化判定（无反向调用）。
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'h2',
        kind: 'call',
        port: 'ui-settings',
        method: 'health',
        args: { evolution: { body: { trace: { tail: null, count: 0 } } } },
      }),
    )
    await waitFor(() => messages.some((message) => message.id === 'h2'), 'health result')
    const healthValue = messages.find((message) => message.id === 'h2').value
    assert.equal(healthValue.status, 'ok')
    assert.equal(healthValue.consecutive_refused, 0)
    assert.equal(healthValue.threshold_source, 'default')

    // 在途调用与 drain 连发：drain 必须等在途调用收口后才发 bye（协议 §2.3）。
    child.stdin.write(encodeFrame({ v: '1', id: 'c2', kind: 'call', port: 'ui-settings', method: 'ping', args: {} }))
    child.stdin.write(encodeFrame({ v: '1', id: 'd1', kind: 'drain', deadline_ms: 100 }))
    await waitFor(() => messages.some((message) => message.id === 'd1'), 'bye')
    assert.equal(messages.find((message) => message.id === 'd1').kind, 'bye')
    assert.ok(
      messages.findIndex((message) => message.id === 'c2') < messages.findIndex((message) => message.id === 'd1'),
      '在途调用结果应先于 bye',
    )
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  } finally {
    if (child.exitCode === null) child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})

test('服务 EOF 自退出', async () => {
  const root = tempDir('eof')
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-settings'),
      CHRONO_UI_PORT_UI_SETTINGS: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exit = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.stdin.end()
  const code = await Promise.race([
    exit,
    new Promise((_, reject) => setTimeout(() => reject(new Error('service did not exit on EOF')), 8000)),
  ])
  assert.equal(typeof code, 'number')
  rmSync(root, { recursive: true, force: true })
})

// ---- 入口契约 ----

test('entry.js 导出 mount 且返回 unmount（模块可导入）', async () => {
  const module = await import(pathToFileURL(join(WEB, 'entry.js')).href)
  assert.equal(module.contract, '1')
  assert.equal(typeof module.mount, 'function')
  assert.ok(module.mount.length >= 2)
})
