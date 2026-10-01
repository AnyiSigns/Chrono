// `session-title` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道：只回标题值（标题落盘归调用方 chat）。
// 模型反向调用（model.complete）走 `port.call`，应答帧由 SDK 派发器拦截结算（不排队）；
// 标题后处理住本插件纯函数，不再有第二个反向调用。

import { PortLink, defineService } from 'plugin-sdk'
import { loadBaseConfig } from './config.ts'
import { createHandlers } from './methods.ts'
import { RemoteModel } from './port-link.ts'

/** 构造服务实例：反向调用通道 + 模型后端，由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'session-title',
  logPrefix: 'session-title',
  setup: (ctx) => {
    const link = new PortLink({ write: ctx.emit, idPrefix: 'session-title' })
    return {
      handlers: createHandlers({
        config: loadBaseConfig(),
        model: new RemoteModel(link),
      }),
      portLinks: [link],
    }
  },
})
