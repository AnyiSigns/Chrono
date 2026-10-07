// WorldWriter 串行段契约：同步回调按序串行、state 修改成为当前值；
// 段回调返回 thenable（async 回调）即违反「段内禁 await」，立即抛错。

import { describe, expect, it } from 'vitest'
import { WorldWriter } from '../writer.ts'
import type { WorldState } from '../writer.ts'
import type { World } from '../../kernel/index.ts'

const EMPTY_HEAD = { seq: -1, hash: null } as const

function emptyWriter(): WorldWriter {
  const world: World = { defs: {}, ids: {} }
  return new WorldWriter({ world, head: { ...EMPTY_HEAD } })
}

describe('WorldWriter 串行段', () => {
  it('同步回调按序串行、state 修改成为当前值', async () => {
    const writer = emptyWriter()
    const order: number[] = []
    await writer.run((state) => {
      order.push(1)
      state.head = { seq: 0, hash: 'a'.repeat(64) }
    })
    await writer.run(() => {
      order.push(2)
    })
    expect(order).toEqual([1, 2])
    expect(writer.snapshot().head).toEqual({ seq: 0, hash: 'a'.repeat(64) })
  })

  it('返回 thenable（async 回调）→ 立即抛错，不静默把 await 引入落账段', async () => {
    const writer = emptyWriter()
    // 编译期已由 SyncResult 拒绝 async 回调；此处强转绕过以锁定运行期护栏兜底
    const asyncFn = (async () => 1) as unknown as (state: WorldState) => number
    await expect(writer.run(asyncFn)).rejects.toThrow('must be synchronous')
    // 互斥链始终向前：抛错只让本次落定失败，后续段可继续
    await expect(writer.run(() => 'ok')).resolves.toBe('ok')
  })

  it('编译期即拒 async 回调（SyncResult 归 never）', () => {
    const writer = emptyWriter()
    // @ts-expect-error async 回调返回 thenable，SyncResult 归 never
    void writer.run(async () => 1)
  })

  it('回调抛错只让本次落定失败，不阻塞后续段', async () => {
    const writer = emptyWriter()
    await expect(
      writer.run(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(writer.run(() => 'ok')).resolves.toBe('ok')
  })
})
