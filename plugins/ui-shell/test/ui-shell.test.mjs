// `ui-shell` 协议级 / 单元测试（node --test）。
// 覆盖：入站桥帧构造与回包解析、SSE 事件重播、挂载表默认与端口覆盖、/p/<id>/* 两条判定路径、
// uiState 广播、无配置判据、toast 队列、静态资源降级、主题首帧脚本、文案表覆盖、资源静态校验，
// 以及服务协议级握手 / ping / probe / drain。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  assetPutFrame,
  Bridge,
  cancelFrame,
  commandFrame,
  deriveBootMode,
  extractValue,
  forwardFrame,
  interpretResponse,
  submitFrame,
} from '../execute/bridge.ts'
import { syntheticEventsFor, encodeSseRecord, SseHub, shellStateRecord, SHELL_IMPL } from '../execute/sse.ts'
import {
  applyOverrides,
  DEFAULT_HEADLESS,
  DEFAULT_MOUNTS,
  ensureHeadless,
  ensureMounts,
  findMount,
  isSafeHeadlessEntry,
  normalizeHeadless,
  normalizePortEnvKey,
  overridePort,
  parseHeadless,
  parseMounts,
} from '../execute/mounts.ts'
import { buildForwardArgs, forwardCommandName, routeOf } from '../execute/routes.ts'
import { identityInvalidatesHeadless } from '../execute/identity-events.ts'
import { createUiState, UI_STATE_KEYS } from '../execute/web/lib/ui-state.js'
import { createToastQueue, roleForTone, TOAST_DURATIONS, TOAST_MAX_VISIBLE } from '../execute/web/lib/toast.js'
import {
  EMPTY_SPRITE,
  loadFavicon,
  loadIcons,
  loadTokens,
  MINIMAL_TOKENS,
  webDirOf,
} from '../execute/assets.ts'
import { FALLBACK_MESSAGES, loadMessages, lookupMessage, MESSAGE_ALIASES, MESSAGE_PREFIXES, missingPrefixes, parseMessages } from '../execute/messages.ts'
import { BOOTSTRAP_PLACEHOLDER, directivesTouchConfig, injectBootstrap, startUiServer, themeWriteDirective } from '../execute/http-server.ts'
import {
  firstFrameScript,
  injectThemeScript,
  normalizeThemePref,
  resolveTheme,
  THEME_PLACEHOLDER,
  themePrefOfConfig,
  toConfigTheme,
} from '../execute/theme.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const WEB_DIR = webDirOf()

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `chrono-ui-shell-${label}-`))
}

// ---- 入站桥：帧构造与回包解析 ----

test('submit/command/forward/asset/cancel 帧形状', () => {
  const submit = submitFrame('i1', [{ kind: 'extern', payload: { a: 1 } }], { thread: 't1' })
  assert.equal(submit.v, '1')
  assert.equal(submit.kind, 'submit')
  assert.equal(submit.id, 'i1')
  assert.equal(submit.thread, 't1')
  assert.deepEqual(submit.directives, [{ kind: 'extern', payload: { a: 1 } }])

  const command = commandFrame('i2', 'config.read', null, { thread: 't1' })
  assert.equal(command.kind, 'command')
  assert.equal(command.name, 'config.read')
  assert.equal(command.args, null)
  assert.equal(command.thread, 't1')

  const forward = forwardFrame('i3', 'mcp', 'mcp.discover', { q: 'x' })
  assert.equal(forward.kind, 'forward')
  assert.equal(forward.identity, 'mcp')
  assert.equal(forward.command, 'mcp.discover')
  assert.deepEqual(forward.args, { q: 'x' })
  assert.equal('thread' in forward, false)

  const put = assetPutFrame('i4', 'image/png', 'AAAA')
  assert.deepEqual(put, { v: '1', id: 'i4', kind: 'asset.put', mime: 'image/png', bytes: 'AAAA' })

  const cancel = cancelFrame('i5', 'run-1')
  assert.deepEqual(cancel, { v: '1', id: 'i5', kind: 'cancel', run: 'run-1' })
})

