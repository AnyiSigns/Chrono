// 待办清单的运行记录存储：经委托存储（storage-kv，按 env.emitter 分命名空间）读写。
// 键 `conv:<会话 id>` = `{run, at, seq, items}`（seq = 下一个可用 id 序号，保证 id 稳定）；
// 键 `turn:<回合 id>` = `{state:'open'|'closed', conv}`。
// 边跑边追加：写先落 open 标记、再落数据并置 closed；中途崩留下的 open 标记即中断残留，可辨。
// 同会话重复写同值幂等；存量从空开始，不再搬。

import { isRecord } from 'plugin-sdk'
import type { Json } from 'plugin-sdk'
import type { StorageBackend } from './port-link.ts'

const CONV_PREFIX = 'conv:'
const TURN_PREFIX = 'turn:'

/** 单会话持久化记录。 */
export interface ConvRecord {
  run: string | null
  at: string | null
  seq: number
  items: Json[]
}

function intOf(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

export class TodoStore {
  private readonly backend: StorageBackend

  constructor(backend: StorageBackend) {
    this.backend = backend
  }

  /** 某会话的持久化记录；无记录回空清单（seq 从 0 起）。 */
  async load(conversationId: string): Promise<ConvRecord> {
    const value = await this.backend.get(`${CONV_PREFIX}${conversationId}`)
    if (!isRecord(value) || !Array.isArray(value['items'])) {
      return { run: null, at: null, seq: 0, items: [] }
    }
    const items = value['items'] as Json[]
    return {
      run: typeof value['run'] === 'string' ? (value['run'] as string) : null,
      at: typeof value['at'] === 'string' ? (value['at'] as string) : null,
      seq: intOf(value['seq'], items.length),
      items,
    }
  }

  /**
   * 整表落盘（边跑边追加）：先置回合 open 标记，再落数据 + 置 closed。
   * `record.run` 为空时跳过回合标记（无回合上下文的直接调用）。
   */
  async save(conversationId: string, record: ConvRecord): Promise<void> {
    const run = record.run
    if (run !== null) {
      await this.backend.batch([{ op: 'put', key: `${TURN_PREFIX}${run}`, value: { state: 'open', conv: conversationId } }])
    }
    const data: Record<string, Json> = { run, seq: record.seq, items: record.items }
    if (record.at !== null) data['at'] = record.at
    const ops: Array<{ op: 'put' | 'del'; key: string; value?: Json }> = [
      { op: 'put', key: `${CONV_PREFIX}${conversationId}`, value: data },
    ]
    if (run !== null) {
      ops.push({ op: 'put', key: `${TURN_PREFIX}${run}`, value: { state: 'closed', conv: conversationId } })
    }
    await this.backend.batch(ops)
  }
}
