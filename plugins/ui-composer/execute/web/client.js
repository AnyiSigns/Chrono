// 本插件入站网络：`fetch` 只打本插件自己的 BASE（命令 / 提交 / 终止）。
// 命令与提交一律按名经本插件服务的入站桥；读-改-写只覆盖本线程键（per-thread 键控）。

import { configWriteDirective, isRecord, mergeSlotBody, slotWriteDirective } from './model.js'

const BASE = new URL('.', import.meta.url)

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
    return {
      ok: false,
      code: 'ui_unreachable',
      message: String(err && err.message ? err.message : err),
    }
  }
}

/** 按名调命令；失败 / 空值归一为 `{ok:false}`。 */
export async function command(name, args, thread) {
  const result = await postJson('api/command', {
    name,
    args: args ?? null,
    thread: thread ?? undefined,
  })
  if (result.ok !== true) {
    return {
      ok: false,
      code: typeof result.code === 'string' ? result.code : 'unknown',
      value: null,
      message: '',
    }
  }
  return { ok: true, code: '', value: result.value, message: '' }
}

/** 提交 directive 批；成功回 `{ok:true, run}`。 */
export async function submitDirectives(directives, thread) {
  const result = await postJson('api/submit', { directives, thread: thread ?? undefined })
  if (result.ok !== true) {
    return {
      ok: false,
      code: typeof result.code === 'string' ? result.code : 'bad_directive',
      run: null,
    }
  }
  return { ok: true, code: '', run: typeof result.run === 'string' ? result.run : null }
}

/** 真取消指定 run（协议 `cancel{run}`）。 */
export async function cancelRun(run) {
  const result = await postJson('api/cancel', { run })
  return { ok: result.ok === true, code: typeof result.code === 'string' ? result.code : '' }
}

/** 读整份用户配置；失败回 null。 */
export async function readConfig() {
  const result = await command('config.read', null)
  return result.ok && isRecord(result.value) ? result.value : null
}

/** 整值写用户配置（读-改-写后由调用方传入完整 body）。 */
export async function writeConfig(body, thread) {
  return submitDirectives([configWriteDirective(body)], thread)
}

/** 读整份 input body（`input.read` 入口 term 直出）；失败回 null。 */
export async function readInputBody(threadKey) {
  const result = await command('input.read', { thread: threadKey }, threadKey)
  return result.ok && isRecord(result.value) ? result.value : null
}

/** 写本线程槽：先读整份 body，只覆盖本线程键，再整份 `put` + `add_gen`。 */
export async function writeSlot(threadKey, slot) {
  const body = await readInputBody(threadKey)
  if (body === null) return { ok: false, code: 'input_unavailable', run: null }
  const merged = mergeSlotBody(body, threadKey, slot)
  return submitDirectives([slotWriteDirective(merged)], threadKey)
}

/**
 * 触发发送：按名调无参命令 `chat.send`（信封带本线程）。
 * 命令 run 贯穿整个回合，调用方不应把它当作回合结束信号——进度一律订阅宿主事件。
 */
export async function triggerSend(threadKey) {
  return command('chat.send', null, threadKey)
}

/** 按名调无参 `model.profile`（入口 term 自行从配置装配，服务落写计划）。 */
export async function fetchProfile() {
  return command('model.profile', null)
}