test('回包解释：通道失败 / error 帧 / 正常回帧', () => {
  const failed = interpretResponse({ ok: false, frame: null, code: 'ui_unreachable', message: 'down' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'ui_unreachable')

  const errored = interpretResponse({
    ok: true,
    frame: { kind: 'error', code: 'unknown_command', message: 'nope' },
    code: '',
    message: '',
  })
  assert.equal(errored.ok, false)
  assert.equal(errored.code, 'unknown_command')

  const okFrame = { kind: 'result', id: 'i', status: 'done', observations: [] }
  const ok = interpretResponse({ ok: true, frame: okFrame, code: '', message: '' })
  assert.equal(ok.ok, true)
  assert.equal(ok.frame, okFrame)
})

test('extractValue：eval 观测的 value / extern 观测的 payload', () => {
  assert.deepEqual(
    extractValue({ observations: [{ kind: 'eval', ok: true, value: { vendor: 'x' } }] }),
    { vendor: 'x' },
  )
  assert.deepEqual(extractValue({ observations: [{ kind: 'extern', payload: 7 }] }), 7)
  assert.equal(extractValue({ observations: [{ kind: 'refused', reasons: [] }] }), null)
  assert.equal(extractValue(null), null)
})

test('Bridge：命令回包取值 / configRead / submit accepted', async () => {
  const sent = []
  const responses = [
    { ok: true, frame: { kind: 'result', id: 'x', status: 'done', observations: [{ kind: 'eval', ok: true, value: { vendor: 'deepseek' } }] } },
    { ok: true, frame: { kind: 'accepted', id: 'y', run: 'run-9' } },
    { ok: true, frame: { kind: 'accepted', id: 'z' } },
  ]
  const transport = {
    isConnected: () => true,
    request: async (frame) => {
      sent.push(frame)
      return responses.shift() ?? { ok: true, frame: { kind: 'result', id: frame.id, status: 'done', observations: [] }, code: '', message: '' }
    },
  }
  const bridge = new Bridge(transport)
  const read = await bridge.configRead()
  assert.equal(read.ok, true)
  assert.deepEqual(read.value, { vendor: 'deepseek' })
  assert.equal(sent[0].kind, 'command')
  assert.equal(sent[0].name, 'config.read')

  const submitted = await bridge.submit([{ kind: 'extern', payload: null }])
  assert.equal(submitted.ok, true)
  assert.equal(submitted.frame.run, 'run-9')

  const cancelled = await bridge.cancel('run-9')
  assert.equal(cancelled.ok, true)
  assert.equal(sent[2].kind, 'cancel')
})

test('无配置判据：config.read 返回值里有没有已启用模型条目', () => {
  assert.equal(deriveBootMode({ providers: { deepseek: { models: { a: { enabled: true } } } } }), 'ready')
  assert.equal(deriveBootMode({ providers: { deepseek: { models: { a: {} } } } }), 'ready', '缺 enabled 视为启用')
  assert.equal(deriveBootMode({ providers: { deepseek: { models: { a: { enabled: false } } } } }), 'onboarding')
  assert.equal(deriveBootMode({ providers: { deepseek: { models: {} } } }), 'onboarding')
  assert.equal(deriveBootMode({ providers: {} }), 'onboarding')
  assert.equal(deriveBootMode({ vendor: 'deepseek' }), 'onboarding', '只写 vendor 不算已配置')
  assert.equal(deriveBootMode({}), 'onboarding')
  assert.equal(deriveBootMode(null), 'onboarding')
  assert.equal(deriveBootMode({ tree: 'x', meta: {} }), 'onboarding')
})

// ---- SSE ----

test('SSE 记录编码与壳合成事件', () => {
  assert.equal(
    encodeSseRecord({ impl: 'host', topic: 'run.started', payload: { run: 'r' } }),
    'data: {"impl":"host","topic":"run.started","payload":{"run":"r"}}\n\n',
  )
  assert.equal(syntheticEventsFor(true, false, false)[0].topic, 'shell.disconnected')
  assert.equal(syntheticEventsFor(false, true, true)[0].topic, 'shell.reconnected')
  assert.deepEqual(syntheticEventsFor(false, true, false), [])
  assert.deepEqual(syntheticEventsFor(true, true, false), [])
})

test('SSE 广播：宿主事件原样重播 + 壳状态 / 合成事件', () => {
  const hub = new SseHub()
  const chunks = []
  hub.add({ write: (chunk) => chunks.push(chunk) })
  hub.hostEvent('model-protocol', 'model.delta', { run: 'r', thread: 't', text: 'hi' })
  hub.connectionChanged(true, false, 'dark', false)
  hub.connectionChanged(false, true, 'dark', true)
  const records = chunks.map((chunk) => JSON.parse(chunk.slice('data: '.length)))
  assert.deepEqual(records[0], { impl: 'model-protocol', topic: 'model.delta', payload: { run: 'r', thread: 't', text: 'hi' } })
  assert.equal(records[1].topic, 'shell.disconnected')
  assert.deepEqual(records[2], shellStateRecord(false, 'dark'))
  assert.equal(records[3].topic, 'shell.reconnected')
  assert.equal(records[4].topic, 'shell.state')
  assert.equal(hub.count(), 1)
})

// ---- 挂载表 ----

test('挂载表默认值与端口覆盖', () => {
  assert.equal(DEFAULT_MOUNTS.length, 6)
  assert.deepEqual(
    DEFAULT_MOUNTS.map((entry) => [entry.id, entry.slot, entry.port]),
    [
      ['ui-sidebar', 'sidebar', 8791],
      ['ui-chat', 'main', 8788],
      ['ui-approval', 'dock', 8789],
      ['ui-composer', 'composer', 8790],
      ['ui-threads', 'topbar', 8793],
      ['ui-settings', 'overlay', 8792],
    ],
  )
  assert.equal(normalizePortEnvKey('ui-chat'), 'CHRONO_UI_PORT_UI_CHAT')
  assert.equal(overridePort('ui-chat', { CHRONO_UI_PORT_UI_CHAT: '9001' }), 9001)
  assert.equal(overridePort('ui-chat', { 'CHRONO_UI_PORT_ui-chat': '9002' }), 9002)
  assert.equal(overridePort('ui-chat', { CHRONO_UI_PORT_UI_CHAT: '0' }), null)
  assert.equal(overridePort('ui-chat', {}), null)
  const overridden = applyOverrides(DEFAULT_MOUNTS, { CHRONO_UI_PORT_UI_CHAT: '9100' })
  assert.equal(findMount(overridden, 'ui-chat').port, 9100)
  assert.equal(findMount(overridden, 'ui-main-missing'), null)
})

test('挂载表：启动无表生成默认、坏表回落默认、有表读表', () => {
  const stateDir = tempDir('mounts')
  try {
    const first = ensureMounts(stateDir, {})
    assert.equal(first.created, true)
    assert.equal(first.mounts.length, 6)
    assert.equal(existsSync(join(stateDir, 'ui-mounts.json')), true)

    const second = ensureMounts(stateDir, { CHRONO_UI_PORT_UI_CHAT: '9300' })
    assert.equal(second.created, false)
    assert.equal(findMount(second.mounts, 'ui-chat').port, 9300)

    writeFileSync(join(stateDir, 'ui-mounts.json'), '{ not json')
    const third = ensureMounts(stateDir, {})
    assert.equal(third.created, true)
    assert.equal(third.mounts.length, 6)

    assert.equal(parseMounts('[{"id":"a","path":"/p/a/","slot":"main","port":1}]').length, 1)
    assert.equal(parseMounts('[{"id":"a","path":"p/a","slot":"main","port":1}]'), null)
    assert.equal(parseMounts('[{"id":"a","path":"/p/a/","slot":"main","port":0}]'), null)
    assert.equal(parseMounts('[]'), null)

    const headless = ensureHeadless(stateDir)
    assert.equal(headless.created, true)
    assert.deepEqual(headless.headless, DEFAULT_HEADLESS)
    assert.deepEqual(parseHeadless('[{"id":"x","entry":"execute/entry.js"}]'), [
      { id: 'x', entry: 'execute/entry.js' },
    ])
    assert.equal(parseHeadless('[{"id":"x"}]'), null)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ---- headless 入口路径与坏值回落 ----

test('headless 默认入口住 web/、旧路径迁移、坏值回落默认并重写', () => {
  assert.deepEqual(DEFAULT_HEADLESS, [{ id: 'ui-notify', entry: 'web/entry.js' }])
  assert.equal(isSafeHeadlessEntry('web/entry.js'), true)
  assert.equal(isSafeHeadlessEntry('execute/entry.js'), true)
  assert.equal(isSafeHeadlessEntry(''), false)
  assert.equal(isSafeHeadlessEntry('/abs.js'), false)
  assert.equal(isSafeHeadlessEntry('C:/x.js'), false)
  assert.equal(isSafeHeadlessEntry('../x.js'), false)
  assert.equal(isSafeHeadlessEntry('a\\b.js'), false)
  assert.equal(isSafeHeadlessEntry('web/entry'), false)

  assert.deepEqual(normalizeHeadless([{ id: 'ui-notify', entry: 'execute/entry.js' }]), {
    headless: [{ id: 'ui-notify', entry: 'web/entry.js' }],
    changed: true,
  })
  assert.deepEqual(normalizeHeadless([{ id: 'ui-notify', entry: 'web/entry.js' }]), {
    headless: [{ id: 'ui-notify', entry: 'web/entry.js' }],
    changed: false,
  })
  assert.deepEqual(normalizeHeadless([]), { headless: DEFAULT_HEADLESS, changed: true })

  const stateDir = tempDir('headless')
  try {
    // 已持久化的旧路径：加载即迁移并重写
    writeFileSync(
      join(stateDir, 'ui-headless.json'),
      JSON.stringify([{ id: 'ui-notify', entry: 'execute/entry.js' }]),
    )
    const migrated = ensureHeadless(stateDir)
    assert.deepEqual(migrated.headless, [{ id: 'ui-notify', entry: 'web/entry.js' }])
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'ui-headless.json'), 'utf8')), [
      { id: 'ui-notify', entry: 'web/entry.js' },
    ])

    // 坏表（形态非法）：回落默认并重写
    writeFileSync(join(stateDir, 'ui-headless.json'), JSON.stringify([{ id: 'ui-notify', entry: '../x.js' }]))
    const bad = ensureHeadless(stateDir)
    assert.deepEqual(bad.headless, DEFAULT_HEADLESS)
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'ui-headless.json'), 'utf8')), DEFAULT_HEADLESS)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ---- identity.changed：headless 字节失效判定 ----

