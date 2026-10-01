// `search-index-sql` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写世界通道；命名空间取帧 `env.emitter`，数据落 CHRONO_PLUGIN_DATA。

import { defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { IndexEngine } from './engine.ts'

/** 构造服务实例：④ 目录取 loader 参数，索引引擎由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'search-index-provider',
  logPrefix: 'search-index-sql',
  defaultState: 'durable',
  setup: (ctx) => {
    const engine = new IndexEngine(ctx.env['CHRONO_PLUGIN_DATA'] ?? null)
    return {
      handlers: createHandlers(engine),
      onDrain: () => engine.close(),
      onClose: () => engine.close(),
    }
  },
})
