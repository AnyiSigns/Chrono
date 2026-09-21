// 引擎级测试（注入假 page / 假 CDP 连接）：
// ① `press` 走真实按键接口（playwright keyboard.press / CDP Input.dispatchKeyEvent），不合成 DOM 事件；
// ② `wait_for` 的 `ms` 两引擎统一：等满请求毫秒数，超单动作超时回 tool_timeout（不静默缩短）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlaywrightEngine } from '../execute/engine/playwright.ts'
import { CdpEngine, cdpKeySpec } from '../execute/engine/cdp.ts'
import { ToolError } from '../execute/types.ts'

const CONFIG = {
  impl: 'test',
  headless: true,
  browserPath: null,
  viewport: { width: 800, height: 600 },
  navigationTimeoutMs: 1000,
  actionTimeoutMs: 1000,
  screenshotFormat: 'png',
  allowDownload: false,
  stateDir: null,
}

function fakePlaywrightPage() {
  const calls = []
  const page = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto() {
      return { status: () => 200, url: () => 'https://x.test' }
    },
    async title() {
      return 't'
    },
    url() {
      return 'https://x.test'
    },
    async click() {},
    async fill() {},
    async press() {},
    keyboard: {
      async press(key, options) {
        calls.push({ op: 'keyboard.press', key, options })
      },
    },
    async waitForSelector() {},
    async waitForTimeout(ms) {
      calls.push({ op: 'waitForTimeout', ms })
    },
    async textContent() {
      return 'x'
    },
    async getAttribute() {
      return 'v'
    },
    async evaluate(expression) {
      calls.push({ op: 'evaluate', expression })
      return undefined
    },
    async screenshot() {
      return Buffer.from('x')
    },
    async close() {},
  }
  return { page, calls }
}

function playwrightEngine(page) {
  const browser = { async close() {}, async newContext() { throw new Error('unused') } }
  const context = { async close() {}, async newPage() { throw new Error('unused') } }
  return new PlaywrightEngine(browser, context, page, CONFIG)
}

function fakeCdpConnection() {
  const calls = []
  return {
    calls,
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId })
      return {}
    },
    on() {
      return () => {}
    },
    close() {},
  }
}

function cdpEngine(connection) {
  const child = { kill() {} }
  return new CdpEngine(child, 'C:\\tmp\\profile', connection, 'session-1', CONFIG)
}

test('playwright press 用 keyboard.press（真实按键），不合成 KeyboardEvent', async () => {
  const { page, calls } = fakePlaywrightPage()
  await playwrightEngine(page).press('Enter')
  assert.deepEqual(
    calls.map((call) => call.op),
    ['keyboard.press'],
  )
  assert.equal(calls[0].key, 'Enter')
})

test('cdp press 用 Input.dispatchKeyEvent（keyDown + keyUp），不合成 KeyboardEvent', async () => {
  const connection = fakeCdpConnection()
  await cdpEngine(connection).press('Enter')
  const methods = connection.calls.map((call) => call.method)
  assert.deepEqual(methods, ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent'])
  assert.equal(connection.calls[0].params.type, 'keyDown')
  assert.equal(connection.calls[0].params.key, 'Enter')
  assert.equal(connection.calls[0].params.windowsVirtualKeyCode, 13)
  assert.equal(connection.calls[1].params.type, 'keyUp')
  assert.ok(!methods.includes('Runtime.evaluate'), 'press 不应走 Runtime.evaluate 合成事件')
})

test('cdpKeySpec：命名键与单字符键映射', () => {
  assert.deepEqual(cdpKeySpec('Tab'), { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  assert.equal(cdpKeySpec('a').text, 'a')
  assert.equal(cdpKeySpec('a').code, 'KeyA')
  assert.deepEqual(cdpKeySpec('F13'), { key: 'F13' })
})

test('playwright wait_for：等满 ms；超单动作超时回 tool_timeout', async () => {
  const { page, calls } = fakePlaywrightPage()
  const engine = playwrightEngine(page)
  await engine.waitFor(undefined, 250)
  assert.deepEqual(calls, [{ op: 'waitForTimeout', ms: 250 }])

  await assert.rejects(
    () => engine.waitFor(undefined, 1001),
    (err) => err instanceof ToolError && err.code === 'tool_timeout',
  )
})

test('cdp wait_for：等满 ms（不静默钳到超时值）；超单动作超时回 tool_timeout', async () => {
  const connection = fakeCdpConnection()
  const engine = cdpEngine(connection)
  const started = Date.now()
  await engine.waitFor(undefined, 60)
  assert.ok(Date.now() - started >= 55, '应等满请求的毫秒数，不被静默缩短')

  await assert.rejects(
    () => engine.waitFor(undefined, 1001),
    (err) => err instanceof ToolError && err.code === 'tool_timeout',
  )
})