test('identity.changed：仅 code 世代且身份在 headless 清单内才失效重取', () => {
  const ids = new Set(['ui-notify', 'ui-other'])
  assert.equal(
    identityInvalidatesHeadless({ identity: 'ui-notify', kind: 'code', active: 'g2', prev: 'g1' }, ids),
    'ui-notify',
  )
  // data 世代变化不失效
  assert.equal(
    identityInvalidatesHeadless({ identity: 'ui-notify', kind: 'data', active: 'g2', prev: 'g1' }, ids),
    null,
  )
  // 非 headless 身份不失效
  assert.equal(
    identityInvalidatesHeadless({ identity: 'ui-chat', kind: 'code', active: 'g2', prev: 'g1' }, ids),
    null,
  )
  assert.equal(identityInvalidatesHeadless({ identity: '', kind: 'code' }, ids), null)
  assert.equal(identityInvalidatesHeadless({ kind: 'code' }, ids), null)
  assert.equal(identityInvalidatesHeadless({ identity: 'ui-notify', kind: 'bogus' }, ids), null)
  assert.equal(identityInvalidatesHeadless({ identity: 'ui-notify' }, ids), null)
  assert.equal(identityInvalidatesHeadless(null, ids), null)
  assert.equal(identityInvalidatesHeadless('nope', ids), null)
  assert.equal(identityInvalidatesHeadless([{ identity: 'ui-notify', kind: 'code' }], ids), null)
})

// ---- /p/<id>/* 两条判定路径 ----

test('路由：表内反代 vs 表外 forward', () => {
  const proxy = routeOf('GET', '/p/ui-chat/entry.js', DEFAULT_MOUNTS)
  assert.deepEqual(proxy, { kind: 'proxy', id: 'ui-chat', rest: 'entry.js' })
  const forward = routeOf('GET', '/p/mcp/discover', DEFAULT_MOUNTS)
  assert.deepEqual(forward, { kind: 'forward', id: 'mcp', rest: 'discover' })
  const proxyApi = routeOf('POST', '/p/ui-chat/api/foo', DEFAULT_MOUNTS)
  assert.deepEqual(proxyApi, { kind: 'proxy', id: 'ui-chat', rest: 'api/foo' })
})

