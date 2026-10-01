// `search-index` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、不落盘、不取时间；按世界成员表把请求委派给 search-index-provider 成员。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers, SEARCH_INDEX_PROVIDER } from './methods.ts'

/** 反向调用等待上限：须大于后端索引的写入耗时；一次 search 可能多跳成员。 */
const PROVIDER_CALL_TIMEOUT_MS = 15000

/** 构造服务实例：索引后端成员表由宿主按世界能力索引注入，合并与委派均走反向帧。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'search-index',
  logPrefix: 'search-index',
  setup: (ctx) => {
    const link = new PortLink({
      write: ctx.emit,
      idPrefix: 'search-index',
      timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
    })
    const providers = ctx.manyNeeds?.[SEARCH_INDEX_PROVIDER] ?? []
    return {
      handlers: createHandlers({ link, providers }),
      portLinks: [link],
    }
  },
})
