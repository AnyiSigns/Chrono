// 跟随失败世代记忆的启用条件：唯一消费者是 watcher，watcher 关闭时不得记忆（否则随进程无界增长）。

import { describe, expect, it } from 'vitest'
import { followFailureGen } from '../composition.ts'
import type { LifecycleRecord } from '../lifecycle.ts'

function record(overrides: Partial<LifecycleRecord>): LifecycleRecord {
  return { at: 1, kind: 'service', event: 'start_failed', ...overrides }
}

describe('跟随失败世代记忆', () => {
  it('watcher 开启：服务启动失败 / 握手失败记忆其世代', () => {
    expect(followFailureGen(record({ gen: 'g1' }), true)).toBe('g1')
    expect(followFailureGen(record({ kind: 'handshake', event: 'failed', gen: 'g2' }), true)).toBe(
      'g2',
    )
  })

  it('watcher 关闭：任何失败都不记忆（无人消费，防无界增长）', () => {
    expect(followFailureGen(record({ gen: 'g1' }), false)).toBeNull()
    expect(
      followFailureGen(record({ kind: 'handshake', event: 'failed', gen: 'g2' }), false),
    ).toBeNull()
  })

  it('无关事件 / 缺世代：不记忆', () => {
    expect(followFailureGen(record({ gen: 'g1', event: 'exit' }), true)).toBeNull()
    expect(
      followFailureGen(record({ gen: 'g1', kind: 'host', event: 'start_failed' }), true),
    ).toBeNull()
    expect(followFailureGen(record({}), true)).toBeNull()
  })
})