test('路由：页面 / 静态 / 事件 / api 动词门禁', () => {
  assert.equal(routeOf('GET', '/', []).kind, 'shell-page')
  assert.deepEqual(routeOf('GET', '/assets/tokens.v1.css', []), { kind: 'asset', name: 'tokens.v1.css' })
  assert.deepEqual(routeOf('GET', '/assets/icons.v2.svg', []), { kind: 'asset', name: 'icons.v2.svg' })
  assert.deepEqual(routeOf('GET', '/assets/messages.v1.json', []), { kind: 'asset', name: 'messages.v1.json' })
  assert.deepEqual(routeOf('GET', '/favicon.svg', []), { kind: 'asset', name: 'favicon.svg' })
  assert.deepEqual(routeOf('GET', '/assets/lib/toast.js', []), { kind: 'lib', name: 'toast.js' })
  assert.deepEqual(routeOf('GET', '/assets/headless/ui-notify.js', []), { kind: 'headless', id: 'ui-notify' })
  assert.equal(routeOf('GET', '/events', []).kind, 'events')
  assert.equal(routeOf('POST', '/api/theme', []).kind, 'api-theme')
  assert.equal(routeOf('POST', '/api/submit', []).kind, 'api-submit')
  assert.equal(routeOf('POST', '/api/command', []).kind, 'api-command')
  assert.equal(routeOf('POST', '/api/asset', []).kind, 'api-asset-put')
  assert.equal(routeOf('GET', '/api/asset', []).kind, 'api-asset-get')
  assert.equal(routeOf('POST', '/api/cancel', []).kind, 'api-cancel')
  assert.equal(routeOf('GET', '/api/state', []).kind, 'api-state')
  assert.equal(routeOf('GET', '/api/theme', []).kind, 'not-found')
  assert.equal(routeOf('GET', '/assets/lib/../secret.js', []).kind, 'not-found')
  assert.equal(routeOf('GET', '/nope', []).kind, 'not-found')
})

test('forward 命令名映射与 args 构造', () => {
  assert.equal(forwardCommandName('mcp', 'discover'), 'mcp.discover')
  assert.equal(forwardCommandName('mcp', 'mcp.discover'), 'mcp.discover')
  assert.equal(forwardCommandName('mcp', 'tools/list'), 'mcp.tools.list')
  assert.equal(forwardCommandName('mcp', ''), null)

  assert.deepEqual(buildForwardArgs('GET', new URLSearchParams('a=1&b=2'), null), { a: '1', b: '2' })
  assert.deepEqual(buildForwardArgs('POST', new URLSearchParams(), { args: 1 }), { args: 1 })
  assert.equal(buildForwardArgs('POST', new URLSearchParams('a=1'), null), null)
})

// ---- uiState ----

test('uiState：三键、广播、退订、刷新即丢', () => {
  assert.deepEqual(UI_STATE_KEYS, ['active_thread', 'boot_mode', 'settings_open'])
  const state = createUiState()
  const seen = []
  const off = state.subscribe('active_thread', (value) => seen.push(value))
  state.set('active_thread', 't1')
  state.set('active_thread', 't2')
  off()
  state.set('active_thread', 't3')
  assert.deepEqual(seen, ['t1', 't2'])
  assert.equal(state.get('active_thread'), 't3')
  assert.equal(state.has('boot_mode'), false)
  state.set('boot_mode', 'onboarding')
  state.set('settings_open', true)
  assert.deepEqual(state.snapshot(), { active_thread: 't3', boot_mode: 'onboarding', settings_open: true })
  // 刷新即丢：新 store 全空
  const fresh = createUiState()
  assert.equal(fresh.get('active_thread'), undefined)
})

test('uiState：未登记键告警并忽略（新增键须先登记）', () => {
  const state = createUiState()
  const original = console.warn
  const warned = []
  console.warn = (line) => warned.push(line)
  try {
    assert.equal(state.set('nope', 1), false)
  } finally {
    console.warn = original
  }
  assert.equal(state.has('nope'), false)
  assert.equal(state.get('nope'), undefined)
  assert.ok(warned.some((line) => line.includes('nope')), '应告警未登记键')
  assert.equal(state.set('boot_mode', 'ready'), true)
})

// ---- 主题写指令防护 ----

test('themeWriteDirective：tree 形态拒写、落 config 用 day/night 词表', () => {
  assert.equal(themeWriteDirective('dark', { tree: 'abc' }), null)
  assert.equal(themeWriteDirective('dark', 'nope'), null)
  const directive = themeWriteDirective('dark', { vendor: 'x', ui: { theme: 'day', other: 1 } })
  const body = directive.request.args.ops[0].args.body
  assert.equal(body.vendor, 'x')
  assert.equal(body.ui.theme, 'night')
  assert.equal(body.ui.other, 1)
  assert.equal(directive.request.args.ops[1].args.id, 'config')
  // 无配置：从空 body 起写
  const fresh = themeWriteDirective('light', null)
  assert.deepEqual(fresh.request.args.ops[0].args.body, { ui: { theme: 'day' } })
  assert.equal(themeWriteDirective('system', null).request.args.ops[0].args.body.ui.theme, 'system')
})

test('directivesTouchConfig：仅 config 身份的 add_gen 命中', () => {
  const configWrite = {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body: { vendor: 'x' } } },
          { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
        ],
      },
    },
  }
  const inputWrite = {
    kind: 'write',
    request: { op: 'batch', args: { ops: [{ op: 'add_gen', args: { id: 'input' } }] } },
  }
  assert.equal(directivesTouchConfig([configWrite]), true)
  assert.equal(directivesTouchConfig([{ kind: 'extern', payload: { a: 1 } }]), false)
  assert.equal(directivesTouchConfig([inputWrite]), false)
  assert.equal(directivesTouchConfig([]), false)
  assert.equal(directivesTouchConfig(null), false)
})

// ---- toast ----

