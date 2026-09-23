// `ui-chat` 纯函数视图层 + 服务协议测试（node --test）。
// 覆盖：markdown / 消毒、parts 分发、工具卡两形态三 tone、detail.kind 全集与未知降级、
// usage 两路、复制时序、事件线程过滤、群聊 / 步骤卡、窗口化与胶囊状态机、日期分隔、
// lightbox 状态机、历史沿 prev 还原、命令不可用路径、client.read 路径穿越防护、
// 服务握手 / EOF 自退出、入口导出。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { escapeHtml, renderInline, renderMarkdown } from '../execute/web/markdown.ts'
import { decodeEntities, parseTag, safeUrl, sanitizeHtml } from '../execute/web/sanitize.ts'
import {
  currentConversationId,
  dataChangeTarget,
  finishesCurrentStream,
  isPeriodicRun,
  loadConversation,
  matchesThread,
  messageText,
  pickConversation,
  restoreMessages,
  threadKind,
} from '../execute/web/history-model.ts'
import { assetSource, messageViewItems, partViewModel, safeStringify } from '../execute/web/render-parts.ts'
import { degradeText, renderSummary, toolCardViewModel, truncateSummary } from '../execute/web/tool-card.ts'
import { computeDiff, detailViewModel, parsePatch, splitLines } from '../execute/web/detail-renderers.ts'
import { createLightboxState, MAX_SCALE, MIN_SCALE } from '../execute/web/lightbox.ts'
import { groupViewModel } from '../execute/web/group.ts'
import { statusIcon, statusText, workflowViewModel } from '../execute/web/workflow.ts'
import {
  createNewMessageState,
  dismissNew,
  hasOlder,
  initialWindow,
  onNewContent,
  olderWindow,
  pillLabel,
  shouldWindow,
  sliceWindow,
} from '../execute/web/windowing.ts'
import { buildDateSeparators, dateLabel, localDateKey } from '../execute/web/date-sep.ts'
import { formatCount, usageText, usageTotal } from '../execute/web/usage.ts'
import { COPY_HOLD_MS, createCopyState } from '../execute/web/copy.ts'
import { FALLBACK_MESSAGES, lookupMessage, messageText as uiText, parseMessages, UI_TEXT } from '../execute/web/messages.ts'

import { Bridge, commandFrame, extractValue, interpretResponse, submitFrame } from '../execute/bridge.ts'
import { isSafeClientPath, readClientFile, resolveClientPath } from '../execute/client-read.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const WEB = join(PKG_ROOT, 'execute', 'web')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `chrono-ui-chat-${label}-`))
}

// ---- markdown 与消毒 ----

test('markdown：块级 / 行内渲染，用户文本一律转义', () => {
  assert.equal(renderMarkdown('# Hi'), '<h1>Hi</h1>')
  assert.equal(renderMarkdown('a\nb'), '<p>a<br>b</p>')
  assert.equal(renderMarkdown('```\nconst x = 1\n```'), '<pre><code>const x = 1</code></pre>')
  assert.equal(renderMarkdown('> quote'), '<blockquote><p>quote</p></blockquote>')
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(renderMarkdown('1. a'), '<ol><li>a</li></ol>')
  assert.equal(renderMarkdown('---'), '<hr>')
  assert.equal(renderInline('**b**'), '<strong>b</strong>')
  assert.equal(renderInline('*i*'), '<em>i</em>')
  assert.equal(renderInline('~~d~~'), '<del>d</del>')
  assert.equal(renderInline('`c`'), '<code>c</code>')
  assert.equal(renderInline('snake_case_name'), 'snake_case_name')
  assert.match(renderInline('[x](https://e.com)'), /target="_blank"/)
  assert.equal(escapeHtml('<a>&'), '&lt;a&gt;&amp;')
})

