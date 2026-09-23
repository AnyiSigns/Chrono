// 静态资源读取与降级：
// tokens 失败 → 内联最小 token；icons 失败 → 空 sprite（图标位留空、保留 aria-label）；
// messages 失败 → 内置最小文案表（见 messages.ts）。三者均不阻塞功能。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AssetContent {
  text: string
  fallback: boolean
}

/** 包内 `execute/web/` 绝对路径（以模块位置为准，与 cwd 无关）。 */
export function webDirOf(): string {
  return fileURLToPath(new URL('./web/', import.meta.url))
}

/** tokens 失败时的内联最小 token（至少 --c-bg / --c-surface / --c-text / --c-border）。 */
export const MINIMAL_TOKENS = [
  ':root{',
  '--c-bg:#FAFAF9;--c-surface:#FDFDFC;--c-text:#1F1E1C;--c-border:#E3E2DF;',
  '--c-text-2:#6E6D69;--c-accent:#46548C;--c-accent-text:#FFFFFF;',
  '}',
  '[data-theme="dark"]{',
  '--c-bg:#171615;--c-surface:#1E1D1B;--c-text:#E8E6E3;--c-border:rgba(255,255,255,.10);',
  '--c-text-2:#A3A19B;--c-accent:#8E9BD4;--c-accent-text:#1A1A24;',
  '}',
  '@media (prefers-color-scheme: dark){',
  ':root:not([data-theme="light"]){',
  '--c-bg:#171615;--c-surface:#1E1D1B;--c-text:#E8E6E3;--c-border:rgba(255,255,255,.10);',
  '--c-text-2:#A3A19B;--c-accent:#8E9BD4;--c-accent-text:#1A1A24;',
  '}',
  '}',
  '',
].join('\n')

/** icons 失败时的空 sprite：`<use>` 无解析目标 → 图标位留空，aria-label 仍在元素上。 */
export const EMPTY_SPRITE = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none"></svg>\n'

/** 读一个静态文本资源；失败回落给定兜底内容（fallback=true）。 */
export function readAsset(webDir: string, name: string, fallback: string): AssetContent {
  try {
    return { text: readFileSync(join(webDir, name), 'utf8'), fallback: false }
  } catch {
    return { text: fallback, fallback: true }
  }
}

export function loadTokens(webDir: string): AssetContent {
  return readAsset(webDir, 'tokens.v1.css', MINIMAL_TOKENS)
}

export function loadIcons(webDir: string): AssetContent {
  return readAsset(webDir, 'icons.v2.svg', EMPTY_SPRITE)
}

export function loadFavicon(webDir: string): AssetContent {
  return readAsset(webDir, 'favicon.svg', EMPTY_SPRITE)
}

/** 壳页面模板；缺失时返回一个最小可用页（保证 `/` 不空）。 */
export function loadShellHtml(webDir: string): AssetContent {
  const minimal =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Chrono</title></head><body><main id="main" data-slot="main"></main></body></html>'
  return readAsset(webDir, 'shell.html', minimal)
}

/** 共享前端库文件（`web/lib/*.js`）白名单名。 */
export const LIB_NAME_RE = /^[a-z0-9-]+\.js$/

export function loadLib(webDir: string, name: string): AssetContent | null {
  if (!LIB_NAME_RE.test(name)) return null
  try {
    return { text: readFileSync(join(webDir, 'lib', name), 'utf8'), fallback: false }
  } catch {
    return null
  }
}

/** vendor 运行时产物（`web/vendor/*.js`）白名单名；构建期由 tools/build-vendor.mjs 产出。 */
export const VENDOR_NAME_RE = /^[a-z0-9.-]+\.js$/

export function loadVendor(webDir: string, name: string): AssetContent | null {
  if (!VENDOR_NAME_RE.test(name)) return null
  try {
    return { text: readFileSync(join(webDir, 'vendor', name), 'utf8'), fallback: false }
  } catch {
    return null
  }
}
