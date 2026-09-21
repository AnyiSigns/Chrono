// 通知动作：`notify.state` 开关读取 + 浏览器权限状态同步。
// 权限状态唯一来源 = 通知前端发布的同页全局（`window.__chronoNotify` / `chrono-notify:state`），
// 设置页不直接读 `Notification.permission`（见通知前端的浏览器通知权限口径）。

import { normalizePermission, parseNotifyState, permissionFromNotifyGlobal } from './notify.js'

/** 读同页通知全局（通知前端未加载 → null）。 */
export function readNotifyGlobal(doc) {
  const view = doc.defaultView
  return view === null || view === undefined ? null : (view.__chronoNotify ?? null)
}

/** 拉 `notify.state` 开关；权限取全局发布值（命令未带时）。 */
export async function loadNotify(ctx) {
  const result = await ctx.runCommand('notify.state', null)
  const parsed = parseNotifyState(result.ok ? result.value : null)
  ctx.state.notify = parsed.toggles
  const fromNotify = permissionFromNotifyGlobal(readNotifyGlobal(ctx.doc))
  ctx.state.permission = parsed.permission !== 'unknown' ? parsed.permission : fromNotify
  return ctx.state.notify
}

/** 通知前端发布权限状态（`chrono-notify:state`）时同步本页。 */
export function handleNotifyState(ctx, event) {
  const next = permissionFromNotifyGlobal(event !== null && event !== undefined ? event.detail : null)
  if (next !== 'unknown') {
    ctx.state.permission = next
    if (ctx.state.mode === 'settings') ctx.render()
  }
}

/** 用户手势触发浏览器授权；结果归一后重渲染。 */
export async function requestPermission(ctx) {
  const view = ctx.doc.defaultView
  if (view === null || view === undefined || typeof view.Notification !== 'function') return
  if (typeof view.Notification.requestPermission !== 'function') return
  try {
    ctx.state.permission = normalizePermission(await view.Notification.requestPermission())
  } catch {
    ctx.state.permission = 'unknown'
  }
  ctx.render()
}
