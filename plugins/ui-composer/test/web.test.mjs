// 浏览器视图层纯函数测试（node --test）：配置合并、模型 / 推理档位推导与塌缩、
// 待发队列迁移、槽 / 配置写口命令、上下文用量格式与阈值、附件分类、下拉键盘状态机、文案兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  CONTEXT_FULL_RATIO,
  CONTEXT_WARNING_RATIO,
  PERMISSIONS,
  buildMessageSlot,
  collapseReasoning,
  configPatch,
  configWriteCommand,
  currentModelOf,
  currentReasoningOf,
  currentVendorOf,
  dequeue,
  enqueue,
  enqueueFront,
  formatCount,
  identityActive,
  identityBody,
  isCodeGenFallbackBody,
  matchesThread,
  mergeConfig,
  messageRowLabel,
  messageSummary,
  modelsOf,
  normalizePermission,
  permissionDescCode,
  permissionIcon,
  permissionLabelCode,
  queueCount,
  queueEntry,
  queueOf,
  reasoningOptionsFromConfig,
  removeFromQueue,
  runIdOf,
  runKeyOf,
  slotWriteCommand,
  sourceRows,
  threadKeyOf,
  trimmedRows,
  usageFull,
  usageRatio,
  usageTone,
  usageView,
} from '../execute/web/model.ts'
import {
  attachmentKind,
  buildAttachment,
  bytesToBase64,
  extensionOf,
  guessMime,
  isParseable,
  normalizeRef,
} from '../execute/web/attach.ts'
import {
  activeIndexFor,
  closeDropdown,
  createDropdownState,
  isActiveIndex,
  moveActive,
  openDropdown,
  optionId,
} from '../execute/web/dropdown.ts'
import {
  FALLBACK_MESSAGES,
  lookupMessage,
  messageText,
  parseMessages,
  UI_TEXT,
} from '../execute/web/messages.ts'
import { createComposerStore } from '../execute/web/store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHARED_MESSAGES = resolve(HERE, '..', '..', 'ui-shell', 'execute', 'web', 'messages.v1.json')

function sharedTable() {
  return parseMessages(readFileSync(SHARED_MESSAGES, 'utf8'))
}

const CONFIG = {
  version: 1,
  vendor: 'deepseek',
  model: 'chat',
  params: { temperature: 0.7, reasoning: 'high' },
  permission: 'review',
  providers: {
    deepseek: {
      models: {
        chat: { name: 'DeepSeek Chat', reasoning: ['low', 'medium', 'high'], enabled: true },
        reasoner: { name: 'DeepSeek Reasoner', enabled: true },
        hidden: { name: 'Hidden', enabled: false },
      },
    },
  },
}

test('线程键与事件过滤：缺省一律归 _main', () => {
  assert.equal(threadKeyOf(null), '_main')
  assert.equal(threadKeyOf(''), '_main')
  assert.equal(threadKeyOf('t1'), 't1')
  assert.equal(matchesThread('t1', 't1'), true)
  assert.equal(matchesThread('t2', 't1'), false)
  assert.equal(matchesThread(null, null), true)
  assert.equal(matchesThread('_main', null), true)
  assert.equal(matchesThread(null, 't1'), false)
  assert.equal(matchesThread(undefined, 't1'), false)
  assert.equal(runKeyOf({ thread: 't1' }), 't1')
  assert.equal(runKeyOf({}), '_main')
  assert.equal(runIdOf({ run: 'r1' }), 'r1')
  assert.equal(runIdOf({ run: '' }), null)
  assert.equal(runIdOf(null), null)
})

test('配置读取：模型列表只来自用户配置，禁用模型排除', () => {
  assert.equal(currentVendorOf(CONFIG), 'deepseek')
  assert.equal(currentModelOf(CONFIG), 'chat')
  assert.equal(currentReasoningOf(CONFIG), 'high')
  assert.equal(currentVendorOf({}), null)
  assert.equal(currentReasoningOf({}), null)
  const list = modelsOf(CONFIG)
  assert.deepEqual(
    list.map((item) => `${item.vendor}:${item.id}`),
    ['deepseek:chat', 'deepseek:reasoner'],
  )
  assert.equal(list[0].name, 'DeepSeek Chat')
  assert.deepEqual(modelsOf(null), [])
})