test('消毒：script / 事件属性 / 危险 URL 被清', () => {
  assert.equal(sanitizeHtml('<script>alert(1)</script>'), '')
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)>'), '')
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeHtml('<a href="jav&#x61;script:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeHtml('<a href="https://e.com" onclick="x">y</a>'), '<a href="https://e.com">y</a>')
  assert.equal(sanitizeHtml('<b onmouseover="1">hi</b>'), 'hi')
  assert.equal(sanitizeHtml('<p>hi</p>'), '<p>hi</p>')
  assert.equal(
    sanitizeHtml('<a href="https://e.com" target="_blank" rel="opener">y</a>'),
    '<a href="https://e.com" target="_blank" rel="noopener noreferrer">y</a>',
  )
  assert.equal(sanitizeHtml('<!-- c -->x'), 'x')
  // markdown 产物 + 消毒：恶意链接不生成可点击 <a>
  const dirty = sanitizeHtml(renderMarkdown('[x](javascript:alert(1))'))
  assert.equal(/<a\b/i.test(dirty), false)
  assert.equal(/href\s*=/i.test(dirty), false)
  assert.equal(safeUrl('data:text/html;base64,AAAA'), null)
  assert.equal(safeUrl('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(decodeEntities('&amp;lt;'), '<')
  assert.deepEqual(parseTag('/a href="x"'), { closing: true, name: 'a', attrs: [['href', 'x']], selfClosing: false })
  assert.equal(parseTag('!doctype'), null)
})

// ---- parts 分发 ----

test('parts 分发：text / image / video / audio / file / tool / 未知降级', () => {
  const asset = { kind: 'asset', sha256: 'a'.repeat(64), mime: 'image/png', size: 3 }
  assert.deepEqual(partViewModel({ type: 'text', text: 'hi' }), { type: 'text', text: 'hi' })
  assert.deepEqual(partViewModel({ type: 'image', source: asset }), { type: 'image', source: asset, alt: '' })
  assert.equal(partViewModel({ type: 'video', source: asset }).type, 'video')
  assert.equal(partViewModel({ type: 'audio', source: asset }).type, 'audio')
  assert.deepEqual(partViewModel({ type: 'file', name: 'a.txt', source: asset }), {
    type: 'file',
    name: 'a.txt',
    source: asset,
    text: null,
  })
  const tool = partViewModel({ type: 'tool', call_id: 'c1', tool: 'read', render: { form: 'line' }, args: {}, result: {} })
  assert.equal(tool.type, 'tool')
  assert.equal(tool.callId, 'c1')
  assert.equal(partViewModel({ type: 'weird', text: 'fallback' }).text, 'fallback')
  assert.match(partViewModel({ type: 'weird', x: 1 }).text, /"x"/)
  assert.deepEqual(assetSource({ kind: 'ext', url: 'https://e.com/a' }), { kind: 'ext', url: 'https://e.com/a' })
  assert.equal(assetSource({ sha256: 'b'.repeat(64) }).kind, 'asset')

  const items = messageViewItems({
    content: 'c',
    parts: [{ type: 'text', text: 'p' }],
    attachments: [{ kind: 'image', name: 'i', source: asset }],
  })
  assert.equal(items.length, 2)
  assert.equal(items[0].type, 'text')
  assert.equal(items[1].type, 'image')
  assert.equal(messageViewItems({ content: 'only' })[0].text, 'only')
})

// ---- 工具卡 ----

test('工具卡：两形态 / 三 tone / 无描述符与未知 form 降级', () => {
  const line = toolCardViewModel({ tool: 'read', render: { form: 'line', label: 'read', summary: '{path}' }, args: { path: 'a.ts' } })
  assert.equal(line.form, 'line')
  assert.equal(line.summary, 'a.ts')
  assert.equal(line.tone, 'plain')

  const card = toolCardViewModel({
    tool: 'edit',
    render: { form: 'card', label: 'edit', tone: 'solid', summary: '{path}  +{result.added} -{result.removed}', detail: { kind: 'diff' } },
    args: { path: 'b.ts' },
    result: { added: 3, removed: 1 },
  })
  assert.equal(card.form, 'card')
  assert.equal(card.tone, 'solid')
  assert.equal(card.summary, 'b.ts  +3 -1')
  assert.deepEqual(card.detail, { kind: 'diff' })

  assert.equal(toolCardViewModel({ render: { form: 'card', tone: 'bogus' } }).tone, 'plain')
  const degraded = toolCardViewModel({ tool: 'x', result: { text: 'plain result' } })
  assert.equal(degraded.form, 'degraded')
  assert.equal(degraded.text, 'plain result')
  assert.equal(toolCardViewModel({ render: { form: 'weird' } }).form, 'degraded')
  assert.equal(renderSummary('{a}.{b}', { a: 1, b: 2 }, null), '1.2')
  assert.equal(renderSummary('{missing}', {}, null), '')
  assert.equal(truncateSummary('abcdef', 4), 'abc…')
  assert.equal(degradeText({ result: { a: 1 } }), safeStringify({ a: 1 }))
})

// ---- detail.kind 全集 ----

test('detail.kind：text / code / diff / matches / paths / list / table / json / file / image / terminal', () => {
  assert.equal(detailViewModel({ kind: 'text', text: 't' }).text, 't')
  assert.equal(detailViewModel({ kind: 'code', text: 'x', language: 'ts' }).language, 'ts')
  assert.equal(detailViewModel({ kind: 'unknown-kind', a: 1 }).kind, 'text')

  const diff = detailViewModel({ kind: 'diff', before: 'a\nb\nc', after: 'a\nB\nc' })
  assert.equal(diff.kind, 'diff')
  assert.ok(diff.rows.some((row) => row.type === 'mod' && row.before === 'b' && row.after === 'B'))
  assert.ok(diff.rows.some((row) => row.type === 'ctx'))

  const patch = detailViewModel({ kind: 'diff', patch: '@@ -1 +1 @@\n-old\n+new' })
  assert.ok(patch.rows.some((row) => row.type === 'add' && row.text === 'new'))
  assert.ok(patch.rows.some((row) => row.type === 'del' && row.text === 'old'))

  const collapsed = computeDiff(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'))
  assert.ok(collapsed.rows.some((row) => row.type === 'hunk'))
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])

  const matches = detailViewModel({ kind: 'matches', matches: [{ path: 'a.ts', line: 3, text: 'x' }] })
  assert.deepEqual(matches.items[0], { path: 'a.ts', line: 3, text: 'x' })
  assert.deepEqual(detailViewModel({ kind: 'paths', paths: ['a', 'b'] }).items, ['a', 'b'])
  assert.deepEqual(detailViewModel({ kind: 'list', items: [1, 2] }).items, [1, 2])
  const table = detailViewModel({ kind: 'table', columns: ['a', 'b'], rows: [[1, 'x']] })
  assert.deepEqual(table.columns, ['a', 'b'])
  assert.deepEqual(table.rows, [['1', 'x']])
  assert.match(detailViewModel({ kind: 'json', value: { a: 1 } }).text, /"a": 1/)
  assert.equal(detailViewModel({ kind: 'file', name: 'f', source: { kind: 'asset', sha256: 'c'.repeat(64) } }).name, 'f')
  assert.equal(detailViewModel({ kind: 'image', source: { kind: 'asset', sha256: 'd'.repeat(64) } }).kind, 'image')
  const terminal = detailViewModel({ kind: 'terminal', stdout: 'out', stderr: 'err', exit_code: 2 })
  assert.equal(terminal.stdout, 'out')
  assert.equal(terminal.stderr, 'err')
  assert.equal(terminal.exitCode, 2)
})

test('detail.kind:question：单选 / 多选 / 自定义 / 已答 / expired', () => {
  const vm = detailViewModel({
    kind: 'question',
    id: 'q-1',
    interactive: true,
    questions: [
      { id: 'q1', header: 'H', question: 'Q', options: [{ label: 'A', description: 'a' }], multiple: false, custom: true },
    ],
  })
  assert.equal(vm.kind, 'question')
  assert.equal(vm.itemId, 'q-1')
  assert.equal(vm.expired, false)
  assert.equal(vm.answered, false)
  assert.equal(vm.questions[0].multiple, false)
  assert.equal(vm.questions[0].custom, true)
  assert.deepEqual(vm.questions[0].options, [{ label: 'A', description: 'a' }])

  const answered = detailViewModel({ kind: 'question', answers: [{ question_id: 'q1', selected: ['A'] }], questions: [] })
  assert.equal(answered.answered, true)
  assert.equal(answered.answers[0].selected[0], 'A')

  const expired = detailViewModel({ kind: 'question', status: 'expired', questions: [] })
  assert.equal(expired.expired, true)
})

// ---- usage ----

test('meta.usage：有无两路 + 计数格式', () => {
  assert.equal(usageText({ meta: { usage: { prompt_tokens: 100, completion_tokens: 20 } } }), '120 tokens')
  assert.equal(usageText({ meta: { usage: { total_tokens: 1500 } } }), '1.5k tokens')
  assert.equal(usageText({ meta: { usage: 42 } }), '42 tokens')
  assert.equal(usageText({ meta: {} }), null)
  assert.equal(usageText({}), null)
  assert.equal(usageText(null), null)
  assert.equal(usageTotal({ input_tokens: 1, output_tokens: 2 }), 3)
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1500000), '1.5M')
})

