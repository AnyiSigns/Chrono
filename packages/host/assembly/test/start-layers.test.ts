// 装配启动分层单测：层号计算（依赖先出现、同层无依赖）与有上限并发（上限生效、层内任务全部落地）。

import { describe, expect, it } from 'vitest'
import { computeStartLayers, runWithConcurrency } from '../start-layers.ts'

describe('computeStartLayers', () => {
  it('无依赖同层；依赖链按最长深度分层', () => {
    const deps = new Map<string, string[]>([
      ['a', []],
      ['b', []],
      ['c', ['a']],
      ['d', ['a', 'c']],
    ])
    const layers = computeStartLayers(['a', 'b', 'c', 'd'], deps)
    expect(layers).toEqual([['a', 'b'], ['c'], ['d']])
  })

  it('不在启动序内的依赖不参与分层（启动时按 dep stale 处理）', () => {
    const deps = new Map<string, string[]>([['leaf', ['gone']]])
    const layers = computeStartLayers(['leaf'], deps)
    expect(layers).toEqual([['leaf']])
  })

  it('依赖先出现的启动序下，任一身份的依赖层号严格更小', () => {
    const deps = new Map<string, string[]>([
      ['base', []],
      ['mid', ['base']],
      ['left', ['mid']],
      ['right', ['mid']],
      ['top', ['left', 'right']],
    ])
    const order = ['base', 'mid', 'left', 'right', 'top']
    const layers = computeStartLayers(order, deps)
    const levelOf = new Map<string, number>()
    layers.forEach((layer, index) => layer.forEach((id) => levelOf.set(id, index)))
    for (const [id, list] of deps) {
      for (const dep of list) {
        expect(levelOf.get(dep)!).toBeLessThan(levelOf.get(id)!)
      }
    }
  })
})

describe('runWithConcurrency', () => {
  it('上限生效：4 项、上限 2 → 同时最多 2 个在跑', async () => {
    let active = 0
    let maxActive = 0
    await runWithConcurrency([1, 2, 3, 4], 2, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
    })
    expect(maxActive).toBe(2)
  })

  it('上限大于项数时不空转；全部任务恰好执行一次', async () => {
    const seen: number[] = []
    await runWithConcurrency([1, 2, 3], 10, async (item) => {
      seen.push(item)
    })
    expect(seen.sort()).toEqual([1, 2, 3])
  })

  it('空列表立即返回', async () => {
    let called = false
    await runWithConcurrency([], 4, async () => {
      called = true
    })
    expect(called).toBe(false)
  })

  it('limit 为 NaN 不静默跳过整层：全部任务仍执行', async () => {
    const seen: number[] = []
    await runWithConcurrency([1, 2, 3], Number.NaN, async (item) => {
      seen.push(item)
    })
    expect(seen.sort()).toEqual([1, 2, 3])
  })

  it('limit 为 Infinity 按不限并发处理：全部任务执行', async () => {
    const seen: number[] = []
    await runWithConcurrency([1, 2, 3], Number.POSITIVE_INFINITY, async (item) => {
      seen.push(item)
    })
    expect(seen.sort()).toEqual([1, 2, 3])
  })
})
