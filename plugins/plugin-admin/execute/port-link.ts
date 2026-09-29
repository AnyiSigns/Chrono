// `plugin-admin`（工具面）→ `plugin`（管理平面）的反向调用后端：
// `invoke` 经 `port.call plugin.<method>` 委派，单测注入假后端。
// 失败作数据（结构化码），不抛未捕获错误、不断通道。

import type { Json, PortCaller, Rec } from 'plugin-sdk'

/** 管理平面能力类名（`port.call` 的 port；按发出者 `needs` 路由）。 */
export const PLANE_PORT = 'plugin'

/** 管理平面调用失败：带结构化码，调用方据此回结构化错误。 */
export class PluginPlaneError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PluginPlaneError'
    this.code = code
  }
}

/** 管理平面后端抽象：生产环境是反向调用 `plugin.*`，单测注入假后端。 */
export interface PluginPlane {
  call(method: string, args: Rec): Promise<Json>
}

/** `plugin.*` 的反向调用后端：成功回值，失败抛结构化 PluginPlaneError。 */
export class RemotePluginPlane implements PluginPlane {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async call(method: string, args: Rec): Promise<Json> {
    const outcome = await this.link.call(PLANE_PORT, method, args)
    if (!outcome.ok) throw new PluginPlaneError(outcome.code, outcome.message)
    return outcome.value
  }
}