// ---- 复制时序 ----

test('复制反馈：1.2s 回退 + 播报文案', () => {
  let clock = 1000
  const machine = createCopyState({ now: () => clock })
  assert.equal(machine.get().status, 'idle')
  machine.success()
  assert.equal(machine.get().status, 'check')
  clock = 1000 + COPY_HOLD_MS - 1
  machine.tick()
  assert.equal(machine.get().status, 'check')
  clock = 1000 + COPY_HOLD_MS
  machine.tick()
  assert.equal(machine.get().status, 'idle')
  machine.fail()
  assert.equal(machine.get().status, 'error')
  assert.equal(COPY_HOLD_MS, 1200)
  assert.equal(uiText(FALLBACK_MESSAGES, 'chat_copied'), '已复制')
})

// ---- 事件线程过滤 ----

test('entry.tsx：流式 aria-busy / 定稿 aria-live / 胶囊 aria-live / quiet reload 守卫', () => {
  const source = readFileSync(join(WEB, 'entry.tsx'), 'utf8')
  assert.match(source, /aria-busy/)
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /aria-atomic="true"/)
  assert.match(source, /firstScreen/)
  assert.match(source, /st\.reloading = true/)
  // 首屏才块级 loading；quiet reload 不得再无条件置 loading
  assert.equal((source.match(/st\.loading = true/g) ?? []).length, 1)
})

