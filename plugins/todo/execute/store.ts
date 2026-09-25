// 待办清单的运行记录存储：经委托存储（storage-kv，按 env.emitter 分命名空间）读写。
// 键 `conv:<会话 id>` = `{run, at, items}`；键 `turn:<回合 id>` = `{state:'open'|'closed', conv}`。
// 边跑边追加：写先落 open 标记、再落数据并置 closed；中途崩留下的 open 标记即中断残留，可辨。
// 同会话重复写同值幂等；同回合重复写同值幂等。存量不搬，存储从空开始。

import { isRecord } from './plan.ts'
import type { Json } from './types.ts'
import type { StorageBackend } from './port-link.ts'

const CONV_PREFIX = 'conv:'
const TURN_PREFIX = 'turn:'

export class TodoStore {
  private readonly backend: StorageBackend

  constructor(backend: StorageBackend) {
    this.backend = backend
  }

  /** 某会话的条目（老→新）；无记录回空数组。 */
  async read(conversationId: string): Promise<Json[]> {
    const value = await this.backend.get(`${CONV_PREFIX}${conversationId}`)
    if (!isRecord(value) || !Array.isArray(value['items'])) return []
    return value['items'] as Json[]
  }

  /**
   * 整表替换本会话清单（边跑边追加）：先置回合 open 标记，再落数据 + 置 closed。
   * `run` 为空时跳过回合标记（无回合上下文的直接调用）。
   */
  async write(run: string | null, conversationId: string, at: string | null, items: Json[]): Promise<void> {
    if (run !== null) {
      await this.backend.batch([{ op: 'put', key: `${TURN_PREFIX}${run}`, value: { state: 'open', conv: conversationId } }])
    }
    const data: Record<string, Json> = { run, items }
    if (at !== null) data['at'] = at
    const ops: Array<{ op: 'put' | 'del'; key: string; value?: Json }> = [
      { op: 'put', key: `${CONV_PREFIX}${conversationId}`, value: data },
    ]
    if (run !== null) {
      ops.push({ op: 'put', key: `${TURN_PREFIX}${run}`, value: { state: 'closed', conv: conversationId } })
    }
    await this.backend.batch(ops)
  }

  /** 未闭合回合（中断残留）的回合 id 列表，供调用方辨识半份状态。 */
  async pendingTurns(): Promise<string[]> {
    const entries = await this.backend.list(TURN_PREFIX)
    const out: string[] = []
    for (const entry of entries) {
      if (isRecord(entry.value) && entry.value['state'] === 'open') {
        out.push(entry.key.slice(TURN_PREFIX.length))
      }
    }
    return out.sort()
  }

  /** owner 退役时由调用方调用的清理入口：丢弃本 owner 命名空间。 */
  async dropNamespace(): Promise<void> {
    await this.backend.dropNamespace()
  }
}
