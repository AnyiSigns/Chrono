// 换人序编排单测：用假 SwapHost 观测调用序与分支，不真起进程。
// 覆盖：独占序「准备 → drain → spawn → 接管」的顺序、准备失败保旧实例、spawn 失败转重试、两条替换防御。

import { describe, expect, it } from 'vitest'
import { swapService } from '../swap.ts'
import type { SwapHost } from '../swap.ts'
import type { ServiceRuntime } from '../supervision.ts'
import type { PreparedService } from '../service-launcher.ts'
import type { PluginDecl } from '../decl.ts'
import type { Hash } from '../../../kernel/index.ts'

const GEN = 'a'.repeat(64) as Hash

const EXCLUSIVE = { identity: 'toy', exclusive: ['port'] } as unknown as PluginDecl
const OVERLAP = { identity: 'toy', exclusive: [] } as unknown as PluginDecl

function fakeService(): ServiceRuntime {
  return { id: 'toy', gen: GEN, draining: false } as unknown as ServiceRuntime
}

interface Harness {
  host: SwapHost
  calls: string[]
}

function harness(oldService: ServiceRuntime, overrides: Partial<SwapHost> = {}): Harness {
  const calls: string[] = []
  const nextService = fakeService()
  const prepared: PreparedService = { cwd: 'C:/materialized/toy' }
  // 服务表用可变游标模拟：removeService 后 serviceOf 应为空，adoptService 后指向新实例
  let current: ServiceRuntime | undefined = oldService
  const base: SwapHost = {
    isStopping: () => false,
    isIsolated: () => false,
    serviceOf: () => current,
    adoptService: () => {
      calls.push('adopt')
      current = nextService
    },
    removeService: () => {
      calls.push('remove')
      current = undefined
    },
    launch: async () => {
      calls.push('launch')
      return nextService
    },
    prepare: async () => {
      calls.push('prepare')
      return prepared
    },
    launchPrepared: async () => {
      calls.push('launchPrepared')
      return nextService
    },
    rekeyEndpoints: () => {
      calls.push('rekey')
    },
    clearRestart: () => {
      calls.push('clearRestart')
    },
    recordStartFailure: () => {
      calls.push('recordStartFailure')
    },
    stopSuperseded: async () => {
      calls.push('stopSuperseded')
    },
    scheduleGenerationRetry: () => {
      calls.push('scheduleRetry')
    },
  }
  return { host: { ...base, ...overrides }, calls }
}

describe('换人序编排', () => {
  it('独占序：准备 → drain 旧 → spawn → 接管，缺省入口 launch 不参与', async () => {
    const oldService = fakeService()
    const { host, calls } = harness(oldService)
    await swapService(host, 'toy', oldService, GEN, EXCLUSIVE)
    expect(calls).toEqual([
      'clearRestart',
      'prepare',
      'remove',
      'stopSuperseded',
      'launchPrepared',
      'adopt',
    ])
  })

  it('缺省序：launch 一次完成，准备阶段入口不参与', async () => {
    const oldService = fakeService()
    const { host, calls } = harness(oldService)
    await swapService(host, 'toy', oldService, GEN, OVERLAP)
    expect(calls).toEqual(['clearRestart', 'launch', 'adopt', 'stopSuperseded'])
  })

  it('独占序准备阶段失败：旧实例不 drain，记失败 + 端点换新世代键', async () => {
    const oldService = fakeService()
    const { host, calls } = harness(oldService, {
      prepare: async () => {
        calls.push('prepare')
        throw new Error('build exploded')
      },
    })
    await swapService(host, 'toy', oldService, GEN, EXCLUSIVE)
    expect(calls).toEqual(['clearRestart', 'prepare', 'recordStartFailure', 'rekey'])
  })

  it('独占序 spawn 阶段失败：旧实例已 drain，转「无服务保留世代」重试', async () => {
    const oldService = fakeService()
    const { host, calls } = harness(oldService, {
      launchPrepared: async () => {
        calls.push('launchPrepared')
        throw new Error('spawn exploded')
      },
    })
    await swapService(host, 'toy', oldService, GEN, EXCLUSIVE)
    expect(calls).toEqual([
      'clearRestart',
      'prepare',
      'remove',
      'stopSuperseded',
      'launchPrepared',
      'recordStartFailure',
      'scheduleRetry',
    ])
  })

  it('替换防御：准备前旧服务已被替换 → 不做任何动作', async () => {
    const oldService = fakeService()
    const { host, calls } = harness(oldService, { serviceOf: () => undefined })
    await swapService(host, 'toy', oldService, GEN, EXCLUSIVE)
    expect(calls).toEqual(['clearRestart'])
  })

  it('替换防御：准备期间旧服务被替换 → drain 之前中止', async () => {
    const oldService = fakeService()
    let lookups = 0
    const { host, calls } = harness(oldService, {
      serviceOf: () => {
        lookups += 1
        return lookups === 1 ? oldService : undefined
      },
    })
    await swapService(host, 'toy', oldService, GEN, EXCLUSIVE)
    expect(calls).toEqual(['clearRestart', 'prepare'])
  })
})