test('事件按 thread 过滤（写死）', () => {
  assert.equal(matchesThread('t1', 't1'), true)
  assert.equal(matchesThread('t2', 't1'), false)
  assert.equal(matchesThread(null, null), true)
  assert.equal(matchesThread('_main', null), true)
  assert.equal(matchesThread('t1', null), false)
  assert.equal(matchesThread(undefined, 't1'), false)
})

test('数据变更类事件优先 payload.conversation，缺失才回落 payload.thread', () => {
  assert.equal(dataChangeTarget({ conversation: 'c1', thread: 't1' }), 'c1')
  assert.equal(dataChangeTarget({ thread: 't1' }), 't1')
  assert.equal(dataChangeTarget({ conversation: '', thread: 't1' }), 't1')
  assert.equal(dataChangeTarget({}), null)
  assert.equal(dataChangeTarget(null), null)
  // 过滤：会话匹配当前视图线程才处理
  assert.equal(matchesThread(dataChangeTarget({ conversation: 'c1' }), 'c1'), true)
  assert.equal(matchesThread(dataChangeTarget({ conversation: 'c2' }), 'c1'), false)
})

test('run.finished 仅收束本轮流式：run id 不匹配不重拉', () => {
  const stream = { run: 'r1' }
  assert.equal(finishesCurrentStream(stream, 'r1'), true)
  assert.equal(finishesCurrentStream(stream, 'r2'), false)
  assert.equal(finishesCurrentStream(null, 'r1'), false)
  assert.equal(finishesCurrentStream(undefined, 'r1'), false)
  assert.equal(finishesCurrentStream(stream, null), false)
  assert.equal(finishesCurrentStream(stream, ''), false)
  assert.equal(finishesCurrentStream(stream, undefined), false)
  assert.equal(finishesCurrentStream(stream, 7), false)
})