test('推理档位：从 config 读、缺则 null；塌缩为单开关', () => {
  assert.deepEqual(reasoningOptionsFromConfig(CONFIG), ['low', 'medium', 'high'])
  assert.equal(
    reasoningOptionsFromConfig({
      vendor: 'deepseek',
      model: 'reasoner',
      providers: CONFIG.providers,
    }),
    null,
  )
  assert.equal(reasoningOptionsFromConfig({}), null)
  assert.deepEqual(collapseReasoning(['low', 'medium', 'high']), {
    collapsed: false,
    options: ['low', 'medium', 'high'],
  })
  assert.deepEqual(collapseReasoning(['on', 'on', 'on']), {
    collapsed: true,
    value: 'on',
    options: ['on', 'on', 'on'],
  })
  assert.deepEqual(collapseReasoning(['on']), { collapsed: true, value: 'on', options: ['on'] })
  assert.deepEqual(collapseReasoning([]), { collapsed: false, options: [] })
  assert.deepEqual(collapseReasoning(null), { collapsed: false, options: [] })
})

test('配置合并：只改点名字段；reasoning:null 清键', () => {
  const model = mergeConfig(CONFIG, { vendor: 'other', model: 'x' })
  assert.equal(model.vendor, 'other')
  assert.equal(model.model, 'x')
  assert.deepEqual(model.providers, CONFIG.providers)
  assert.equal(model.permission, 'review')
  const reasoning = mergeConfig(CONFIG, { reasoning: 'low' })
  assert.equal(reasoning.params.reasoning, 'low')
  assert.equal(reasoning.params.temperature, 0.7)
  const cleared = mergeConfig(CONFIG, { reasoning: null })
  assert.equal(Object.hasOwn(cleared.params, 'reasoning'), false)
  assert.equal(cleared.params.temperature, 0.7)
  const permission = mergeConfig(CONFIG, { permission: 'deny' })
  assert.equal(permission.permission, 'deny')
  assert.equal(mergeConfig(null, { permission: 'auto' }).permission, 'auto')
})

test('权限四档：归一 / 文案码 / 图标', () => {
  assert.deepEqual(PERMISSIONS, ['auto', 'severe', 'review', 'deny'])
  assert.equal(normalizePermission('deny'), 'deny')
  assert.equal(normalizePermission('bogus'), 'review')
  assert.equal(normalizePermission(null), 'review')
  assert.equal(permissionLabelCode('auto'), 'composer_permission_auto')
  assert.equal(permissionDescCode('severe'), 'composer_permission_severe_desc')
  assert.equal(permissionIcon('review'), 'eye')
  assert.equal(permissionIcon('deny'), 'ban')
  assert.equal(permissionIcon('severe'), 'shield-alert')
  assert.equal(permissionIcon('auto'), 'zap')
})

test('槽载荷与写指令：只覆盖本线程键', () => {
  const slot = buildMessageSlot('hi', [{ kind: 'file', name: 'a.txt' }])
  assert.deepEqual(slot, {
    kind: 'chat.message',
    text: 'hi',
    attachments: [{ kind: 'file', name: 'a.txt' }],
  })
  assert.deepEqual(buildMessageSlot(null, null), {
    kind: 'chat.message',
    text: '',
    attachments: [],
  })
  assert.deepEqual(buildMessageSlot('hi', [], { workspaceId: 'w1', conversationId: 'c9' }), {
    kind: 'chat.message',
    text: 'hi',
    attachments: [],
    workspace_id: 'w1',
    conversation_id: 'c9',
  })
  assert.deepEqual(buildMessageSlot('hi', [], { workspaceId: null, conversationId: null }), {
    kind: 'chat.message',
    text: 'hi',
    attachments: [],
  })

  const slotCmd = slotWriteCommand('t1', slot)
  assert.deepEqual(slotCmd, { name: 'input.write', args: { thread: 't1', slot } })
  assert.equal(JSON.stringify(slotCmd).includes('add_gen'), false, '不再构造世界写 directive')
  assert.equal(JSON.stringify(slotCmd).includes('$directives'), false)
})

test('配置写口：补丁只带本插件负责字段；reasoning 非字符串即删除', () => {
  assert.deepEqual(configPatch({ vendor: 'v', model: 'm', permission: 'auto', reasoning: 'high' }), {
    vendor: 'v',
    model: 'm',
    permission: 'auto',
    params: { reasoning: 'high' },
  })
  assert.deepEqual(configPatch({ reasoning: null }), { params: { reasoning: null } })
  assert.deepEqual(configPatch({ reasoning: 3 }), { params: { reasoning: null } })
  assert.deepEqual(configPatch({}), {})
  assert.deepEqual(configPatch(null), {})
  const cmd = configWriteCommand({ ui: { theme: 'night' } })
  assert.deepEqual(cmd, { name: 'config.write', args: { patch: { ui: { theme: 'night' } } } })
  assert.equal(JSON.stringify(cmd).includes('add_gen'), false)
})

