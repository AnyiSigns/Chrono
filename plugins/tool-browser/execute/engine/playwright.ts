// playwright 引擎：惰性 `import('playwright')`，自带 Chromium 由它拉起。
// 模块缺失 / 启动失败 / 平台不可用 → BrowserUnsupportedError（明确失败，不静默降级）。
// 选择器未命中或等待超时 → element_not_found；导航失败 → navigate_failed；4xx-5xx → http_status。

import { BrowserUnsupportedError, assertWaitWithinTimeout, mimeForFormat } from './types.ts'
import { ToolError } from '../types.ts'
import type { BrowserEngine, EngineConfig, ExtractResult, NavigateResult, ScreenshotResult } from './types.ts'

interface PwResponse {
  status(): number
  url(): string
}

interface PwKeyboard {
  press(key: string): Promise<void>
}

interface PwPage {
  setDefaultTimeout(ms: number): void
  setDefaultNavigationTimeout(ms: number): void
  goto(url: string, options: { waitUntil?: string; timeout?: number }): Promise<PwResponse | null>
  title(): Promise<string>
  url(): string
  click(selector: string, options?: { timeout?: number }): Promise<void>
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>
  keyboard: PwKeyboard
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  textContent(selector: string, options?: { timeout?: number }): Promise<string | null>
  getAttribute(selector: string, name: string, options?: { timeout?: number }): Promise<string | null>
  screenshot(options: { fullPage?: boolean; type?: string }): Promise<Buffer>
  close(): Promise<void>
}

interface PwContext {
  newPage(): Promise<PwPage>
  close(): Promise<void>
}

interface PwBrowser {
  newContext(options: { viewport: { width: number; height: number }; acceptDownloads?: boolean }): Promise<PwContext>
  close(): Promise<void>
}

interface PwChromium {
  launch(options: { headless?: boolean; executablePath?: string }): Promise<PwBrowser>
}

interface PwModule {
  chromium: PwChromium
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || /timeout/i.test(err.message))
}

function mapSelectorError(err: unknown, selector: string): ToolError {
  if (err instanceof ToolError) return err
  if (isTimeout(err)) return new ToolError('element_not_found', `selector not found in time: ${selector}`)
  return new ToolError('element_not_found', `selector failed: ${selector}: ${(err as Error).message}`)
}

/** playwright 引擎实例（导出供引擎级单测注入假 page）。 */
export class PlaywrightEngine implements BrowserEngine {
  private readonly browser: PwBrowser
  private readonly context: PwContext
  private readonly page: PwPage
  private readonly config: EngineConfig

  constructor(browser: PwBrowser, context: PwContext, page: PwPage, config: EngineConfig) {
    this.browser = browser
    this.context = context
    this.page = page
    this.config = config
  }

  async navigate(url: string, waitUntil?: string): Promise<NavigateResult> {
    let response: PwResponse | null
    try {
      response = await this.page.goto(url, {
        waitUntil: waitUntil ?? 'load',
        timeout: this.config.navigationTimeoutMs,
      })
    } catch (err) {
      throw new ToolError('navigate_failed', `navigation failed: ${url}: ${(err as Error).message}`)
    }
    const status = response === null ? 200 : response.status()
    if (status >= 400) {
      throw new ToolError('http_status', `navigation returned HTTP ${status}: ${url}`)
    }
    return { status, url: response === null ? this.page.url() : response.url(), title: await this.page.title() }
  }

  async click(selector: string): Promise<void> {
    try {
      await this.page.click(selector, { timeout: this.config.actionTimeoutMs })
    } catch (err) {
      throw mapSelectorError(err, selector)
    }
  }

  async type(selector: string, value: string, submit?: boolean): Promise<void> {
    try {
      await this.page.fill(selector, value, { timeout: this.config.actionTimeoutMs })
      if (submit === true) await this.page.press(selector, 'Enter', { timeout: this.config.actionTimeoutMs })
    } catch (err) {
      throw mapSelectorError(err, selector)
    }
  }

  async press(key: string): Promise<void> {
    try {
      // 真实按键：keyboard.press 走浏览器输入管线，触发默认行为（不合成 DOM 事件）。
      await this.page.keyboard.press(key)
    } catch (err) {
      throw new ToolError('tool_failed', `press failed: ${(err as Error).message}`)
    }
  }

  async waitFor(selector?: string, ms?: number): Promise<void> {
    assertWaitWithinTimeout(ms, this.config.actionTimeoutMs)
    try {
      if (typeof ms === 'number') await this.page.waitForTimeout(ms)
      if (typeof selector === 'string') {
        await this.page.waitForSelector(selector, { timeout: this.config.actionTimeoutMs })
      }
    } catch (err) {
      throw mapSelectorError(err, selector ?? '')
    }
  }

  async extract(selector?: string, attr?: string): Promise<ExtractResult> {
    const target = selector ?? 'body'
    try {
      if (typeof attr === 'string' && attr.length > 0) {
        const value = await this.page.getAttribute(target, attr, { timeout: this.config.actionTimeoutMs })
        if (value === null) throw new ToolError('element_not_found', `attribute ${attr} not found on ${target}`)
        return { value }
      }
      const text = await this.page.textContent(target, { timeout: this.config.actionTimeoutMs })
      if (text === null) throw new ToolError('element_not_found', `selector not found: ${target}`)
      return { text }
    } catch (err) {
      throw mapSelectorError(err, target)
    }
  }

  async screenshot(fullPage: boolean, format?: string): Promise<ScreenshotResult> {
    const type = format ?? this.config.screenshotFormat
    try {
      const bytes = await this.page.screenshot({ fullPage, type })
      return { bytes, mime: mimeForFormat(type) }
    } catch (err) {
      throw new ToolError('tool_failed', `screenshot failed: ${(err as Error).message}`)
    }
  }

  kill(): void {
    // 进程 exit / 硬杀时无法 await：发起关闭作最后尽力（playwright 自身也注册了退出清理）。
    void this.context.close().catch(() => undefined)
    void this.browser.close().catch(() => undefined)
  }

  async close(): Promise<void> {
    try {
      await this.context.close()
    } catch {
      // 上下文可能已随浏览器退出而关闭。
    }
    try {
      await this.browser.close()
    } catch {
      // 浏览器可能已被外部终止。
    }
  }
}

/** 惰性加载 playwright 并开一个页面。 */
export async function loadPlaywright(config: EngineConfig): Promise<BrowserEngine> {
  let module: PwModule
  try {
    module = (await import('playwright')) as unknown as PwModule
  } catch (err) {
    throw new BrowserUnsupportedError(`playwright is not available: ${(err as Error).message}`)
  }
  let browser: PwBrowser
  try {
    browser = await module.chromium.launch({
      headless: config.headless,
      ...(config.browserPath === null ? {} : { executablePath: config.browserPath }),
    })
  } catch (err) {
    throw new BrowserUnsupportedError(`playwright chromium launch failed: ${(err as Error).message}`)
  }
  let context: PwContext
  try {
    context = await browser.newContext({
      viewport: { width: config.viewport.width, height: config.viewport.height },
      acceptDownloads: config.allowDownload,
    })
  } catch (err) {
    await browser.close().catch(() => undefined)
    throw new BrowserUnsupportedError(`playwright context failed: ${(err as Error).message}`)
  }
  const page = await context.newPage()
  page.setDefaultTimeout(config.actionTimeoutMs)
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs)
  return new PlaywrightEngine(browser, context, page, config)
}
