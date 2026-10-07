// 宿主保留 run 生命周期方法：中性名 run.spawn / run.cancel 与弃用别名 thread.resume /
// thread.terminate 派发到同一处理器；别名命中经 onDeprecatedMethod 旁路通知，不改派发结果。

import { describe, expect, it } from 'vitest'
import { createHostCapability } from '../host-capability.ts'
import type { HostCapabilityDeps } from '../host-capability.ts'
import { HOST_METHODS } from '../host-methods.ts'
import type { World } from '../../kernel/index.ts'

const EMPTY_WORLD: World = { defs: {}, ids: {} }

function baseDeps(overrides: Partial<HostCapabilityDeps> = {}): HostCapabilityDeps {
  return {
    root: 'root',
    assetsDir: 'assets',
    blobsDir: 'blobs',
    runtimeDir: 'runtime',
    audits: { query: () => ({ records: [], truncated: false }) },
    world: () => EMPTY_WORLD,
    abortRun: () => false,
    startDetachedRun: () => ({ ok: true, run: 'r1' }),
    isStopping: () => false,
    ...overrides,
  }
}

describe('宿主保留 run 生命周期方法：run.spawn / run.cancel + 弃用别名', () => {
  it('方法集同时暴露中性名与旧别名', () => {
    for (const method of ['run.spawn', 'run.cancel', 'thread.resume', 'thread.terminate']) {
      expect(HOST_METHODS.has(method)).toBe(true)
    }
  })

  it('旧名与新名解析到同一行为：未知 run 一律 unknown_run', async () => {
    const host = createHostCapability(baseDeps())
    const cancelled = await host('run.cancel', 'emitter', { run: 'ghost' }, 1000)
    const terminated = await host('thread.terminate', 'emitter', { run: 'ghost' }, 1000)
    expect(cancelled).toEqual(terminated)
    expect(cancelled.ok).toBe(false)
    if (!cancelled.ok) expect(cancelled.code).toBe('unknown_run')
    // 形态非法（缺 run）同样同名收口
    const malformed = await host('run.cancel', 'emitter', {}, 1000)
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.code).toBe('unknown_run')
  })

  it('旧名与新名解析到同一行为：起 detached run 回同一 run id / 同等参数', async () => {
    const calls: Array<{ emitter: string; entry: string; thread: string | null }> = []
    const host = createHostCapability(
      baseDeps({
        startDetachedRun: (emitter, entry, _args, thread) => {
          calls.push({ emitter, entry, thread })
          return { ok: true, run: 'r1' }
        },
      }),
    )
    const spawned = await host('run.spawn', 'emitter', { entry: 'e', thread: 'thr-1' }, 1000)
    const resumed = await host('thread.resume', 'emitter', { entry: 'e', thread: 'thr-1' }, 1000)
    expect(spawned).toEqual(resumed)
    expect(spawned).toEqual({ ok: true, value: { run: 'r1' } })
    expect(calls).toEqual([
      { emitter: 'emitter', entry: 'e', thread: 'thr-1' },
      { emitter: 'emitter', entry: 'e', thread: 'thr-1' },
    ])
  })

  it('弃用别名命中 onDeprecatedMethod，中性名不触发', async () => {
    const seen: Array<[string, string]> = []
    const host = createHostCapability(
      baseDeps({ onDeprecatedMethod: (method, replacement) => seen.push([method, replacement]) }),
    )
    await host('run.cancel', 'emitter', { run: 'ghost' }, 1000)
    await host('run.spawn', 'emitter', { entry: 'e' }, 1000)
    expect(seen).toEqual([])
    await host('thread.terminate', 'emitter', { run: 'ghost' }, 1000)
    await host('thread.resume', 'emitter', { entry: 'e' }, 1000)
    expect(seen).toEqual([
      ['thread.terminate', 'run.cancel'],
      ['thread.resume', 'run.spawn'],
    ])
  })
})
