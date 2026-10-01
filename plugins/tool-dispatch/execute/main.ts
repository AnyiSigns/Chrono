// `tool-dispatch` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道：执行所需数据由调用方随 bag 传入；跨插件只走反向调用 `port.call`。

import { PortLink, SERVICE_PROTOCOL_VERSION, defineService } from 'plugin-sdk'
import type { Json } from 'plugin-sdk'
import { ResultCache } from './cache.ts'
import { DEFAULT_CACHE_MAX_ENTRIES, DEFAULT_CONCURRENCY } from './config.ts'
import { createHandlers } from './methods.ts'

/** 构造服务实例：反向调用通道 + 结果缓存由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'tool-dispatch',
  logPrefix: 'tool-dispatch',
  setup: (ctx) => {
    const link = new PortLink({ write: ctx.emit, idPrefix: 'tool-dispatch' })
    let eventSeq = 0
    /** 上行事件出口（宿主只透传，不落账、不推进）：tool.start / tool.end。 */
    const emitEvent = (topic: string, payload: Json): void => {
      eventSeq += 1
      ctx.emit({
        v: SERVICE_PROTOCOL_VERSION,
        id: `tool-dispatch-evt-${eventSeq}`,
        kind: 'event',
        topic,
        payload,
      })
    }
    return {
      handlers: createHandlers({
        link,
        emit: emitEvent,
        concurrency: DEFAULT_CONCURRENCY,
        cache: new ResultCache(DEFAULT_CACHE_MAX_ENTRIES, true),
        cacheEnabled: true,
      }),
      portLinks: [link],
    }
  },
})
