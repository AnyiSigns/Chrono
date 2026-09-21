// 服务默认配置：启动时读一次同包 schema/tool-browser.json（引擎选型 / 无头 / 视口 / 超时 / 空闲回收 / 截图格式 / 下载）。
// schema 出生即冻结，改动随代码换代；配置只作缺省，运行期不热读。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import { resolveStateDir } from './state-dir.ts'
import type { Json, Rec } from './types.ts'

export interface ViewportConfig {
  width: number
  height: number
}

export interface BrowserConfig {
  impl: string
  headless: boolean
  browserPath: string | null
  viewport: ViewportConfig
  navigationTimeoutMs: number
  actionTimeoutMs: number
  sessionIdleMs: number
  screenshotFormat: string
  allowDownload: boolean
  /** 本身份 ③ 目录（浏览器 profile 落点）；宿主未注入时为 null。 */
  stateDir: string | null
}

export const DEFAULT_CONFIG: BrowserConfig = {
  impl: 'playwright',
  headless: true,
  browserPath: null,
  viewport: { width: 1280, height: 720 },
  navigationTimeoutMs: 30000,
  actionTimeoutMs: 10000,
  sessionIdleMs: 300000,
  screenshotFormat: 'png',
  allowDownload: false,
  stateDir: null,
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSchema(): Rec {
  try {
    const text = readFileSync(new URL('../schema/tool-browser.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read schema/tool-browser.json: ${(err as Error).message}`)
  }
  return {}
}

function positiveInt(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function bool(value: Json | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function text(value: Json | undefined, fallback: string | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function parseViewport(raw: Json | undefined): ViewportConfig {
  if (!isRecord(raw)) return DEFAULT_CONFIG.viewport
  return {
    width: positiveInt(raw['width'], DEFAULT_CONFIG.viewport.width),
    height: positiveInt(raw['height'], DEFAULT_CONFIG.viewport.height),
  }
}

/** 读同包 schema，逐段回落内建缺省。 */
export function loadConfig(): BrowserConfig {
  const schema = readSchema()
  const engine = schema['engine']
  const timeouts = schema['timeouts']
  const screenshot = schema['screenshot']
  const download = schema['download']
  const impl = isRecord(engine) ? text(engine['impl'], DEFAULT_CONFIG.impl) : DEFAULT_CONFIG.impl
  return {
    impl: impl ?? DEFAULT_CONFIG.impl,
    headless: isRecord(engine) ? bool(engine['headless'], DEFAULT_CONFIG.headless) : DEFAULT_CONFIG.headless,
    browserPath: isRecord(engine) ? text(engine['browser_path'], null) : null,
    viewport: parseViewport(schema['viewport']),
    navigationTimeoutMs: isRecord(timeouts)
      ? positiveInt(timeouts['navigation_ms'], DEFAULT_CONFIG.navigationTimeoutMs)
      : DEFAULT_CONFIG.navigationTimeoutMs,
    actionTimeoutMs: isRecord(timeouts)
      ? positiveInt(timeouts['action_ms'], DEFAULT_CONFIG.actionTimeoutMs)
      : DEFAULT_CONFIG.actionTimeoutMs,
    sessionIdleMs: isRecord(timeouts)
      ? positiveInt(timeouts['session_idle_ms'], DEFAULT_CONFIG.sessionIdleMs)
      : DEFAULT_CONFIG.sessionIdleMs,
    screenshotFormat: isRecord(screenshot)
      ? text(screenshot['format'], DEFAULT_CONFIG.screenshotFormat) ?? DEFAULT_CONFIG.screenshotFormat
      : DEFAULT_CONFIG.screenshotFormat,
    allowDownload: isRecord(download)
      ? bool(download['allow'], DEFAULT_CONFIG.allowDownload)
      : DEFAULT_CONFIG.allowDownload,
    stateDir: resolveStateDir(),
  }
}
