// 网络出口与资产存取的可注入面：生产走反向帧，测试注入假后端。
// 一次反向调用的结算要么给值、要么给结构化码——失败作数据，不抛错。

import type { Json, Rec } from './types.ts'

export type CallOutcome =
  | { ok: true; value: Json }
  | { ok: false; code: string; message: string }

/** 反向调用发起面（按逻辑端口 + 方法）。 */
export interface ReverseCaller {
  call(port: string, method: string, args: Rec): Promise<CallOutcome>
}

/** 本插件依赖的两个反向面：隔离执行与资产存取。 */
export interface HttpBackend {
  exec(bag: Rec): Promise<CallOutcome>
  assetPut(input: { mime: string; bytes: string }): Promise<CallOutcome>
}

/** 把反向调用链接成后端实现。 */
export function createReverseBackend(link: ReverseCaller): HttpBackend {
  return {
    exec: (bag) => link.call('sandbox', 'exec', bag),
    assetPut: (input) => link.call('host', 'asset.put', input),
  }
}
