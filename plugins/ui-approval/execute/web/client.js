// 本插件入站网络：`fetch` 只打本插件自己的 BASE（命令 / 提交）。
// 裁决两步走：先读-改-写 `#1` 槽（本线程键），提交后等服务侧确认写 run 收口，再调无参裁决命令。

import { isRecord } from './model.js'

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

/** 调本插件命令；失败 / 空值归一为 `{ok:false}`。 */
export async function runCommand(name, args, thread) {
  const result = await postJson('api/command', {
    name,
    args: args ?? null,
    thread: thread ?? undefined,
  })
  if (result.ok !== true) {
    return { ok: false, code: typeof result.code === 'string' ? result.code : 'unknown', value: null }
  }
  return { ok: true, code: '', value: result.value }
}

/** 读 `#1` 整份 body（`input.read` 入口 term 直出）；失败回 null。 */
export async function readInputBody(threadKey = DEFAULT_THREAD) {
  const result = await runCommand('input.read', null, threadKey)
  if (!result.ok || !isRecord(result.value)) return null
  return result.value
}

/** 写 `#1` 本线程键的 batch directive：`put` 整份 body + `add_gen`。 */
export function slotWriteDirective(body) {
  return {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body } },
          { op: 'add_gen', args: { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
        ],
      },
    },
  }
}

/** 把本线程槽置为 `approval.decide`（读-改-写，其余线程键原样保留）。 */
export async function writeDecideSlot(threadKey, slot) {
  const body = await readInputBody(threadKey)
  if (body === null) return { ok: false, code: 'input_unavailable' }
  const slots = isRecord(body.slots) ? { ...body.slots, [threadKey]: slot } : { [threadKey]: slot }
  const result = await postJson('api/submit', {
    directives: [slotWriteDirective({ ...body, slots })],
    thread: threadKey,
  })
  if (result.ok !== true) {
    return { ok: false, code: typeof result.code === 'string' ? result.code : 'bad_directive' }
  }
  return { ok: true, code: '' }
}

/**
 * 裁决：先写槽（`{kind:'approval.decide', id?, verdict}`），再调无参命令。
 * `id` 缺省 = 整批（`approval.decide_all`）。
 */
export async function decide(threadKey, slot) {
  const written = await writeDecideSlot(threadKey, slot)
  if (!written.ok) return written
  const name = typeof slot.id === 'string' && slot.id.length > 0 ? 'approval.decide' : 'approval.decide_all'
  return runCommand(name, null, threadKey)
}
