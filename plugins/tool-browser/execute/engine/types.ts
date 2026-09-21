// 浏览器引擎抽象：会话内的页面操作面。生产实现按 schema impl 惰性加载，
// 不可用即明确 browser_unsupported；单测注入假引擎覆盖全部 action 与会话生命周期。

import type { ViewportConfig } from '../config.ts'
import { ToolError } from '../types.ts'

/** 引擎实例化配置（来自 schema 缺省 + open 的视口覆盖）。 */
export interface EngineConfig {
  impl: string
  headless: boolean
  browserPath: string | null
  viewport: ViewportConfig
  navigationTimeoutMs: number
  actionTimeoutMs: number
  screenshotFormat: string
  allowDownload: boolean
  /** 本身份 ③ 目录（浏览器 profile 落点）；null 时用系统临时目录。 */
  stateDir: string | null
}

/** 导航结果：HTTP 状态 + 落地 URL + 标题。 */
export interface NavigateResult {
  status: number
  url: string
  title: string
}

/** 抽取结果：无 attr 回文本，有 attr 回属性值。 */
export interface ExtractResult {
  text?: string
  value?: string
}

/** 截图结果：原始字节 + MIME。 */
export interface ScreenshotResult {
  bytes: Buffer
  mime: string
}

/**
 * 一个会话对应一个引擎实例（一个浏览器上下文 / 页面）。
 * 动作失败抛 `ToolError`（navigate_failed / http_status / element_not_found / tool_timeout）；
 * 引擎 / 平台不可用抛 `BrowserUnsupportedError`。
 */
export interface BrowserEngine {
  navigate(url: string, waitUntil?: string): Promise<NavigateResult>
  click(selector: string): Promise<void>
  type(selector: string, text: string, submit?: boolean): Promise<void>
  press(key: string): Promise<void>
  waitFor(selector?: string, ms?: number): Promise<void>
  extract(selector?: string, attr?: string): Promise<ExtractResult>
  screenshot(fullPage: boolean, format?: string): Promise<ScreenshotResult>
  /** 同步兜底终止（进程 exit / 硬杀信号，不能 await）；尽力杀浏览器子进程 / 句柄。 */
  kill(): void
  close(): Promise<void>
}

/**
 * `wait_for` 的 `ms` 语义统一：等满请求的毫秒数，但请求时长不得超过单动作超时；
 * 超出即 `tool_timeout`（不静默钳到超时值）。两引擎共用，保证口径一致。
 */
export function assertWaitWithinTimeout(ms: number | undefined, actionTimeoutMs: number): void {
  if (typeof ms === 'number' && ms > actionTimeoutMs) {
    throw new ToolError('tool_timeout', `wait_for ${ms}ms exceeds action timeout ${actionTimeoutMs}ms`)
  }
}

/** 引擎加载器：按配置造一个已就绪的引擎实例。 */
export type EngineLoader = (config: EngineConfig) => Promise<BrowserEngine>

/** 引擎 / 平台不可用：明确失败，不静默降级。 */
export class BrowserUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserUnsupportedError'
  }
}

/** 由格式名推 MIME；未知按 png。 */
export function mimeForFormat(format: string): string {
  return format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png'
}
