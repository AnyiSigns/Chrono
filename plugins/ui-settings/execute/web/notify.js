// 通知分组纯函数（node 下可 import 单测）：开关键表 / `notify.state` 解析 / 权限态判定。
// `notify.state` 是开关读取入口（由通知前端身份声明）；浏览器权限状态由通知前端发布到
// 同页全局 `window.__chronoNotify`，设置页读该全局、不直接读 `Notification.permission`。

import { isRecord } from './config-model.js'

/** `ui.notify` 全部开关（缺键 = 默认 true，见配置身份 schema）。 */
export const NOTIFY_KEYS = [
  'approval_pending',
  'run_finished',
  'run_failed',
  'model_error',
  'disconnected',
  'orchestration_change',
  'plugin_write',
  'orchestration_unhealthy',
  'question_pending',
  'only_when_unfocused',
]

/** 权限三态 + 两档降级。 */
export const PERMISSION_GRANTED = 'granted'
export const PERMISSION_DEFAULT = 'default'
export const PERMISSION_DENIED = 'denied'
export const PERMISSION_UNSUPPORTED = 'unsupported'
export const PERMISSION_UNKNOWN = 'unknown'

const VALID_PERMISSIONS = [PERMISSION_GRANTED, PERMISSION_DEFAULT, PERMISSION_DENIED]

/**
 * 解析 `notify.state` 返回值：兼容两种形态——
 * ① `{ui:{notify:{…}}, permission?}`（整份 config body）；
 * ② 未来的直接 `{toggles:{…}, permission}` 形状。
 */
export function parseNotifyState(value) {
  if (!isRecord(value)) return { toggles: {}, permission: PERMISSION_UNKNOWN }
  let toggles = {}
  if (isRecord(value.toggles)) toggles = value.toggles
  else if (isRecord(value.ui) && isRecord(value.ui.notify)) toggles = value.ui.notify
  else if (isRecord(value.notify)) toggles = value.notify
  const permission =
    typeof value.permission === 'string' && VALID_PERMISSIONS.includes(value.permission)
      ? value.permission
      : PERMISSION_UNKNOWN
  return { toggles, permission }
}

/** 归一浏览器 `Notification.permission`；不支持 Notification API 时 unsupported。 */
export function normalizePermission(value) {
  if (typeof value !== 'string') return PERMISSION_UNSUPPORTED
  return VALID_PERMISSIONS.includes(value) ? value : PERMISSION_UNKNOWN
}

/**
 * 从通知前端发布的同页全局（`window.__chronoNotify` / `chrono-notify:state` 的 detail）取权限：
 * 非对象（前端未加载）→ `unknown`；对象但权限字段缺失 → `unsupported`。
 */
export function permissionFromNotifyGlobal(value) {
  if (!isRecord(value)) return PERMISSION_UNKNOWN
  return normalizePermission(value.permission)
}

/** 开关当前值：显式布尔用其值，缺省 true。 */
export function toggleValue(toggles, key) {
  const value = isRecord(toggles) ? toggles[key] : undefined
  return typeof value === 'boolean' ? value : true
}

/** 未授权 / 已拒绝时开关置灰（见通知前端的浏览器通知权限口径）。 */
export function togglesDisabled(permission) {
  return permission !== PERMISSION_GRANTED
}

/** 是否应显示 [请求授权]：仅 `default`（浏览器还会弹）；`denied` 只给指引。 */
export function canRequestPermission(permission) {
  return permission === PERMISSION_DEFAULT
}

/** 权限状态点语义（三重编码：颜色 + 文案 + 点）。 */
export function permissionTone(permission) {
  if (permission === PERMISSION_GRANTED) return 'success'
  if (permission === PERMISSION_DENIED) return 'danger'
  if (permission === PERMISSION_UNSUPPORTED) return 'warning'
  return 'muted'
}

/** 权限状态文案码（走 messages.js 单一来源）。 */
export function permissionMessageKey(permission) {
  if (permission === PERMISSION_GRANTED) return 'settings_notify_granted'
  if (permission === PERMISSION_DENIED) return 'settings_notify_denied'
  if (permission === PERMISSION_UNSUPPORTED) return 'settings_notify_unsupported'
  return 'settings_notify_default'
}

/** 合并写入一组开关（只覆盖给出的键，其余原样）。 */
export function mergeToggles(current, patch) {
  const base = isRecord(current) ? { ...current } : {}
  for (const [key, value] of Object.entries(isRecord(patch) ? patch : {})) {
    if (typeof value === 'boolean') base[key] = value
  }
  return base
}
