// 主题动作：config 用户语义 `day` / `night` / `system` ↔ 壳 DOM 偏好 `light` / `dark` / `system`。
// 壳的 `api.theme.set` 自身即一次 config 写（`ui.theme` 落 day/night/system），故有壳时不再直写 config；
// 无壳时退化为客户端直写。`boot_mode` 由壳读 config 重推，本插件不写 `api.uiState`。

import { emptyConfig, isRecord, setUiField, themeCardOf } from './config-model.js'

/** 当前主题卡片 id（config `ui.theme`，兼容壳落 DOM 的 light / dark 词表）。 */
export function currentThemePref(ctx) {
  const ui = isRecord(ctx.state.config) && isRecord(ctx.state.config.ui) ? ctx.state.config.ui : {}
  return themeCardOf(ui.theme)
}

/** 卡片 id → 壳偏好（light / dark / system）。 */
function shellThemePref(card) {
  if (card === 'day') return 'light'
  if (card === 'night') return 'dark'
  return 'system'
}

/** 切主题：有壳走 `api.theme.set`（唯一 config 写），否则客户端直写。 */
export async function setTheme(ctx, card) {
  const canShell =
    ctx.api !== null && ctx.api !== undefined && isRecord(ctx.api.theme) && typeof ctx.api.theme.set === 'function'
  if (canShell) {
    await ctx.api.theme.set(shellThemePref(card))
    ctx.state.config = setUiField(ctx.state.config ?? emptyConfig(), 'theme', card)
    ctx.markSaved('theme')
    return
  }
  if (card !== 'system' && typeof ctx.doc.defaultView?.matchMedia === 'function') {
    ctx.doc.documentElement.setAttribute('data-theme', card === 'night' ? 'dark' : 'light')
  }
  await ctx.writeConfig(setUiField(ctx.state.config ?? emptyConfig(), 'theme', card), 'theme')
}
