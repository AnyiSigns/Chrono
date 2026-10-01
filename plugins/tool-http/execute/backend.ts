// 网络出口、资产存取与本地索引的可注入面：生产走 SDK 反向调用通道，测试注入假后端。
// 一次反向调用的结算要么给值、要么给结构化码——失败作数据，不抛错。
// 索引是可选增强：无 search-index 成员时逐次回 index_unavailable，调用方据此静默降级。

import type { PortLink, PortOutcome } from 'plugin-sdk'
import type { Rec } from './types.ts'

/** 反向调用结果：成功带值，失败带稳定码（作数据，不抛）。 */
export type CallOutcome = PortOutcome

/** `search-index` 能力类名（门面身份即端口名）。 */
export const SEARCH_INDEX_PORT = 'search-index'
/** 索引反向调用等待上限：门面一次 search 可能多跳后端并落盘。 */
export const INDEX_CALL_TIMEOUT_MS = 15000

/** 本插件依赖的四个反向面：隔离执行、资产存取与本地索引读写。 */
export interface HttpBackend {
  exec(bag: Rec, callId?: string | null, timeoutMs?: number): Promise<CallOutcome>
  assetPut(
    input: { mime: string; bytes: string },
    callId?: string | null,
    timeoutMs?: number,
  ): Promise<CallOutcome>
  indexSearch(bag: Rec, callId?: string | null): Promise<CallOutcome>
  indexPut(bag: Rec, callId?: string | null): Promise<CallOutcome>
}

/** 无索引后端时的确定性回执：调用方据此跳过索引、走纯网络检索。 */
export function indexUnavailable(): CallOutcome {
  return { ok: false, code: 'index_unavailable', message: 'no search-index provider' }
}

/** 把 SDK 反向调用通道接成后端实现；callId / timeoutMs 逐次覆盖。 */
export function createReverseBackend(link: PortLink, indexProvider: string | null): HttpBackend {
  return {
    exec: (bag, callId, timeoutMs) => link.call('sandbox', 'exec', bag, { callId, timeoutMs }),
    assetPut: (input, callId, timeoutMs) =>
      link.call('host', 'asset.put', input, { callId, timeoutMs }),
    indexSearch: (bag, callId) =>
      indexProvider === null
        ? Promise.resolve(indexUnavailable())
        : link.call(SEARCH_INDEX_PORT, 'search', bag, {
            callId,
            timeoutMs: INDEX_CALL_TIMEOUT_MS,
            provider: indexProvider,
          }),
    indexPut: (bag, callId) =>
      indexProvider === null
        ? Promise.resolve(indexUnavailable())
        : link.call(SEARCH_INDEX_PORT, 'put', bag, {
            callId,
            timeoutMs: INDEX_CALL_TIMEOUT_MS,
            provider: indexProvider,
          }),
  }
}