test('periodic run.started 不建流；其余 origin 可建流', () => {
  assert.equal(isPeriodicRun('periodic'), true)
  assert.equal(isPeriodicRun('submit'), false)
  assert.equal(isPeriodicRun('command'), false)
  assert.equal(isPeriodicRun('forward'), false)
  assert.equal(isPeriodicRun('detached'), false)
  assert.equal(isPeriodicRun(undefined), false)
})

// ---- 群聊 ----

test('群聊视图模型：首字母圆标 / 连续发言人只首条显名 / 未读锚点', () => {
  const refs = { 'agent-a': { name: 'Alice' }, 'agent-b': { name: 'Bob' } }
  const messages = [
    { hash: 'h1', def: { id: 'm1', role: 'user', content: 'hi' } },
    { hash: 'h2', def: { id: 'm2', role: 'assistant', content: 'a1', meta: { speaker: 'agent-a' } } },
    { hash: 'h3', def: { id: 'm3', role: 'assistant', content: 'a2', meta: { speaker: 'agent-a' } } },
    { hash: 'h4', def: { id: 'm4', role: 'assistant', content: 'b1', meta: { speaker: 'agent-b' } } },
  ]
  const vm = groupViewModel({
    conversation: { kind: 'group' },
    messages,
    refs,
    currentSpeakerId: 'agent-b',
    unreadIds: new Set(['m3']),
  })
  assert.equal(vm.items[0].isMe, true)
  assert.equal(vm.items[1].showName, true)
  assert.equal(vm.items[2].showName, false)
  assert.equal(vm.items[3].showName, true)
  assert.equal(vm.items[3].current, true)
  assert.equal(vm.anchorIndex, 2)
  assert.deepEqual(
    vm.participants.map((p) => p.initial),
    ['A', 'B'],
  )
  // 生成中未显式指定发言者：取最后一条参与者消息的发言者（轮转口径）
  const streaming = groupViewModel({ conversation: { kind: 'group' }, messages, refs, streaming: true })
  assert.equal(streaming.items[3].current, true)
  assert.equal(streaming.items[1].current, false)
})

// ---- 工作流 ----

test('工作流步骤卡：进度 / 节点列表 / 失败节点拒绝码', () => {
  const vm = workflowViewModel({
    conversation: { kind: 'workflow', title: '流程', workflow: { node_index: 1 }, status: 'running' },
    graphDef: { body: { nodes: [{ name: 'A', impl: 'a' }, { name: 'B', impl: 'b', status: 'failed', reject_code: 'guard_denied' }] } },
  })
  assert.equal(vm.title, 'B')
  assert.equal(vm.index, 1)
  assert.equal(vm.total, 2)
  assert.equal(vm.rejectCode, 'guard_denied')
  assert.equal(vm.failedIndex, 1)
  assert.equal(statusIcon('failed'), 'x')
  assert.equal(statusText('running'), '运行中')
})

// ---- 窗口化与胶囊 ----

test('窗口化阈值与「↓ N 条新消息」状态机', () => {
  assert.equal(shouldWindow(200), false)
  assert.equal(shouldWindow(201), true)
  assert.deepEqual(initialWindow(500), { start: 300, end: 500 })
  assert.deepEqual(olderWindow({ start: 300, end: 500 }), { start: 100, end: 500 })
  assert.deepEqual(olderWindow({ start: 0, end: 200 }), null)
  assert.equal(hasOlder({ start: 0, end: 200 }), false)
  assert.equal(hasOlder({ start: 10, end: 200 }), true)
  assert.deepEqual(sliceWindow([1, 2, 3, 4], { start: 1, end: 3 }), [2, 3])

  let pill = createNewMessageState()
  pill = onNewContent(pill, false)
  pill = onNewContent(pill, false)
  assert.equal(pill.count, 2)
  assert.equal(pillLabel(pill.count), '↓ 2 条新消息')
  pill = onNewContent(pill, true)
  assert.equal(pill.count, 0)
  assert.equal(dismissNew().count, 0)
})