test('toast：上限 3 / 排队 / 时长 / 带动作不自动消失 / hover 暂停', () => {
  let clock = 0
  const toasts = createToastQueue({ now: () => clock })
  assert.equal(TOAST_MAX_VISIBLE, 3)
  assert.deepEqual(TOAST_DURATIONS, { info: 2500, success: 2500, warning: 4000, danger: 4000 })

  const info = toasts.enqueue({ tone: 'info', text: 'a' })
  const success = toasts.enqueue({ tone: 'success', text: 'b' })
  const warning = toasts.enqueue({ tone: 'warning', text: 'c' })
  const danger = toasts.enqueue({ tone: 'danger', text: 'd' })
  assert.equal(toasts.visible().length, 3)
  assert.equal(toasts.queued().length, 1)
  assert.equal(toasts.visible()[0].id, info)

  // info / success 2.5s 到期；danger 补位
  clock = 2500
  toasts.tick(clock)
  assert.equal(toasts.visible().some((item) => item.id === info), false)
  assert.equal(toasts.visible().some((item) => item.id === success), false)
  assert.equal(toasts.queued().length, 0)
  assert.equal(toasts.visible().length, 2)

  // warning 4s 到期
  clock = 4000
  toasts.tick(clock)
  assert.equal(toasts.visible().some((item) => item.id === warning), false)
  assert.equal(toasts.visible().length, 1)
  assert.equal(toasts.visible()[0].id, danger)

  // danger 4s 后到期（提升时刻 2500 + 4000 = 6500）
  clock = 6500
  toasts.tick(clock)
  assert.equal(toasts.visibleCount(), 0)

  // 带动作：不自动消失
  const sticky = toasts.enqueue({ tone: 'info', text: 'undo', action: '撤销' })
  assert.equal(toasts.all().find((item) => item.id === sticky).durationMs, null)
  clock += 60_000
  toasts.tick(clock)
  assert.ok(toasts.all().some((item) => item.id === sticky), '带动作的 toast 不应自动消失')
  assert.equal(toasts.dismiss(sticky), true)

  // hover 暂停：暂停期间不消失，恢复后顺延
  const hovered = toasts.enqueue({ tone: 'info', text: 'hover' })
  toasts.hover(hovered, true)
  clock += 10_000
  toasts.tick(clock)
  assert.ok(toasts.all().some((item) => item.id === hovered))
  toasts.hover(hovered, false)
  clock += 2600
  toasts.tick(clock)
  assert.equal(toasts.all().some((item) => item.id === hovered), false)

  // 关闭可见项会提升排队项
  const queueA = toasts.enqueue({ tone: 'info', text: 'q1' })
  const queueB = toasts.enqueue({ tone: 'info', text: 'q2' })
  const queueC = toasts.enqueue({ tone: 'info', text: 'q3' })
  const queueD = toasts.enqueue({ tone: 'info', text: 'q4' })
  assert.equal(toasts.queued().length, 1)
  toasts.dismiss(queueA)
  assert.equal(toasts.queued().length, 0)
  assert.ok(toasts.visible().some((item) => item.id === queueD))
  for (const id of [queueB, queueC, queueD]) toasts.dismiss(id)
  assert.equal(toasts.visibleCount(), 0)
})

test('toast aria-live：info/success = status，warning/danger = alert', () => {
  assert.equal(roleForTone('info'), 'status')
  assert.equal(roleForTone('success'), 'status')
  assert.equal(roleForTone('warning'), 'alert')
  assert.equal(roleForTone('danger'), 'alert')
})

// ---- 静态资源降级 ----

test('静态资源降级三路', () => {
  const missing = join(tempDir('assets'), 'nope')
  const tokens = loadTokens(missing)
  assert.equal(tokens.fallback, true)
  assert.match(tokens.text, /--c-bg/)
  assert.match(tokens.text, /--c-surface/)
  assert.match(tokens.text, /--c-text/)
  assert.match(tokens.text, /--c-border/)

  const icons = loadIcons(missing)
  assert.equal(icons.fallback, true)
  assert.equal(icons.text, EMPTY_SPRITE)

  const messages = loadMessages(missing)
  assert.equal(messages.fallback, true)
  assert.equal(typeof messages.table.unknown.title, 'string')
  assert.equal(
    lookupMessage(messages.table, 'ui_unreachable').title,
    FALLBACK_MESSAGES.ui_unreachable.title,
  )

  const favicon = loadFavicon(missing)
  assert.equal(favicon.fallback, true)

  // 真实包内资源：不降级
  assert.equal(loadTokens(WEB_DIR).fallback, false)
  assert.equal(loadIcons(WEB_DIR).fallback, false)
  assert.equal(loadMessages(WEB_DIR).fallback, false)
})

// ---- 主题 ----

test('主题解析与首帧脚本', () => {
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(normalizeThemePref('bogus'), 'system')
  assert.equal(normalizeThemePref('day'), 'light')
  assert.equal(normalizeThemePref('night'), 'dark')
  assert.equal(themePrefOfConfig({ ui: { theme: 'day' } }), 'light')
  assert.equal(themePrefOfConfig({ ui: { theme: 'night' } }), 'dark')
  assert.equal(themePrefOfConfig({ ui: { theme: 'dark' } }), 'dark')
  assert.equal(themePrefOfConfig({}), 'system')

  // config 存储词表：light→day / dark→night / system→system；未知回落 system
  assert.equal(toConfigTheme('light'), 'day')
  assert.equal(toConfigTheme('dark'), 'night')
  assert.equal(toConfigTheme('system'), 'system')
  assert.equal(toConfigTheme('bogus'), 'system')
  // 往返：落 config 后再读回 DOM 词表
  assert.equal(themePrefOfConfig({ ui: { theme: toConfigTheme('dark') } }), 'dark')
  assert.equal(themePrefOfConfig({ ui: { theme: toConfigTheme('light') } }), 'light')

  function run(pref, prefersDark) {
    let written = null
    const fakeWindow = {
      matchMedia: () => ({ matches: prefersDark }),
    }
    const fakeDocument = {
      documentElement: {
        setAttribute: (name, value) => {
          if (name === 'data-theme') written = value
        },
      },
    }
    const fn = new Function('window', 'document', firstFrameScript(pref))
    fn(fakeWindow, fakeDocument)
    return written
  }
  assert.equal(run('light', true), 'light')
  assert.equal(run('dark', false), 'dark')
  assert.equal(run('system', true), 'dark')
  assert.equal(run('system', false), 'light')
  assert.equal(run('bogus', true), 'dark')

  assert.equal(
    injectThemeScript(`<head>${THEME_PLACEHOLDER}</head>`, 'dark').includes('<script>'),
    true,
  )
  assert.match(injectThemeScript('<head></head>', 'dark'), /<head><script>/)
})

