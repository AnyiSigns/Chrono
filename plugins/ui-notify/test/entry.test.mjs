// 浏览器 bundle 形态：可作 ESM 加载、自初始化、不导出 mount、单文件无相对 import。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const entryPath = join(pkgRoot, 'web', 'entry.js')
const entryUrl = pathToFileURL(entryPath).href

test('entry.js 可被浏览器模块加载（Node ESM 等价校验）', async () => {
  const mod = await import(entryUrl)
  for (const name of ['classify', 'evaluate', 'resolveSwitches', 'NotificationThrottle', 'createRuntime', 'init', 'publishState']) {
    assert.equal(typeof mod[name], 'function', `缺少导出 ${name}`)
  }
  assert.equal(mod.mount, undefined, 'headless 入口不得导出 mount（不 mount slot）')
})

test('entry.js 在 Node 下不因缺 window 而抛错（自初始化有浏览器守卫）', async () => {
  await assert.doesNotReject(() => import(entryUrl))
})

test('entry.js 是单文件 bundle：无相对 / 裸模块 import', () => {
  const source = readFileSync(entryPath, 'utf8')
  assert.ok(!/^\s*import\s+.*\sfrom\s+['"]\./m.test(source), '含相对 import')
  assert.ok(!/^\s*import\s+['"]/m.test(source), '含裸模块 import')
})

test('entry.js 通过 vm.SourceTextModule 语法编译（若运行时可提供）', () => {
  if (typeof vm.SourceTextModule !== 'function') {
    assert.ok(true, '当前 Node 未暴露 vm.SourceTextModule，跳过')
    return
  }
  const source = readFileSync(entryPath, 'utf8')
  assert.doesNotThrow(() => new vm.SourceTextModule(source, { identifier: entryPath }))
})

test('窗口焦点变化即时刷新：失焦后事件可弹，重新聚焦后排队项按门控抑制', async () => {
  const { init } = await import(entryUrl)
  const created = []
  const listeners = {}
  const sources = []
  let focused = false
  class FakeNotification {
    static permission = 'granted'
    constructor(title, options) {
      this.title = title
      this.options = options
      this.onclick = null
      this.onclose = null
      created.push(this)
    }
    close() {}
  }
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.onmessage = null
      sources.push(this)
    }
  }
  const win = {
    Notification: FakeNotification,
    EventSource: FakeEventSource,
    CustomEvent: class {
      constructor(type, initValue) {
        this.type = type
        this.detail = initValue?.detail
      }
    },
    dispatchEvent() {},
    document: { hasFocus: () => focused },
    addEventListener: (type, callback) => {
      listeners[type] = callback
    },
    fetch: async (url) => ({
      ok: true,
      json: async () => (url.includes('messages') ? {} : { ok: true, value: {} }),
    }),
  }

  await init(win)
  assert.equal(typeof listeners.focus, 'function', '应订阅窗口 focus')
  assert.equal(typeof listeners.blur, 'function', '应订阅窗口 blur')
  assert.equal(sources.length, 1)

  const send = (thread) =>
    sources[0].onmessage({
      data: JSON.stringify({ impl: 'approval', topic: 'approval.pending', payload: { kind: 'tool_call', thread } }),
    })

  send('a')
  send('b')
  send('c')
  send('d')
  assert.equal(created.length, 3, '失焦时前三条即时弹，第四条排队')
  assert.equal(created.map((item) => item.options.tag).join(','), 'a|approval_pending,b|approval_pending,c|approval_pending')

  // 焦点变化不经过事件流：仅靠 focus / blur 订阅刷新运行时状态
  focused = true
  listeners.focus()

  created[0].onclose()
  assert.equal(created.length, 3, '聚焦后排队项应被门控抑制，不新增通知')
})

test('点击通知聚焦 shell，且不挂操作按钮', async () => {
  const { attachHandlers, notificationContent } = await import(entryUrl)
  let focused = false
  const win = { focus: () => { focused = true } }
  const notification = { onclick: null, body: '' }
  attachHandlers(notification, win)
  notification.onclick()
  assert.equal(focused, true)
  const content = notificationContent({ kind: 'run_failed', title: '回合失败', thread: 't1', summary: '' }, 1)
  assert.deepEqual(Object.keys(content).sort(), ['body', 'title'])
})