test('身份视图拆 body/active；代码世代回落判据', () => {
  const hash = 'c'.repeat(64)
  const view = { active: hash, body: { version: 1 } }
  assert.deepEqual(identityBody(view), { version: 1 })
  assert.equal(identityActive(view), hash)
  assert.equal(identityActive({ version: 1 }), undefined)
  assert.equal(isCodeGenFallbackBody({ tree: 'x' }), true)
  assert.equal(isCodeGenFallbackBody({ version: 1 }), false)
})

test('待发队列：per-thread 入队 / 出队 / 移除 / 放回队首', () => {
  let queue = {}
  assert.equal(queueCount(queue, 't1'), 0)
  assert.deepEqual(queueOf(queue, 't1'), [])
  queue = enqueue(queue, 't1', { id: 'm1' })
  queue = enqueue(queue, 't1', { id: 'm2' })
  queue = enqueue(queue, 't2', { id: 'n1' })
  assert.equal(queueCount(queue, 't1'), 2)
  assert.equal(queueCount(queue, 't2'), 1)
  const first = dequeue(queue, 't1')
  assert.equal(first.message.id, 'm1')
  assert.equal(queueCount(first.queue, 't1'), 1)
  assert.equal(queueCount(first.queue, 't2'), 1)
  const empty = dequeue({}, 't1')
  assert.equal(empty.message, null)
  const removed = removeFromQueue(queue, 't1', 'm1')
  assert.equal(queueCount(removed, 't1'), 1)
  assert.equal(removeFromQueue(removed, 't1', 'm2').t1, undefined)
  const front = enqueueFront(queue, 't1', { id: 'm0' })
  assert.equal(front.t1[0].id, 'm0')
  assert.equal(queueCount(front, 't2'), 1)
})

test('队内消息摘要：文本裁剪 + 附件计数', () => {
  const summary = messageSummary({ text: 'a\nb   c', attachments: [{}, {}] })
  assert.equal(summary.text, 'a b c')
  assert.equal(summary.count, 2)
  assert.equal(messageSummary({ text: 'x'.repeat(80) }, 10).text, `${'x'.repeat(10)}…`)
  assert.deepEqual(messageSummary(null), { text: '', count: 0 })
})

test('队内条目：包装 {id, slot} 取槽体，行文案由纯模块拼装', () => {
  const wrapper = { id: 'c-1', slot: { kind: 'chat.message', text: 'hi', attachments: [{}, {}] } }
  assert.deepEqual(queueEntry(wrapper), { id: 'c-1', slot: wrapper.slot })
  assert.deepEqual(queueEntry({ kind: 'chat.message', text: 'bare' }), {
    id: '',
    slot: { kind: 'chat.message', text: 'bare' },
  })
  const t = (code, vars) => `${code}:${vars.count}`
  assert.equal(messageRowLabel(wrapper, t), 'hi · composer_attachment:2')
  assert.equal(
    messageRowLabel({ id: 'c-2', slot: { text: '  ', attachments: [{}] } }, t),
    'composer_attachment:1',
  )
  assert.equal(messageRowLabel({ id: 'c-3', slot: { text: 'plain' } }, t), 'plain')
  assert.equal(messageRowLabel(null, t), '')
})

test('上下文用量：数字格式 / 阈值分档 / 明细', () => {
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1000), '1k')
  assert.equal(formatCount(1200), '1.2k')
  assert.equal(formatCount(128000), '128k')
  assert.equal(formatCount(1500000), '1.5M')
  assert.equal(formatCount(NaN), '')

  assert.equal(usageRatio({ used: 40, budget: 100 }), 0.4)
  assert.equal(usageTone({ used: 40, budget: 100 }), 'muted')
  assert.equal(usageTone({ used: 75, budget: 100 }), 'warning')
  assert.equal(usageTone({ used: 100, budget: 100 }), 'danger')
  assert.equal(usageFull({ used: 100, budget: 100 }), true)
  assert.equal(usageFull({ used: 99, budget: 100 }), false)
  assert.equal(CONTEXT_WARNING_RATIO, 0.75)
  assert.equal(CONTEXT_FULL_RATIO, 1)

  assert.deepEqual(usageView({ used: 42000, budget: 128000 }), {
    used: 42000,
    budget: 128000,
    usedText: '42k',
    budgetText: '128k',
    tone: 'muted',
    full: false,
  })
  assert.equal(usageView({ used: 1 }), null)
  assert.equal(usageView(null), null)

  const rows = sourceRows({ sources: { system: 1000, tools: { tokens: 2500 }, unknown: 5 } })
  assert.deepEqual(
    rows.map((row) => row.key),
    ['system', 'tools', 'unknown'],
  )
  assert.equal(rows[0].code, 'composer_source_system')
  assert.equal(rows[0].text, '1k')
  assert.equal(rows[1].text, '2.5k')
  assert.equal(rows[2].code, null)

  const trimmed = trimmedRows({ trimmed: [{ label: 'x', reason: 'budget' }, { id: 'y' }, 'nope'] })
  assert.deepEqual(trimmed, [
    { label: 'x', reason: 'budget' },
    { label: 'y', reason: '' },
  ])
})