test('壳页面模板：主题占位符与引导占位符未被 `<script>` 包裹，注入后脚本可求值', () => {
  const html = readFileSync(join(WEB_DIR, 'shell.html'), 'utf8')
  // 主题占位符注入的是完整 `<script>…</script>`，模板不得再包一层（否则嵌套脚本为语法错误）
  assert.equal(html.includes(`<script>${THEME_PLACEHOLDER}`), false)
  assert.ok(html.includes(THEME_PLACEHOLDER))
  // 引导占位符后紧跟 `{}` 兜底；注入时连同 `{}` 一起替换，避免留下相邻对象字面量
  assert.ok(html.includes(`${BOOTSTRAP_PLACEHOLDER}{}`))
  const injected = injectBootstrap(html, { mounts: [{ id: 'ui-chat' }], headless: [], theme: 'system' })
  assert.equal(injected.includes('}{'), false)
  const match = injected.match(/window\.__CHRONO_SHELL__ = ([^;]+);/)
  assert.ok(match !== null)
  const value = new Function(`return ${match[1]}`)()
  assert.deepEqual(value, { mounts: [{ id: 'ui-chat' }], headless: [], theme: 'system' })
})

// ---- 文案表 ----

test('文案表：结构合法、覆盖全部前缀、未知码兜底', () => {
  const loaded = loadMessages(WEB_DIR)
  assert.equal(loaded.fallback, false)
  assert.deepEqual(missingPrefixes(loaded.table), [])
  for (const prefix of MESSAGE_PREFIXES) {
    assert.ok(
      Object.keys(loaded.table).some((code) => code.startsWith(prefix)),
      `缺前缀 ${prefix}`,
    )
  }
  assert.equal(typeof loaded.table.unknown.title, 'string')
  assert.equal(typeof loaded.table.shell_toast_close.body, 'string')
  const unknown = lookupMessage(loaded.table, 'no_such_code')
  assert.match(unknown.body, /no_such_code/)

  assert.equal(parseMessages('{ not json'), null)
  assert.equal(parseMessages('{"a":{"title":1,"body":"b"}}'), null)
  const raw = JSON.parse(readFileSync(join(WEB_DIR, 'messages.v1.json'), 'utf8'))
  assert.equal(typeof raw.locale, 'string')
  for (const [code, entry] of Object.entries(raw)) {
    if (code === 'locale') continue
    assert.equal(typeof entry.title, 'string', `${code}.title`)
    assert.equal(typeof entry.body, 'string', `${code}.body`)
    assert.equal(/[!！]/.test(entry.title + entry.body), false, `${code} 不应含感叹号`)
  }
})

// ---- 文案表：protocol §四 与插件裸码全覆盖 ----

test('文案表：共享表承载 ui-settings 界面文案（单一文案来源）', () => {
  const loaded = loadMessages(WEB_DIR)
  assert.equal(loaded.fallback, false)
  for (const code of [
    'settings_title',
    'settings_tab_orchestration',
    'settings_theme_day',
    'settings_orch_scope',
    'settings_orch_rollback_unverified',
    'settings_edit_provider',
    'settings_secret_save',
  ]) {
    assert.ok(loaded.table[code] !== undefined, `${code} 未登记进共享表`)
    assert.equal(loaded.table[code].body.length > 0, true, `${code}.body 为空`)
  }
  assert.equal(loaded.table.settings_orch_rollback_done, undefined, '回滚成功文案不应存在')
})

const PROTOCOL_CODES = [
  'protocol_mismatch', 'handshake_failed', 'unresolved_cap', 'not_loaded', 'stale', 'cycle',
  'writer_busy', 'unknown_command', 'unknown_run', 'bad_asset', 'asset_too_large', 'asset_missing',
  'too_many_runs', 'bad_args', 'bad_args_schema', 'bad_directive', 'transport_failed',
  'unresolved_pin', 'bad_worldignore', 'term_cycle', 'bad_term_ref', 'identity_mismatch',
  'protected_pin_removed', 'hidden_identity', 'validate_required', 'restart_exhausted',
  'bad_start_wrapper', 'bad_call_timeout', 'picker_unavailable', 'not_found', 'net_denied', 'internal',
]

const PLUGIN_BARE_CODES = [
  'timeout', 'oom', 'cpu_exceeded', 'output_max', 'procs_max', 'output_truncated', 'nonzero_exit',
  'bad_url', 'fetch_failed', 'http_status', 'all_sources_failed', 'session_not_found',
  'navigate_failed', 'element_not_found', 'browser_unsupported', 'permission_denied',
  'workspace_exists', 'reveal_failed', 'workspace_missing', 'notify_permission_denied',
  'notify_approval_pending', 'notify_orchestration_change', 'notify_plugin_write',
  'notify_run_finished', 'notify_run_failed', 'notify_model_error', 'notify_disconnected',
  'notify_reconnected', 'notify_orchestration_unhealthy', 'notify_question_pending',
]

test('文案表：protocol §四与插件裸码 lookupMessage 后不含「暂无说明」', () => {  const loaded = loadMessages(WEB_DIR)
  assert.equal(loaded.fallback, false)
  for (const code of [...PROTOCOL_CODES, ...PLUGIN_BARE_CODES]) {
    const entry = lookupMessage(loaded.table, code)
    assert.equal(
      entry.body.includes('暂无说明'),
      false,
      `${code} 未入表（命中了 unknown 兜底）`,
    )
    assert.ok(entry.body.length > 0, `${code} 文案为空`)
  }
  // 兼容别名：表里只有 plugin_* 键时，裸码仍可解析
  const aliasOnly = { unknown: { title: 'x', body: '错误码 {code} 暂无说明。' }, plugin_unresolved_pin: { title: '引脚', body: '依赖不存在。' } }
  assert.equal(lookupMessage(aliasOnly, 'unresolved_pin').body, '依赖不存在。')
  assert.equal(MESSAGE_ALIASES.identity_mismatch, 'plugin_identity_mismatch')
})