// ---- 日期分隔 ----

test('日期分隔：今天 / 昨天 / 同年 MM-DD / 跨年 YYYY-MM-DD', () => {
  const now = new Date(2026, 8, 21, 12, 0, 0)
  assert.equal(dateLabel(new Date(2026, 8, 21, 9, 0, 0), now), '今天')
  assert.equal(dateLabel(new Date(2026, 8, 20, 9, 0, 0), now), '昨天')
  assert.equal(dateLabel(new Date(2026, 0, 5, 9, 0, 0), now), '01-05')
  assert.equal(dateLabel(new Date(2025, 11, 31, 9, 0, 0), now), '2025-12-31')
  assert.equal(localDateKey(new Date(2026, 8, 21)), '2026-09-21')
  const items = buildDateSeparators(
    [
      { hash: 'h1', def: { at: new Date(2026, 8, 21, 8).toISOString() } },
      { hash: 'h2', def: { at: new Date(2026, 8, 21, 9).toISOString() } },
      { hash: 'h3', def: { at: new Date(2026, 8, 20, 9).toISOString() } },
    ],
    now,
  )
  assert.equal(items.filter((item) => item.type === 'date').length, 2)
  assert.equal(items[0].label, '今天')
})

// ---- lightbox ----

test('lightbox 状态机：缩放范围 / 双击 / 平移 / 关闭', () => {
  const machine = createLightboxState()
  assert.equal(machine.get().open, false)
  machine.open('/a.png', 'alt')
  assert.equal(machine.get().open, true)
  assert.equal(machine.get().scale, 1)
  machine.zoomAt(10, 0, 0)
  assert.equal(machine.get().scale, MAX_SCALE)
  machine.zoomAt(0.001, 0, 0)
  assert.equal(machine.get().scale, MIN_SCALE)
  machine.zoomAt(1, 0, 0)
  machine.toggleDoubleClick(0, 0)
  assert.equal(machine.get().scale, 2)
  machine.toggleDoubleClick(0, 0)
  assert.equal(machine.get().scale, 1)
  machine.pan(5, -3)
  assert.equal(machine.get().tx, 5)
  assert.equal(machine.get().ty, -3)
  machine.close()
  assert.equal(machine.get().open, false)
  assert.equal(machine.get().scale, 1)
  assert.equal(machine.get().tx, 0)
})

// ---- 历史还原 ----

test('消息 refs 沿 prev 还原展示序；会话选择与线程 kind', () => {
  const history = {
    body: {
      current: 'c1',
      conversations: [
        { id: 'c1', kind: 'subagent', title: 'T', head: { def: 'h3' } },
        { id: 'c2', kind: 'group', head: { def: 'x' } },
      ],
    },
    refs: {
      h1: { id: 'm1', role: 'user', content: 'a', prev: null },
      h2: { id: 'm2', role: 'assistant', content: 'b', prev: { def: 'h1' } },
      h3: { id: 'm3', role: 'assistant', content: 'c', prev: { def: 'h2' } },
    },
  }
  assert.equal(currentConversationId(history), 'c1')
  const loaded = loadConversation(history, 'c1')
  assert.deepEqual(
    loaded.messages.map((entry) => entry.def.id),
    ['m1', 'm2', 'm3'],
  )
  assert.equal(threadKind(loaded.conversation), 'subagent')
  assert.equal(threadKind(pickConversation(history, 'c2')), 'group')
  assert.equal(threadKind(null), 'main')
  assert.equal(restoreMessages(history, { head: null }).length, 0)
  assert.equal(messageText({ content: 'x' }), 'x')
  assert.equal(messageText({ parts: [{ type: 'text', text: 'p' }] }), 'p')
})

