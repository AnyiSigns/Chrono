// `plugin-admin` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 工具面不读投影、无写通道：describe 直回静态工具清单，invoke 经反向调用委派管理平面 `plugin`。
// 第二方向：服务发 `port.call`（反向调用），宿主回 `port.result` / `port.error`（按 id 配对）。

import { PortLink, defineService } from 'plugin-sdk'
import { createHandlers } from './methods.ts'
import { RemotePluginPlane } from './port-link.ts'

/** 反向调用等待上限：须严格大于管理平面 `plugin` 声明的 `method_timeouts`（最大 30000）。 */
const PLANE_CALL_TIMEOUT_MS = 40000

/** 构造服务实例：管理平面委派经反向调用通道，工具描述直出。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'plugin-admin',
  logPrefix: 'plugin-admin',
  setup: (ctx) => {
    const link = new PortLink({
      write: ctx.emit,
      idPrefix: 'plugin-admin',
      timeoutMs: PLANE_CALL_TIMEOUT_MS,
    })
    return {
      handlers: createHandlers(new RemotePluginPlane(link)),
      portLinks: [link],
    }
  },
})
