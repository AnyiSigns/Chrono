// 网络出口与资产存取的可注入面：生产走 SDK 反向调用通道，测试注入假后端。
// 一次反向调用的结算要么给值、要么给结构化码——失败作数据，不抛错。

import type { PortLink, PortOutcome } from 'plugin-sdk'
import type { Rec } from './types.ts'

/** 反向调用结果：成功带值，失败带稳定码（作数据，不抛）。 */
export type CallOutcome = PortOutcome

/** 本插件依赖的两个反向面：隔离执行与资产存取。 */
export interface HttpBackend {
  exec(bag: Rec, callId?: string | null, timeoutMs?: number): Promise<CallOutcome>
  assetPut(
    input: { mime: string; bytes: string },
    callId?: string | null,
    timeoutMs?: number,
  ): Promise<CallOutcome>
}

/** 把 SDK 反向调用通道接成后端实现；callId / timeoutMs 逐次覆盖。 */
export function createReverseBackend(link: PortLink): HttpBackend {
  return {
    exec: (bag, callId, timeoutMs) => link.call('sandbox', 'exec', bag, { callId, timeoutMs }),
    assetPut: (input, callId, timeoutMs) => link.call('host', 'asset.put', input, { callId, timeoutMs }),
  }
}