// ---- 资源静态校验 ----

const REQUIRED_TOKENS = [
  '--c-bg', '--c-surface', '--c-sidebar', '--c-selection', '--c-border', '--c-text',
  '--c-text-2', '--c-text-3', '--c-accent', '--c-accent-text',
  '--c-danger', '--c-danger-bg', '--c-warning', '--c-warning-bg',
  '--c-success', '--c-success-bg', '--c-info', '--c-info-bg', '--c-glass',
  '--font-sans', '--font-mono', '--font-size-xs', '--font-size-sm', '--font-size-md',
  '--font-size-lg', '--font-size-xl', '--leading-body', '--leading-code',
  '--weight-regular', '--weight-strong',
  '--space-4', '--space-8', '--space-12', '--space-16', '--space-24', '--space-32',
  '--sidebar-w-expanded', '--sidebar-w-collapsed', '--sidebar-w-min', '--sidebar-w-max',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
  '--shadow-pop', '--glass-blur', '--focus-ring',
  '--motion-fast', '--motion-base', '--motion-slow',
  '--icon-sm', '--icon-md',
  '--z-topbar', '--z-popover', '--z-dock', '--z-banner', '--z-modal', '--z-toast', '--z-lightbox',
]

test('tokens.v1.css：§2–§8 全部 token + z 栈，且无组件样式', () => {
  const css = loadTokens(WEB_DIR).text
  for (const token of REQUIRED_TOKENS) {
    assert.ok(css.includes(`${token}:`), `缺 token ${token}`)
  }
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = [...withoutComments.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1])
  assert.ok(blocks.length > 0)
  for (const block of blocks) {
    for (const declaration of block.split(';')) {
      const trimmed = declaration.trim()
      if (trimmed.length === 0) continue
      assert.ok(trimmed.startsWith('--'), `非自定义属性声明：${trimmed}`)
    }
  }
})

const REQUIRED_ICONS = [
  'arrow-up', 'square', 'plus', 'pencil', 'settings', 'copy', 'rotate-ccw',
  'panel-left', 'panel-left-close', 'arrow-down', 'cpu', 'gauge', 'zap', 'shield-alert',
  'eye', 'ban', 'check', 'x', 'check-check', 'alert-triangle', 'alert-circle',
  'pencil-line', 'chevron-down', 'list', 'puzzle', 'sparkles', 'brain', 'info', 'sun',
  'moon', 'monitor', 'download', 'upload', 'paperclip', 'folder', 'folder-plus',
  'folder-open', 'chevron-right', 'more-horizontal', 'search', 'trash-2', 'git-branch', 'undo-2',
]

test('icons.v2.svg：登记子集齐全、24×24、stroke 1.5、无 emoji', () => {
  const svg = loadIcons(WEB_DIR).text
  for (const name of REQUIRED_ICONS) {
    assert.ok(svg.includes(`<symbol id="${name}"`), `缺图标 ${name}`)
  }
  const symbols = [...svg.matchAll(/<symbol\b[^>]*>/g)].map((match) => match[0])
  assert.equal(symbols.length, REQUIRED_ICONS.length)
  for (const symbol of symbols) {
    assert.match(symbol, /viewBox="0 0 24 24"/)
    assert.match(symbol, /stroke-width="1\.5"/)
    assert.match(symbol, /stroke-linecap="round"/)
    assert.match(symbol, /stroke-linejoin="round"/)
    assert.match(symbol, /stroke="currentColor"/)
  }
  // 无 emoji（代理对 / 常见 emoji 区段）
  assert.equal(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg), false)
})

// ---- 壳页面细节（DOM 序 / 死代码 / 响应式 / 命中区） ----

