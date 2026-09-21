// 本插件入站网络：`fetch` 只打本插件自己的 BASE（命令 / 提交）。
// 命令回包归一（`refused` / 业务值）与写指令提交收口在此，供入口与动作模块共用。

import { isRecord } from './config-model.js'

const BASE = new URL('.', import.meta.url)

export const DEFAULT_THREAD = '_main'

/** POST JSON 到本插件自己的 BASE；非对象回包 / 网络失败归一为 `ui_unreachable`。 */
export async function postJson(path, body) {
  try {
    const response = await fetch(new URL(path, BASE).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const parsed = await response.json().catch(() => null)
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, code: 'ui_unreachable', message: `http ${response.status}` }
    }
    return parsed
  } catch (err) {
    return { ok: false, code: 'ui_unreachable', message: String(err && err.message ? err.message : err) }
  }
}

/** 调只读命令；`refused` / 空值归一为 `not_loaded`。 */
export async function runCommand(name, args) {
  const result = await postJson('api/command', { name, args: args ?? null })
  if (result.ok !== true) {
    return { ok: false, code: typeof result.code === 'string' ? result.code : 'unknown', value: null, refused: false }
  }
  const refused = result.status === 'refused' || result.value === null
  return { ok: !refused, code: refused ? 'not_loaded' : '', value: result.value, refused }
}

/** 提交单条写指令（客户端身份）；失败回错误码。 */
export async function applyWrite(directive, threadKey = DEFAULT_THREAD) {
  const result = await postJson('api/submit', { directives: [directive], thread: threadKey })
  if (result.ok !== true) return { ok: false, code: typeof result.code === 'string' ? result.code : 'unknown' }
  if (result.status === 'refused') return { ok: false, code: 'bad_directive' }
  return { ok: true }
}

/** 读输入槽本线程键（其余键由调用方读-改-写保留）。 */
export async function readSlots(threadKey = DEFAULT_THREAD) {
  const result = await runCommand('input.read', { thread: threadKey })
  if (!result.ok || !isRecord(result.value) || !isRecord(result.value.slots)) return {}
  return result.value.slots
}