// ---- 命令不可用 ----

test('chat.history 不可用：命令回包 error → 结构化错误（不崩）', async () => {
  const transport = {
    isConnected: () => true,
    request: async (frame) => ({
      ok: true,
      frame: { kind: 'error', id: frame.id, code: 'unknown_command', message: 'no chat.history' },
      code: '',
      message: '',
    }),
  }
  const bridge = new Bridge(transport)
  const result = await bridge.commandValue('chat.history', {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unknown_command')
  assert.equal(result.value, null)

  const interpreted = interpretResponse({ ok: true, frame: { kind: 'result', id: 'i', observations: [{ kind: 'eval', ok: true, value: { body: {} } }] }, code: '', message: '' })
  assert.equal(interpreted.ok, true)
  assert.deepEqual(extractValue(interpreted.frame), { body: {} })
})

test('入站桥帧构造与值提取', () => {
  assert.deepEqual(commandFrame('i', 'chat.history', { conversation: 'c1' }, { thread: 't' }), {
    v: '1',
    id: 'i',
    kind: 'command',
    name: 'chat.history',
    args: { conversation: 'c1' },
    thread: 't',
  })
  assert.equal(submitFrame('i', []).kind, 'submit')
  assert.equal(extractValue({ observations: [{ kind: 'extern', payload: 7 }] }), 7)
})

// ---- client.read 路径穿越防护与正常读回 ----

test('client.read：只接受包内相对 .js，拒绝绝对 / 盘符 / 反斜杠 / .. / 空段', () => {
  assert.equal(isSafeClientPath('dist/entry.js'), true)
  assert.equal(isSafeClientPath('entry.js'), true)
  assert.equal(isSafeClientPath('/etc/passwd.js'), false)
  assert.equal(isSafeClientPath('C:/x.js'), false)
  assert.equal(isSafeClientPath('c:\\x.js'), false)
  assert.equal(isSafeClientPath('..\\x.js'), false)
  assert.equal(isSafeClientPath('../plugin.json'), false)
  assert.equal(isSafeClientPath('dist/../../x.js'), false)
  assert.equal(isSafeClientPath('dist//x.js'), false)
  assert.equal(isSafeClientPath('./x.js'), false)
  assert.equal(isSafeClientPath('dist/x.ts'), false)
  assert.equal(isSafeClientPath(''), false)
  assert.equal(isSafeClientPath(null), false)
  assert.equal(isSafeClientPath(7), false)
})

test('client.read：正常读回包内文件，越界与缺失返回 null', () => {
  const dir = tempDir('client-read')
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'entry.js'), 'export const ok = 1\n', 'utf8')
  assert.equal(readClientFile(dir, 'dist/entry.js'), 'export const ok = 1\n')
  assert.equal(readClientFile(dir, '../secret.js'), null)
  assert.equal(readClientFile(dir, 'dist/nope.js'), null)
  assert.equal(resolveClientPath(dir, 'dist/entry.js'), join(dir, 'dist', 'entry.js'))
  rmSync(dir, { recursive: true, force: true })
})

// ---- 文案表 ----

test('文案表：解析 / 未知码兜底 / 界面文案本地兜底', () => {
  const table = parseMessages('{"locale":"zh-CN","unknown_command":{"title":"未知命令","body":"没有这个命令"}}')
  assert.equal(table.unknown_command.title, '未知命令')
  assert.equal(parseMessages('not json'), null)
  assert.equal(parseMessages('{"x":{"title":1}}'), null)
  assert.equal(lookupMessage(table, 'unknown_command').body, '没有这个命令')
  assert.equal(lookupMessage(table, 'no_such_code').body.includes('no_such_code'), true)
  assert.equal(lookupMessage(FALLBACK_MESSAGES, 'chat_empty_title').body, UI_TEXT.chat_empty_title)
})

