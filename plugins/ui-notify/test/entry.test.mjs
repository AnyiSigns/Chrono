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