test('壳页面细节：toast DOM 序、无死代码、响应式与 ::selection、banner 命中区', () => {
  const shellJs = readFileSync(join(WEB_DIR, 'lib', 'shell.js'), 'utf8')
  assert.match(shellJs, /document\.body\.appendChild\(toastRoot\)/)
  assert.equal(/const SLOTS\b/.test(shellJs), false, 'SLOTS 死代码应删除')
  assert.equal(/const mounted\b/.test(shellJs), false, 'mounted 死代码应删除')
  assert.equal(FALLBACK_MESSAGES.shell_tokens_fallback !== undefined, true)
  assert.equal(FALLBACK_MESSAGES.shell_toast_close.body, '关闭')
  assert.match(shellJs, /msg\('shell_toast_close'\)\.body/)

  const html = readFileSync(join(WEB_DIR, 'shell.html'), 'utf8')
  assert.match(html, /::selection/)
  assert.match(html, /flex: 0 3 auto/)
  assert.match(html, /--msg-max-w: 100%/)
  assert.match(html, /#shell-banner-retry[\s\S]*?min-height: 24px/)
})

// ---- 服务协议级：握手 / ping / probe / drain ----

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
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-shell'),
      CHRONO_UI_PORT: String(port),
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
    child.stdin.write(encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'ui-shell', gen: 'g' }))
    await waitFor(() => messages.some((message) => message.kind === 'manifest'), 'manifest')
    const manifest = messages.find((message) => message.kind === 'manifest')
    assert.equal(manifest.identity, 'ui-shell')
    assert.deepEqual(manifest.implements, ['ui-shell'])
    assert.deepEqual(manifest.methods, { 'ui-shell': ['ping'] })

    child.stdin.write(encodeFrame({ v: '1', id: 'c1', kind: 'call', port: 'ui-shell', method: 'ping', args: {} }))
    await waitFor(() => messages.some((message) => message.id === 'c1'), 'ping result')
    const ping = messages.find((message) => message.id === 'c1')
    assert.equal(ping.kind, 'result')
    assert.equal(ping.value.pong, true)

    child.stdin.write(encodeFrame({ v: '1', id: 'p1', kind: 'probe' }))
    await waitFor(() => messages.some((message) => message.id === 'p1'), 'pong')
    assert.equal(messages.find((message) => message.id === 'p1').kind, 'pong')

    assert.equal(existsSync(join(root, 'state', 'ui-mounts.json')), true)
    assert.equal(existsSync(join(root, 'state', 'ui-headless.json')), true)

    child.stdin.write(encodeFrame({ v: '1', id: 'd1', kind: 'drain', deadline_ms: 100 }))
    await waitFor(() => messages.some((message) => message.id === 'd1'), 'bye')
    assert.equal(messages.find((message) => message.id === 'd1').kind, 'bye')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  } finally {
    if (child.exitCode === null) child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- HTTP：主题写词表与 boot_mode 重推触发 ----

function fakeServerDeps(overrides = {}) {
  return {
    mounts: [],
    headless: [],
    bridge: {
      async configRead() {
        return { ok: true, value: {}, code: '', message: '' }
      },
      async submit() {
        return { ok: true, frame: { kind: 'accepted', run: 'r1' }, code: '', message: '' }
      },
    },
    sse: new SseHub(),
    state: () => ({ connected: true, theme: 'system', boot_mode: 'onboarding' }),
    headlessSource: () => null,
    applyThemePref: () => {},
    refreshConfig: () => {},
    trackConfigRun: () => {},
    log: () => {},
    ...overrides,
  }
}

async function postJsonTo(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify(body ?? {}),
  })
  return { status: response.status, payload: await response.json() }
}

test('壳静态资源：no-store 且 sprite 可解析目标', async () => {
  const port = await freePort()
  const server = await startUiServer(fakeServerDeps(), port)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/assets/icons.v2.svg`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(await response.text(), /<symbol id="sparkles"/)
  } finally {
    await server.close()
  }
})

test('壳静态资源：降级留痕（缺 sprite 时落日志，且同样 no-store）', async () => {
  const port = await freePort()
  const lines = []
  const emptyWebDir = mkdtempSync(join(tmpdir(), 'chrono-ui-assets-'))
  try {
    const server = await startUiServer(
      fakeServerDeps({ webDir: emptyWebDir, log: (line) => lines.push(line) }),
      port,
    )
    try {
      const response = await fetch(`http://127.0.0.1:${port}/assets/icons.v2.svg`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(lines, ['asset fallback: icons.v2.svg'])
    } finally {
      await server.close()
    }
  } finally {
    rmSync(emptyWebDir, { recursive: true, force: true })
  }
})

test('/api/theme：落 config 用 day/night 词表，回包 / 运行态用 light/dark', async () => {
  const port = await freePort()
  let submitted = null
  const applied = []
  const server = await startUiServer(
    fakeServerDeps({
      bridge: {
        async configRead() {
          return { ok: true, value: { vendor: 'x', ui: { theme: 'day' } }, code: '', message: '' }
        },
        async submit(directives) {
          submitted = directives
          return { ok: true, frame: { kind: 'accepted', run: 'r1', status: 'done' }, code: '', message: '' }
        },
      },
      applyThemePref: (pref) => applied.push(pref),
    }),
    port,
  )
  try {
    const { status, payload } = await postJsonTo(port, '/api/theme', { theme: 'dark' })
    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.theme, 'dark')
    assert.deepEqual(applied, ['dark'])
    const body = submitted[0].request.args.ops[0].args.body
    assert.equal(body.vendor, 'x')
    assert.equal(body.ui.theme, 'night')
  } finally {
    await server.close()
  }
})

test('/api/submit：config 写记 run 待终局重推，无 run 时立即重推', async () => {
  const port = await freePort()
  let refreshes = 0
  const tracked = []
  const configWrite = {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body: { vendor: 'deepseek' } } },
          { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
        ],
      },
    },
  }
  const server = await startUiServer(
    fakeServerDeps({
      refreshConfig: () => {
        refreshes += 1
      },
      trackConfigRun: (run) => tracked.push(run),
    }),
    port,
  )
  try {
    const configResult = await postJsonTo(port, '/api/submit', { directives: [configWrite] })
    assert.equal(configResult.status, 202)
    assert.deepEqual(tracked, ['r1'])
    assert.equal(refreshes, 0)
    const otherResult = await postJsonTo(port, '/api/submit', {
      directive: { kind: 'extern', payload: { a: 1 } },
    })
    assert.equal(otherResult.status, 202)
    assert.deepEqual(tracked, ['r1'])
    assert.equal(refreshes, 0)
  } finally {
    await server.close()
  }
})

test('/api/submit：config 写回帧已终局（result / 无 run）时立即重推', async () => {
  const port = await freePort()
  let refreshes = 0
  const configWrite = {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body: { vendor: 'deepseek' } } },
          { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
        ],
      },
    },
  }
  const server = await startUiServer(
    fakeServerDeps({
      bridge: {
        async configRead() {
          return { ok: true, value: {}, code: '', message: '' }
        },
        async submit() {
          return { ok: true, frame: { kind: 'result', run: 'r9', status: 'done' }, code: '', message: '' }
        },
      },
      refreshConfig: () => {
        refreshes += 1
      },
    }),
    port,
  )
  try {
    const result = await postJsonTo(port, '/api/submit', { directives: [configWrite] })
    assert.equal(result.status, 202)
    assert.equal(refreshes, 1)
  } finally {
    await server.close()
  }
})