test('附件分类：格式判定 / 种类 / mime 猜测 / 资产引用归一', () => {
  assert.equal(extensionOf('a/b/c.TSX'), 'tsx')
  assert.equal(extensionOf('noext'), '')
  assert.equal(isParseable('text/plain', 'a'), true)
  assert.equal(isParseable('application/json', 'a'), true)
  assert.equal(isParseable('application/octet-stream', 'a.md'), true)
  assert.equal(isParseable('application/octet-stream', 'a.png'), false)
  assert.equal(attachmentKind('image/png', 'a'), 'image')
  assert.equal(attachmentKind('video/mp4', 'a'), 'video')
  assert.equal(attachmentKind('audio/mpeg', 'a'), 'audio')
  assert.equal(attachmentKind('', 'a.zip'), 'file')
  assert.equal(attachmentKind('', 'a.jpg'), 'image')
  assert.equal(guessMime('a.json'), 'application/json')
  assert.equal(guessMime('a.bin'), 'application/octet-stream')

  assert.deepEqual(
    normalizeRef({ kind: 'asset', sha256: 'a'.repeat(64), mime: 'image/png', size: 3 }, 'x', 0),
    {
      kind: 'asset',
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      size: 3,
    },
  )
  assert.equal(
    normalizeRef({ ref: { sha256: 'b'.repeat(64) } }, 'text/plain', 9).mime,
    'text/plain',
  )
  assert.equal(normalizeRef({}, 'x', 0), null)
  assert.equal(normalizeRef(null, 'x', 0), null)
})

test('附件对象：可解析带 text，不可解析只带引用', () => {
  const text = buildAttachment({
    name: 'a.md',
    mime: 'text/markdown',
    sha256: 'a'.repeat(64),
    size: 10,
    text: '# hi',
  })
  assert.equal(text.kind, 'file')
  assert.equal(text.text, '# hi')
  assert.deepEqual(text.source, {
    kind: 'asset',
    sha256: 'a'.repeat(64),
    mime: 'text/markdown',
    size: 10,
  })
  const binary = buildAttachment({
    name: 'a.png',
    mime: 'image/png',
    sha256: 'b'.repeat(64),
    size: 20,
    text: 'ignored',
  })
  assert.equal(binary.kind, 'image')
  assert.equal(Object.hasOwn(binary, 'text'), false)
})

test('字节 → 规范 base64（与 Buffer 一致）', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253])
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'))
  assert.equal(bytesToBase64(Uint8Array.from([])), '')
  assert.equal(bytesToBase64(Uint8Array.from([102])), 'Zg==')
  assert.equal(bytesToBase64(Uint8Array.from([102, 111])), 'Zm8=')
})

test('下拉键盘状态机：打开定位选中项 / 环绕移动 / 关闭', () => {
  const closed = createDropdownState()
  assert.equal(closed.open, false)
  assert.equal(activeIndexFor(2, 4), 2)
  assert.equal(activeIndexFor(-1, 4), 0)
  assert.equal(activeIndexFor(9, 4), 0)
  assert.equal(activeIndexFor(0, 0), -1)
  const opened = openDropdown(closed, 2, 4)
  assert.equal(opened.open, true)
  assert.equal(opened.activeIndex, 2)
  assert.equal(isActiveIndex(opened, 2), true)
  assert.equal(isActiveIndex(opened, 1), false)
  assert.equal(isActiveIndex(closed, 0), false)
  assert.equal(moveActive(opened, 1, 4).activeIndex, 3)
  assert.equal(moveActive(opened, 2, 4).activeIndex, 0)
  assert.equal(moveActive(opened, -1, 4).activeIndex, 1)
  assert.equal(moveActive(opened, 1, 0).activeIndex, -1)
  assert.equal(closeDropdown().open, false)
  assert.equal(optionId('composer-model', 3), 'composer-model-option-3')
})

