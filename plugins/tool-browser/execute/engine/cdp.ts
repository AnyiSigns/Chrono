// cdp 引擎：探测 / spawn 系统浏览器（自管进程），经 CDP 驱动一个页面。
// 浏览器缺失 / spawn 失败 / 无法连上调试端点 → BrowserUnsupportedError（明确失败，不静默降级）。
// 页面操作用 Runtime.evaluate 走 DOM，避免额外协议面；截图经 Page.captureScreenshot。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserUnsupportedError, assertWaitWithinTimeout, mimeForFormat } from './types.ts'
import { CdpConnection } from './cdp-connection.ts'
import { ToolError } from '../types.ts'
import type { CreationHandle } from '../creation.ts'
import type { BrowserEngine, EngineConfig, ExtractResult, NavigateResult, ScreenshotResult } from './types.ts'
import type { Json, Rec } from '../types.ts'

const CONNECT_TIMEOUT_MS = 15000
const POLL_INTERVAL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function candidatePaths(): string[] {
  const env = process.env
  if (process.platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    )
    return roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ])
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

/** 浏览器可执行文件：配置 > 环境变量 > 平台候选路径；都没有即 browser_unsupported。 */
export function findBrowser(config: EngineConfig): string {
  const explicit = config.browserPath ?? process.env['CHRONO_BROWSER_PATH'] ?? null
  if (typeof explicit === 'string' && explicit.length > 0) {
    if (existsSync(explicit)) return explicit
    throw new BrowserUnsupportedError(`browser executable not found: ${explicit}`)
  }
  const found = candidatePaths().find((path) => existsSync(path))
  if (found === undefined) {
    throw new BrowserUnsupportedError('no system browser found for cdp engine')
  }
  return found
}

/** 浏览器 profile 落点：优先本身份 ③ 目录（可重算），缺省系统临时目录。 */
function profileRoot(config: EngineConfig): string {
  if (config.stateDir === null) return tmpdir()
  const dir = join(config.stateDir, 'browser-profiles')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** spawn 浏览器并等它打印 DevTools 端点。 */
async function launchBrowser(
  executable: string,
  config: EngineConfig,
  handle: CreationHandle,
): Promise<{ child: ChildProcess; wsUrl: string; profileDir: string }> {
  const profileDir = mkdtempSync(join(profileRoot(config), 'session-'))
  const args = [
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ]
  if (config.headless) args.unshift('--headless=new')
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  // 浏览器子进程已 spawn：登记同步硬杀句柄（杀进程 + 清 profile）；建引擎途中 abort 也能触达。
  handle.register({
    kill: () => {
      try {
        child.kill()
      } catch {
        // 已退出：忽略
      }
      try {
        rmSync(profileDir, { recursive: true, force: true })
      } catch {
        // profile 目录可能已清理
      }
    },
  })
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new BrowserUnsupportedError('browser did not expose a DevTools endpoint in time'))
    }, CONNECT_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new BrowserUnsupportedError('browser exited before DevTools endpoint was ready'))
    })
    child.once('error', (err: Error) => {
      clearTimeout(timer)
      reject(new BrowserUnsupportedError(`cannot spawn browser: ${err.message}`))
    })
  }).catch((err: unknown) => {
    rmSync(profileDir, { recursive: true, force: true })
    throw err
  })
  return { child, wsUrl, profileDir }
}

/** CDP `Input.dispatchKeyEvent` 的按键描述。 */
export interface CdpKeySpec {
  key: string
  code?: string
  windowsVirtualKeyCode?: number
  text?: string
}

const NAMED_KEYS: Record<string, CdpKeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
}

/** 把按键名映射为 CDP 事件字段；单字符键带 `text`，其余只带 `key`。 */
export function cdpKeySpec(key: string): CdpKeySpec {
  const named = NAMED_KEYS[key]
  if (named !== undefined) return named
  if (key.length === 1) {
    const upper = key.toUpperCase()
    return { key, code: /[a-z]/i.test(key) ? `Key${upper}` : undefined, text: key }
  }
  return { key }
}

/** CDP 引擎实例（导出供引擎级单测注入假连接）。 */
export class CdpEngine implements BrowserEngine {
  private readonly child: ChildProcess
  private readonly profileDir: string
  private readonly connection: CdpConnection
  private readonly sessionId: string
  private readonly config: EngineConfig

