// 主题偏好归一与解析（壳页面与壳服务共用同一实现）。
// 偏好三值 light / dark / system；system 跟随 prefers-color-scheme。

export const THEME_PREFS = ['light', 'dark', 'system']

/** 归一主题偏好；未知值回落 `system`。 */
export function normalizeThemePref(value) {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** 解析实际主题：`system` 跟随系统偏好。 */
export function resolveTheme(pref, prefersDark) {
  const normalized = normalizeThemePref(pref)
  if (normalized === 'light') return 'light'
  if (normalized === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/** 写 `<html data-theme>`（壳是唯一写者；子应用只引用 token）。 */
export function applyTheme(root, pref, prefersDark) {
  root.setAttribute('data-theme', resolveTheme(pref, prefersDark))
}
