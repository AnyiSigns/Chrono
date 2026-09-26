// 反向调用（服务 → 宿主）：本插件 `pins` 为 `{"host":"host"}`，故 port 恒为保留能力类 `host`。
// 帧方向：服务发 `port.call`（SDK 反向调用通道），宿主按发出者 pins 路由后回
// `port.result` / `port.error`（按原 id 配对）。失败一律作数据（PortOutcome），不抛错、不断通道。

import { isRecord } from 'plugin-sdk'
import type { Json, PortCaller, PortOutcome, Rec } from 'plugin-sdk'

/** 保留能力类名（也是 `pins` 里绑定宿主自身的保留值）。 */
export const HOST_PORT = 'host'

/** 反向调用应答：与宿主 CallResponse 同形，失败作数据、不抛错。 */
export type HostResult = PortOutcome

/** 宿主调用抽象：生产环境是 SDK 反向调用通道，单测注入假端口。 */
export interface HostCaller {
  call(method: string, args: Rec): Promise<HostResult>
}

/** 把宿主调用固定路由到保留能力类 `host`。 */
export class HostLink implements HostCaller {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  call(method: string, args: Rec): Promise<HostResult> {
    return this.link.call(HOST_PORT, method, args)
  }
}

/** 宿主 identities 清单里的单项（只读面：id / active / implements / commands）。 */
export interface IdentityInfo {
  id: string
  active: string | null
  implements: string[]
  commands: string[]
}

/** 把 `host.identities` 的返回值规范化成清单；形态不符回落空数组。 */
export function parseIdentities(value: Json): IdentityInfo[] {
  if (!isRecord(value) || !Array.isArray(value['list'])) return []
  const out: IdentityInfo[] = []
  for (const item of value['list']) {
    if (!isRecord(item) || typeof item['id'] !== 'string') continue
    out.push({
      id: item['id'],
      active: typeof item['active'] === 'string' ? item['active'] : null,
      implements: Array.isArray(item['implements'])
        ? item['implements'].filter((entry): entry is string => typeof entry === 'string')
        : [],
      commands: Array.isArray(item['commands'])
        ? item['commands'].filter((entry): entry is string => typeof entry === 'string')
        : [],
    })
  }
  return out
}
