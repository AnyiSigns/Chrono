// `msg-dialect` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 唯一反向调用链 host（`host.asset.get` 资产内联取字节）；不读投影、无写通道。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'

/** 构造服务实例：一条反向调用链（host，资产内联）+ 纯方言编解码方法。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'msg-dialect',
  logPrefix: 'msg-dialect',
  defaultState: 'recomputable',
  setup: (ctx) => {
    const host = new PortLink({ write: ctx.emit, idPrefix: 'md-host' })
    return {
      handlers: createHandlers({ host }),
      portLinks: [host],
    }
  },
})
