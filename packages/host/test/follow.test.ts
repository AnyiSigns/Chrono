// 换代跟随：`applyWorldSerial` 的失败收口——应用失败与尾段副作用失败都只记 `follow_failed`，
// 不把 promise 变成 rejection（调用方会当 run 失败并升级致命停机）。

import { describe, expect, it } from 'vitest'
import { createFollow } from '../follow.ts'
import type { AssemblyRuntimeHandle } from '../assembly/index.ts'
import type { LifecycleRecord } from '../lifecycle.ts'
import type { Head, World } from '../../kernel/index.ts'

const DATA = 'd'.repeat(64)
const SIG = 'g'.repeat(64)
const WRITE = 'w'.repeat(64)

const PREV: World = { defs: {}, ids: {} }
/** 相对 PREV 新增一个数据世代（`latestDataGen` payload 变），用于触发逐身份广播。 */
const NEXT: World = {
  defs: { [DATA]: { body: { type: 'object' } } },
  ids: {
    svc: {
      id: 'svc',
      schema: 's'.repeat(64),
      gens: [
        {
          seq: 0,
          payload: DATA,
          sig: SIG,
          adopted: { at: 1, by: 'test', write: WRITE },
        },
      ],
      active: DATA,
      born: { at: 1, by: 'test' },
    },
  },
}

const HEAD0: Head = { seq: 0, hash: null }
const HEAD1: Head = { seq: 1, hash: 'h' }

function runtime(applyWorld: () => Promise<void>): AssemblyRuntimeHandle {
  return { applyWorld } as unknown as AssemblyRuntimeHandle
}

function followWith(options: {
  logs: LifecycleRecord[]
  applyWorld?: () => Promise<void>
  broadcast?: () => void
  onApplied?: () => void
}) {
  return createFollow({
    initialWorld: PREV,
    initialHead: HEAD0,
    getRuntime: () => runtime(options.applyWorld ?? (async () => {})),
    broadcast: options.broadcast ?? (() => {}),
    safeAppendLifecycle: (record) => options.logs.push(record),
    isStopping: () => false,
    onApplied: options.onApplied ?? (() => {}),
  })
}

describe('follow.applyWorldSerial', () => {
  it('onApplied 抛错：只记 follow_failed，promise 仍 resolve，基准照常前进', async () => {
    const logs: LifecycleRecord[] = []
    const follow = followWith({
      logs,
      onApplied: () => {
        throw new Error('onApplied boom')
      },
    })
    await expect(follow.applyWorldSerial(NEXT, HEAD1)).resolves.toBeUndefined()
    expect(logs).toContainEqual(
      expect.objectContaining({ kind: 'host', event: 'follow_failed', reason: 'onApplied boom' }),
    )
    expect(follow.liveWorld()).toBe(NEXT)
  })

  it('广播抛错：同样只记 follow_failed，不 reject', async () => {
    const logs: LifecycleRecord[] = []
    const follow = followWith({
      logs,
      broadcast: () => {
        throw new Error('broadcast boom')
      },
    })
    await expect(follow.applyWorldSerial(NEXT, HEAD1)).resolves.toBeUndefined()
    expect(logs).toContainEqual(
      expect.objectContaining({ kind: 'host', event: 'follow_failed', reason: 'broadcast boom' }),
    )
  })

  it('applyWorld 拒绝：记 follow_failed 且基准不前进', async () => {
    const logs: LifecycleRecord[] = []
    const follow = followWith({
      logs,
      applyWorld: async () => {
        throw new Error('apply boom')
      },
    })
    await expect(follow.applyWorldSerial(NEXT, HEAD1)).resolves.toBeUndefined()
    expect(logs).toContainEqual(
      expect.objectContaining({ kind: 'host', event: 'follow_failed', reason: 'apply boom' }),
    )
    expect(follow.liveWorld()).toBe(PREV)
  })
})
