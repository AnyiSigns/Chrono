// 静态资源读取与降级：
// tokens 失败 → 内联最小 token；icons 失败 → 空 sprite（图标位留空、保留 aria-label）；
// messages 失败 → 内置最小文案表（见 messages.ts）。三者均不阻塞功能。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FALLBACK_MESSAGES } from './messages.ts'

export interface AssetContent {
  text: string
  fallback: boolean
}

/** 一个壳静态资源的单一登记项：内容类型 + 读取（含降级）。新增资源只加一项，路由与投递自动覆盖。 */
export interface AssetSpec {
  name: string
  contentType: string
  load(webDir: string): AssetContent
}

/** 包内 `execute/web/` 绝对路径（以模块位置为准，与 cwd 无关）。 */
export function webDirOf(): string {
  return fileURLToPath(new URL('./web/', import.meta.url))
}

/** tokens 失败时的内联最小 token（至少 --c-bg / --c-surface / --c-text / --c-border）。 */
export const MINIMAL_TOKENS = [
  ':root{',
  '--c-bg:#FAFAF9;--c-surface:#FDFDFC;--c-text:#1F1E1C;--c-border:#E3E2DF;',
  '--c-text-2:#6E6D69;--c-accent:#C9B291;--c-accent-text:#2A1F12;--c-accent-strong:#846632;',
  '--c-gloss-hi:rgba(255,255,255,.62);--c-gloss-lo:rgba(96,68,24,.22);',
  '--c-send-fill:color-mix(in srgb,#C9B291 62%,transparent);',
  '}',
  '[data-theme="dark"]{',
  '--c-bg:#171615;--c-surface:#1E1D1B;--c-text:#E8E6E3;--c-border:rgba(255,255,255,.10);',
  '--c-text-2:#A3A19B;--c-accent:#CBB496;--c-accent-text:#241A0C;--c-accent-strong:#D4BE9A;',
  '--c-gloss-hi:rgba(255,255,255,.20);--c-gloss-lo:rgba(0,0,0,.40);',
  '--c-send-fill:color-mix(in srgb,#CBB496 74%,transparent);',
  '}',
  '@media (prefers-color-scheme: dark){',
  ':root:not([data-theme="light"]){',
  '--c-bg:#171615;--c-surface:#1E1D1B;--c-text:#E8E6E3;--c-border:rgba(255,255,255,.10);',
  '--c-text-2:#A3A19B;--c-accent:#CBB496;--c-accent-text:#241A0C;--c-accent-strong:#D4BE9A;',
  '--c-gloss-hi:rgba(255,255,255,.20);--c-gloss-lo:rgba(0,0,0,.40);',
  '--c-send-fill:color-mix(in srgb,#CBB496 74%,transparent);',
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

/**
 * 壳静态资源总表（单一来源）：路由判定与投递都从这里派生，避免「新增一个资源要改 routes.ts 与
 * http-server.ts 两处」。顺序即声明顺序，确定性。
 */
export const SHELL_ASSETS: readonly AssetSpec[] = [
  { name: 'tokens.v1.css', contentType: 'text/css; charset=utf-8', load: loadTokens },
  { name: 'icons.v2.svg', contentType: 'image/svg+xml; charset=utf-8', load: loadIcons },
  { name: 'messages.v1.json', contentType: 'application/json; charset=utf-8', load: loadMessages },
  { name: 'favicon.svg', contentType: 'image/svg+xml; charset=utf-8', load: loadFavicon },
]

export const ASSET_NAMES: readonly string[] = SHELL_ASSETS.map((spec) => spec.name)

/** 按名取资源登记项；未登记返回 null。 */
export function assetOf(name: string): AssetSpec | null {
  for (const spec of SHELL_ASSETS) {
    if (spec.name === name) return spec
  }
  return null
}

/** messages 既是文案表又是静态资源：读失败回落内置最小表（见 messages.ts）。 */
function loadMessages(webDir: string): AssetContent {
  return readAsset(webDir, 'messages.v1.json', JSON.stringify(FALLBACK_MESSAGES, null, 2))
}

/**
 * 各资源的内容版本（内容 sha256 前 12 位；读不到时用 `fallback`）。
 * 浏览器经 `?v=<version>` 请求，内容变则 URL 变——`no-store` 之外的第二道缓存保险；
 * 版本只由字节决定，同内容同版本，确定性。
 */
export function assetVersions(webDir: string): { [name: string]: string } {
  const out: { [name: string]: string } = {}
  for (const spec of SHELL_ASSETS) {
    const content = spec.load(webDir)
    out[spec.name] = content.fallback
      ? 'fallback'
      : createHash('sha256').update(content.text, 'utf8').digest('hex').slice(0, 12)
  }
  return out
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
