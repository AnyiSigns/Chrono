// `model-protocol` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道：方法只返回值 / 写计划。
// 第二方向：服务发 `port.call`（反向调用 secrets / config / throttle / msg-dialect），宿主回 `port.result` / `port.error`（按 id 配对）。
// 事件出口（model.delta）直接经 SDK 上行通道，载荷带 run / thread（自帧 env 读取，不自取时间）。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import type { Json } from 'plugin-sdk'

/** 构造服务实例：四条反向调用链（secrets / config / throttle / msg-dialect）+ 事件出口，均由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'model',
  logPrefix: 'model-protocol',
  defaultState: 'recomputable',
  setup: (ctx) => {
    const secrets = new PortLink({ write: ctx.emit, idPrefix: 'mp-secrets' })
    const config = new PortLink({ write: ctx.emit, idPrefix: 'mp-config' })
    const throttle = new PortLink({ write: ctx.emit, idPrefix: 'mp-throttle' })
    const dialect = new PortLink({ write: ctx.emit, idPrefix: 'mp-dialect' })
    const links = [secrets, config, throttle, dialect]
    let seq = 0
    const emit = (topic: string, payload: Json): void => {
      seq += 1
      ctx.emit({ v: '1', id: `model-evt-${seq}`, kind: 'event', topic, payload })
    }
    return {
      handlers: createHandlers({ secrets, config, throttle, dialect, emit }),
      portLinks: links,
    }
  },
})