  constructor(
    child: ChildProcess,
    profileDir: string,
    connection: CdpConnection,
    sessionId: string,
    config: EngineConfig,
  ) {
    this.child = child
    this.profileDir = profileDir
    this.connection = connection
    this.sessionId = sessionId
    this.config = config
  }

  private evaluate(expression: string): Promise<Json> {
    return this.connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.sessionId).then((result) => {
      const rec = result as Rec | null
      if (rec !== null && typeof rec === 'object' && rec['exceptionDetails'] !== undefined) {
        const details = rec['exceptionDetails'] as Rec
        throw new ToolError('tool_failed', `page script failed: ${JSON.stringify(details['exception'] ?? details)}`)
      }
      const inner = rec !== null && typeof rec === 'object' ? (rec['result'] as Rec | undefined) : undefined
      return (inner?.['value'] ?? null) as Json
    })
  }

  async navigate(url: string, waitUntil?: string): Promise<NavigateResult> {
    const loaded = this.waitForLoad()
    // 导航提前失败时不再 await 该等待，先吞掉它的拒绝，避免未处理拒绝。
    loaded.catch(() => undefined)
    let navigation: Json
    try {
      navigation = await this.connection.send('Page.navigate', { url }, this.sessionId, this.config.navigationTimeoutMs)
    } catch (err) {
      throw new ToolError('navigate_failed', `navigation failed: ${url}: ${(err as Error).message}`)
    }
    const errorText = (navigation as Rec | null)?.['errorText']
    if (typeof errorText === 'string' && errorText.length > 0) {
      throw new ToolError('navigate_failed', `navigation failed: ${url}: ${errorText}`)
    }
    if (waitUntil !== 'domcontentloaded' && waitUntil !== 'commit') {
      await loaded
    }
    const info = await this.evaluate(
      '(() => { const entry = performance.getEntriesByType("navigation")[0]; return { href: location.href, title: document.title, status: entry && entry.responseStatus ? entry.responseStatus : 0 } })()',
    )
    const rec = (info ?? {}) as Rec
    const status = typeof rec['status'] === 'number' && rec['status'] > 0 ? rec['status'] : 200
    if (status >= 400) throw new ToolError('http_status', `navigation returned HTTP ${status}: ${url}`)
    return {
      status,
      url: typeof rec['href'] === 'string' ? rec['href'] : url,
      title: typeof rec['title'] === 'string' ? rec['title'] : '',
    }
  }

  private waitForLoad(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const off = this.connection.on((event) => {
        if (event.method === 'Page.loadEventFired') {
          off()
          clearTimeout(timer)
          resolve()
        }
      })
      const timer = setTimeout(() => {
        off()
        reject(new ToolError('navigate_failed', 'page load timed out'))
      }, this.config.navigationTimeoutMs)
    })
  }

  async click(selector: string): Promise<void> {
    const found = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`,
    )
    if (found !== true) throw new ToolError('element_not_found', `selector not found: ${selector}`)
  }

  async type(selector: string, value: string, submit?: boolean): Promise<void> {
    const ok = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;` +
        ` const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;` +
        ` const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;` +
        ` if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};` +
        ` el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`,
    )
    if (ok !== true) throw new ToolError('element_not_found', `selector not found: ${selector}`)
    if (submit === true) {
      await this.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const form = el && (el.form || (el.closest && el.closest('form')));` +
          ` if (!form) return false; if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit(); return true })()`,
      )
    }
  }

  async press(key: string): Promise<void> {
    // 真实按键：走 CDP Input.dispatchKeyEvent（keyDown/keyUp），触发浏览器默认行为；
    // 不再用 Runtime.evaluate 合成 KeyboardEvent（合成事件不触发默认行为）。
    const spec = cdpKeySpec(key)
    const base: Rec = { key: spec.key }
    if (spec.code !== undefined) base['code'] = spec.code
    if (spec.windowsVirtualKeyCode !== undefined) {
      base['windowsVirtualKeyCode'] = spec.windowsVirtualKeyCode
      base['nativeVirtualKeyCode'] = spec.windowsVirtualKeyCode
    }
    const down: Rec = { ...base, type: 'keyDown' }
    if (spec.text !== undefined) down['text'] = spec.text
    const up: Rec = { ...base, type: 'keyUp' }
    await this.connection.send('Input.dispatchKeyEvent', down, this.sessionId, this.config.actionTimeoutMs)
    await this.connection.send('Input.dispatchKeyEvent', up, this.sessionId, this.config.actionTimeoutMs)
  }

  async waitFor(selector?: string, ms?: number): Promise<void> {
    assertWaitWithinTimeout(ms, this.config.actionTimeoutMs)
    if (typeof ms === 'number') {
      await sleep(ms)
      if (typeof selector !== 'string') return
    }
    if (typeof selector !== 'string') return
    const attempts = Math.max(1, Math.ceil(this.config.actionTimeoutMs / POLL_INTERVAL_MS))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
      if (found === true) return
      if (attempt < attempts - 1) await sleep(POLL_INTERVAL_MS)
    }
    throw new ToolError('element_not_found', `selector not found in time: ${selector}`)
  }

  async extract(selector?: string, attr?: string): Promise<ExtractResult> {
    const target = selector ?? 'body'
    const encoded = JSON.stringify(target)
    if (typeof attr === 'string' && attr.length > 0) {
      const value = await this.evaluate(
        `(() => { const el = document.querySelector(${encoded}); return el ? el.getAttribute(${JSON.stringify(attr)}) : null })()`,
      )
      if (value === null) throw new ToolError('element_not_found', `attribute ${attr} not found on ${target}`)
      return { value: String(value) }
    }
    const text = await this.evaluate(
      `(() => { const el = document.querySelector(${encoded}); if (!el) return null; return el.innerText !== undefined ? el.innerText : el.textContent })()`,
    )
    if (text === null) throw new ToolError('element_not_found', `selector not found: ${target}`)
    return { text: String(text) }
  }

  async screenshot(fullPage: boolean, format?: string): Promise<ScreenshotResult> {
    const type = format ?? this.config.screenshotFormat
    const result = await this.connection.send(
      'Page.captureScreenshot',
      { format: type, captureBeyondViewport: fullPage },
      this.sessionId,
      this.config.actionTimeoutMs,
    )
    const data = (result as Rec | null)?.['data']
    if (typeof data !== 'string') throw new ToolError('tool_failed', 'screenshot returned no data')
    return { bytes: Buffer.from(data, 'base64'), mime: mimeForFormat(type) }
  }

  kill(): void {
    try {
      this.connection.close()
    } catch {
      // 连接可能已关闭。
    }
    try {
      this.child.kill()
    } catch {
      // 已退出。
    }
    try {
      rmSync(this.profileDir, { recursive: true, force: true })
    } catch {
      // profile 目录可能已清理。
    }
  }

  async close(): Promise<void> {
    try {
      await this.connection.send('Browser.close', {}, undefined, 2000)
    } catch {
      // 浏览器可能已退出。
    }
    this.connection.close()
    try {
      this.child.kill()
    } catch {
      // 已退出。
    }
    rmSync(this.profileDir, { recursive: true, force: true })
  }
}

/** 探测系统浏览器、spawn、连上 CDP 并开一个页面。 */
export async function loadCdp(config: EngineConfig, handle: CreationHandle): Promise<BrowserEngine> {
  const executable = findBrowser(config)
  const { child, wsUrl, profileDir } = await launchBrowser(executable, config, handle)
  let connection: CdpConnection
  try {
    connection = await CdpConnection.connect(wsUrl, CONNECT_TIMEOUT_MS)
  } catch (err) {
    child.kill()
    rmSync(profileDir, { recursive: true, force: true })
    throw err
  }
  // 连接已建立：登记同步关闭，建引擎途中 abort 时一并断开。
  handle.register({ kill: () => connection.close() })
  try {
    const target = (await connection.send('Target.createTarget', { url: 'about:blank' })) as Rec
    const targetId = target['targetId']
    if (typeof targetId !== 'string') throw new BrowserUnsupportedError('CDP createTarget returned no targetId')
    const attached = (await connection.send('Target.attachToTarget', { targetId, flatten: true })) as Rec
    const sessionId = attached['sessionId']
    if (typeof sessionId !== 'string') throw new BrowserUnsupportedError('CDP attachToTarget returned no sessionId')
    await connection.send('Page.enable', {}, sessionId)
    await connection.send('Runtime.enable', {}, sessionId)
    await connection.send(
      'Emulation.setDeviceMetricsOverride',
      { width: config.viewport.width, height: config.viewport.height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    return new CdpEngine(child, profileDir, connection, sessionId, config)
  } catch (err) {
    connection.close()
    child.kill()
    rmSync(profileDir, { recursive: true, force: true })
    if (err instanceof BrowserUnsupportedError || err instanceof ToolError) throw err
    throw new BrowserUnsupportedError(`CDP setup failed: ${(err as Error).message}`)
  }
}