test('文案：共享表优先、本地界面文案兜底、未知码不空白', () => {
  const table = sharedTable()
  assert.ok(table !== null, '共享文案表应可解析')
  assert.equal(lookupMessage(table, 'unknown_command').body, '声明里没有这个命令名。检查命令名。')
  assert.equal(messageText(table, 'composer_send'), UI_TEXT.composer_send)
  assert.equal(lookupMessage(null, 'composer_pending').body, UI_TEXT.composer_pending)
  assert.equal(lookupMessage(null, 'no_such_code').body.includes('no_such_code'), true)
  assert.equal(parseMessages('not json'), null)
  assert.equal(parseMessages('{"x":{"title":1}}'), null)
  assert.equal(lookupMessage(FALLBACK_MESSAGES, 'ui_unreachable').action, '重试')
})

// ---- store 生命周期（作用域提升） ----

/** 最小壳 api：事件总线可手动 emit，命令按名回包，文案拉取走空 URL（失败回落内置表）。 */
function fakeComposerCtx() {
  const listeners = new Set()
  const uiValues = new Map()
  const uiSubs = new Map()
  return {
    tokens: { messages: '' },
    uiState: {
      get: (key) => uiValues.get(key),
      set: (key, value) => {
        uiValues.set(key, value)
        for (const callback of uiSubs.get(key) ?? []) callback(value)
      },
      subscribe: (key, callback) => {
        const set = uiSubs.get(key) ?? new Set()
        set.add(callback)
        uiSubs.set(key, set)
        return () => set.delete(callback)
      },
    },
    events: {
      connected: () => true,
      onAny: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    command: async (name) => {
      if (name === 'input.read') {
        return { ok: true, value: { active: 'a', body: { version: 1, slots: {} } } }
      }
      if (name === 'input.write') return { ok: true, value: { ok: true, thread: 't' } }
      if (name === 'config.read') {
        return { ok: true, value: { active: 'a', body: { version: 1, vendor: 'v', model: 'm' } } }
      }
      if (name === 'config.write') return { ok: true, value: { ok: true } }
      if (name === 'chat.send') return { ok: true, value: null }
      return { ok: false, code: 'unknown', value: null }
    },
    submit: async () => ({ ok: true, run: 'w1' }),
    cancel: async () => ({ ok: true, code: '' }),
    emit: (record) => {
      for (const listener of [...listeners]) listener(record)
    },
    listenerCount: () => listeners.size,
  }
}

test('store 作用域：卸载 / 重挂保留草稿与 RunState，init 幂等不重复订阅', async () => {
  const ctx = fakeComposerCtx()
  // register 作用域只建一次 store。
  const store = createComposerStore(ctx)
  await store.init()
  assert.equal(ctx.listenerCount(), 1)
  // 驱动一次完整回合：无当前会话 → 自动建线程（写 uiState.active_thread）→ 槽写落账 → chat.send → run.started 认领。
  store.setText('发送中')
  await store.send()
  const thread = ctx.uiState.get('active_thread')
  assert.equal(typeof thread, 'string')
  ctx.emit({ topic: 'run.finished', payload: { thread, run: 'w1' } })
  ctx.emit({ topic: 'run.started', payload: { thread, run: 'r1' } })
  assert.equal(store.getSnapshot().running, true)
  store.setText('重挂后草稿')
  // 卸载不 dispose；重挂再 init：幂等、不重复订阅，草稿与运行态原样。
  await store.init()
  assert.equal(ctx.listenerCount(), 1)
  assert.equal(store.getSnapshot().text, '重挂后草稿')
  assert.equal(store.getSnapshot().running, true)
  // 最终卸载：dispose 释放订阅。
  store.dispose()
  assert.equal(ctx.listenerCount(), 0)
})

test('entry.tsx：store 建在 register 作用域，组件经 props 复用同一实例', () => {
  const source = readFileSync(join(HERE, '..', 'execute', 'web', 'entry.tsx'), 'utf8')
  const registerAt = source.indexOf('export function register')
  assert.ok(registerAt >= 0)
  const component = source.slice(0, registerAt)
  const register = source.slice(registerAt)
  assert.equal(component.includes('createComposerStore('), false)
  assert.equal((register.match(/createComposerStore\(/g) ?? []).length, 1)
  assert.match(register, /store=\{store\}/)
  // 组件卸载不再 dispose（否则重挂后 store 永久 disposed）。
  assert.equal(/return \(\) => store\.dispose\(\)/.test(source), false)
})