// ---- 服务协议级：握手 / ping / probe / drain / EOF 自退出 ----

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

test('服务协议级：hello → manifest，ping，probe，drain → bye', async () => {
  const root = tempDir('service')
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-chat'),
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
    child.stdin.write(encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'ui-chat', gen: 'g' }))
    await waitFor(() => messages.some((message) => message.kind === 'manifest'), 'manifest')
    const manifest = messages.find((message) => message.kind === 'manifest')
    assert.equal(manifest.identity, 'ui-chat')
    assert.deepEqual(manifest.implements, ['ui-chat'])
    assert.deepEqual(manifest.methods, { 'ui-chat': ['ping', 'client.read'] })

    child.stdin.write(encodeFrame({ v: '1', id: 'c1', kind: 'call', port: 'ui-chat', method: 'ping', args: {} }))
    await waitFor(() => messages.some((message) => message.id === 'c1'), 'ping result')
    assert.equal(messages.find((message) => message.id === 'c1').value.pong, true)

    // client.read 路径穿越：越界路径结构化 bad_args，不崩进程
    child.stdin.write(encodeFrame({ v: '1', id: 'r1', kind: 'call', port: 'ui-chat', method: 'client.read', args: { path: '../plugin.json' } }))
    await waitFor(() => messages.some((message) => message.id === 'r1'), 'client.read rejection')
    assert.equal(messages.find((message) => message.id === 'r1').code, 'bad_args')

    child.stdin.write(encodeFrame({ v: '1', id: 'p1', kind: 'probe' }))
    await waitFor(() => messages.some((message) => message.id === 'p1'), 'pong')
    assert.equal(messages.find((message) => message.id === 'p1').kind, 'pong')

    child.stdin.write(encodeFrame({ v: '1', id: 'd1', kind: 'drain', deadline_ms: 100 }))
    await waitFor(() => messages.some((message) => message.id === 'd1'), 'bye')
    assert.equal(messages.find((message) => message.id === 'd1').kind, 'bye')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  } finally {
    if (child.exitCode === null) child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})

test('服务 EOF 自退出', async () => {
  const root = tempDir('eof')
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CHRONO_ROOT: root,
      CHRONO_PLUGIN_STATE: join(root, 'state', 'plugins', 'ui-chat'),
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

test('README 守卫：无计划编号 / 无计划文档引用', () => {
  const readme = readFileSync(join(PKG_ROOT, 'README.md'), 'utf8')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式 #<数字>')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})

test('界面人话单一来源守卫：视图层无散落硬编码文案', () => {
  const blacklist = [
    '播放视频', '自定义输入', '请先作答', '系统消息', '提交', '文件', '图片', '我',
    '成功', '失败', '等待审批', '跳过', '等待', '运行中', '节点列表',
    '以下为新消息', '没有更多了', '已复制', '复制失败', '仍在生成…', '已取消', '已超时',
    '媒体加载失败', '开始新对话', '正在读取…', '提交中…', '重试', '复制', '关闭', '子代理',
    '今天', '昨天',
  ]
  const files = readdirSync(WEB).filter(
    (name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && name !== 'messages.ts',
  )
  for (const name of files) {
    const source = readFileSync(join(WEB, name), 'utf8')
    for (const literal of blacklist) {
      assert.equal(
        source.includes(`'${literal}'`) || source.includes(`"${literal}"`),
        false,
        `${name} 含散落硬编码文案「${literal}」`,
      )
    }
  }
})

test('entry.tsx 导出 contract=2 / register，且不再导出 mount', () => {
  const source = readFileSync(join(WEB, 'entry.tsx'), 'utf8')
  assert.match(source, /export const contract = '2'/)
  assert.match(source, /export function register\(ctx: SlotContext\)/)
  assert.equal(/export (async )?function mount\b/.test(source), false)
  // 全仓唯一 dangerouslySetInnerHTML 处：Markdown 组件
  assert.equal((source.match(/dangerouslySetInnerHTML=\{\{/g) ?? []).length, 1)
})
