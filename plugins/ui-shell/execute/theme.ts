// 主题：偏好归一 / 解析 + 首帧防闪脚本（ui-design §16.13）。
// 首帧脚本按 config 主题 + `prefers-color-scheme` 在 tokens 加载前写 `<html data-theme>`；
// config 未就绪时先用系统偏好，就绪后由壳页面一次性校正。解析函数与浏览器侧共用同一实现。

import { normalizeThemePref, resolveTheme } from './web/lib/theme.js'
import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export { normalizeThemePref, resolveTheme }

/** 壳页面 `<head>` 内的脚本占位符；服务端注入时替换。 */
export const THEME_PLACEHOLDER = '/*__CHRONO_THEME_SCRIPT__*/'

/**
 * 首帧内联脚本：内嵌偏好 + 系统偏好判定，首帧前写 `data-theme`。
 * 纯字符串构造，便于单测在假 document / matchMedia 上求值。
 */
export function firstFrameScript(pref: string): string {
  const normalized = normalizeThemePref(pref)
  return (
    '(function(){try{' +
    `var p=${JSON.stringify(normalized)};` +
    "var d=p==='dark'||(p!=='light'&&typeof window!=='undefined'&&window.matchMedia&&" +
    "window.matchMedia('(prefers-color-scheme: dark)').matches);" +
    "document.documentElement.setAttribute('data-theme',d?'dark':'light');" +
    '}catch(e){}})();'
  )
}

/** 把首帧脚本注入 HTML 占位符处；无占位符则在 `</head>` 前插入。 */
export function injectThemeScript(html: string, pref: string): string {
  const tag = `<script>${firstFrameScript(pref)}</script>`
  if (html.includes(THEME_PLACEHOLDER)) return html.replace(THEME_PLACEHOLDER, tag)
  const headEnd = html.indexOf('</head>')
  if (headEnd < 0) return `${tag}${html}`
  return `${html.slice(0, headEnd)}${tag}${html.slice(headEnd)}`
}

/** 从 config body 取 `ui.theme`；缺失 / 非法回落 `system`。 */
export function themePrefOfConfig(value: Json): string {
  if (!isRecord(value)) return 'system'
  const ui = value['ui']
  if (!isRecord(ui)) return 'system'
  return normalizeThemePref(ui['theme'])
}
