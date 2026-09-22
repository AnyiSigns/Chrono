// 入站桥：浏览器侧 HTTP 动词 ↔ 宿主入站协议帧（见协议文档 §三）。
// 本文件只做**纯构造 / 解析**：帧形状与回包解释可脱离 socket 单测；
// 实际收发由 `inbound.js` 的 Transport 承担（自实现入站客户端，不 import 客户端包）。
// 本插件命令一律经入站面按名调用；命令入口 term 再 eff 到本插件服务。

import { randomUUID } from 'node:crypto'
import { isRecord } from './types.js'

/** 入站协议版本（与服务协议 `protocol` 独立）。 */
export const PROTOCOL_VERSION = '1'

function withOptions(frame, options) {
  if (options === undefined) return frame
  if (options.caps !== undefined) frame['caps'] = options.caps
  if (options.limits !== undefined) frame['limits'] = options.limits
  if (typeof options.thread === 'string' && options.thread.length > 0) frame['thread'] = options.thread
  return frame
}

/** `submit` 帧：提交 directives（写类指令 / eval）。 */
export function submitFrame(id, directives, options) {
  return withOptions({ v: PROTOCOL_VERSION, id, kind: 'submit', directives }, options)
}

/** `command` 帧：按名调用插件声明的命令。 */
export function commandFrame(id, name, args, options) {
  return withOptions({ v: PROTOCOL_VERSION, id, kind: 'command', name, args }, options)
}

/** `cancel` 帧：真取消某 run（协议 `cancel{run}`）。 */
export function cancelFrame(id, run) {
  return { v: PROTOCOL_VERSION, id, kind: 'cancel', run }
}

/** 解释一条宿主回帧：通道失败 / `error` 帧 / 正常回帧三态。 */
export function interpretResponse(result) {
  if (!result.ok) {
    return { ok: false, frame: null, code: result.code || 'ui_unreachable', message: result.message }
  }
  const frame = result.frame
  if (frame !== null && frame['kind'] === 'error') {
    return {
      ok: false,
      frame,
      code: typeof frame['code'] === 'string' ? frame['code'] : 'internal',
      message: typeof frame['message'] === 'string' ? frame['message'] : '',
    }
  }
  return { ok: true, frame, code: '', message: '' }
}

/** 计划值取最后一条 `extern` 载荷；非计划值原样返回。 */
export function unwrapPlan(value) {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) return value
  for (let index = value['$directives'].length - 1; index >= 0; index--) {
    const item = value['$directives'][index]
    if (isRecord(item) && item['kind'] === 'extern' && item['payload'] !== undefined) {
      return item['payload']
    }
  }
  return null
}

/**
 * 从命令 / submit 回帧取业务值：优先 `extern` 观测载荷，其次 `eval` 观测值（计划值解包）。
 */
export function extractValue(frame) {
  if (frame === null) return null
  const observations = frame['observations']
  if (!Array.isArray(observations)) return null
  for (const observation of observations) {
    if (!isRecord(observation)) continue
    if (observation['kind'] === 'extern' && observation['payload'] !== undefined) {
      return observation['payload']
    }
    if (observation['kind'] === 'eval' && observation['value'] !== undefined) {
      return unwrapPlan(observation['value'])
    }
  }
  return null
}

/** 新请求 id（帧按 id 配对）。 */
export function newRequestId(prefix = 'ui-sidebar') {
  return `${prefix}-${randomUUID()}`
}

/** 高层入站操作：只负责构造帧、发请求、解释回帧。 */
export class Bridge {
  constructor(transport, timeoutMs = 15000) {
    this.transport = transport
    this.timeoutMs = timeoutMs
  }

  connected() {
    return this.transport.isConnected()
  }

  async send(frame) {
    return interpretResponse(await this.transport.request(frame, this.timeoutMs))
  }

  submit(directives, options) {
    return this.send(submitFrame(newRequestId(), directives, options))
  }

  command(name, args, options) {
    return this.send(commandFrame(newRequestId(), name, args, options))
  }

  cancel(run) {
    return this.send(cancelFrame(newRequestId('ui-sidebar-cancel'), run))
  }

  /** 命令回包取值（本插件全部命令共用）。 */
  async commandValue(name, args, options) {
    const result = await this.command(name, args, options)
    return {
      ok: result.ok,
      value: result.ok ? extractValue(result.frame) : null,
      code: result.code,
      message: result.message,
      frame: result.frame,
    }
  }
}
