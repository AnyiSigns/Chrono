// 宿主保留能力类 host 的运行期休眠 / 恢复派发：identities.suspend / identities.resume。
// 回调以桩注入，只验方法集与派发口径（not_found / 幂等 / 成功值）；真实运行态隔离见 assembly/test/suspend.test.ts。

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
    startDetachedRun: () => ({ ok: true, run: 'r' }),
    isStopping: () => false,
    ...overrides,
  }
}

describe('host 保留能力类：identities.suspend / identities.resume', () => {
  it('方法集暴露 identities.suspend / identities.resume', () => {
    expect(HOST_METHODS.has('identities.suspend')).toBe(true)
    expect(HOST_METHODS.has('identities.resume')).toBe(true)
  })

  it('派发到注入的休眠 / 恢复回调，回 {ok:true}', async () => {
    const calls: string[] = []
    const host = createHostCapability(
      baseDeps({
        suspendIdentity: async (id) => {
          calls.push(`suspend:${id}`)
          return { ok: true }
        },
        resumeIdentity: async (id) => {
          calls.push(`resume:${id}`)
          return { ok: true }
        },
      }),
    )
    expect(await host('identities.suspend', 'emitter', { id: 'toy-alpha' }, 1000)).toEqual({
      ok: true,
      value: { ok: true },
    })
    expect(await host('identities.resume', 'emitter', { id: 'toy-alpha' }, 1000)).toEqual({
      ok: true,
      value: { ok: true },
    })
    expect(calls).toEqual(['suspend:toy-alpha', 'resume:toy-alpha'])
  })

  it('幂等：连续 suspend / resume 均由回调语义承担，均回 {ok:true}', async () => {
    const host = createHostCapability(
      baseDeps({
        suspendIdentity: async () => ({ ok: true }),
        resumeIdentity: async () => ({ ok: true }),
      }),
    )
    expect((await host('identities.suspend', 'emitter', { id: 'toy-alpha' }, 1000)).ok).toBe(true)
    expect((await host('identities.suspend', 'emitter', { id: 'toy-alpha' }, 1000)).ok).toBe(true)
    expect((await host('identities.resume', 'emitter', { id: 'toy-alpha' }, 1000)).ok).toBe(true)
  })

  it('not_found：回调拒 / 缺 id / 未接线', async () => {
    const host = createHostCapability(
      baseDeps({ suspendIdentity: async () => ({ ok: false, code: 'not_found' }) }),
    )
    const unknown = await host('identities.suspend', 'emitter', { id: 'ghost' }, 1000)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.code).toBe('not_found')

    const missing = await host('identities.resume', 'emitter', {}, 1000)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('not_found')

    const unwired = createHostCapability(baseDeps())
    const bare = await unwired('identities.suspend', 'emitter', { id: 'toy-alpha' }, 1000)
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.code).toBe('not_found')
  })
})
