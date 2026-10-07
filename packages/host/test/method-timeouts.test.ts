// 方法级超时声明：从 schema def body 读 `method_timeouts`（非法条目只记 invalid），
// 并按 (身份, 能力类, 方法) 解析覆盖值——精确 `类.方法` 优先，其次裸方法名。

import { describe, expect, it } from 'vitest'
import { readMethodTimeouts, resolveMethodTimeoutMs } from '../method-timeouts.ts'
import type { Json, World } from '../../kernel/index.ts'

function worldWithSchemas(schemas: Record<string, Json>): World {
  const defs: Record<string, Json> = {}
  const ids: Record<string, Json> = {}
  let index = 0
  for (const [identity, schema] of Object.entries(schemas)) {
    const key = `s${index++}`
    defs[key] = { body: schema }
    ids[identity] = {
      id: identity,
      schema: key,
      gens: [{ seq: 0, payload: key }],
      active: key,
      born: { at: 0, by: 'test' },
    }
  }
  return { defs, ids } as unknown as World
}

describe('方法级超时声明', () => {
  it('readMethodTimeouts：解析声明键与毫秒值；非法条目只记 invalid', () => {
    const world = worldWithSchemas({
      alpha: { method_timeouts: { 'toy.slow.echo': 200, chat: 50 } },
      beta: { method_timeouts: ['nope'] },
      gamma: { method_timeouts: { 'toy.slow.echo': 0, ['__proto__']: 5, 'ok.method': 12 } },
    })
    const { entries, invalid } = readMethodTimeouts(world)
    expect(entries).toEqual([
      { identity: 'alpha', key: 'toy.slow.echo', timeoutMs: 200 },
      { identity: 'alpha', key: 'chat', timeoutMs: 50 },
      { identity: 'gamma', key: 'ok.method', timeoutMs: 12 },
    ])
    expect(invalid).toEqual([
      { identity: 'beta', reason: 'bad_method_timeouts' },
      { identity: 'gamma', reason: 'bad_timeout_ms' },
      { identity: 'gamma', reason: 'bad_timeout_key' },
    ])
  })

  it('readMethodTimeouts：无声明 / retired 身份跳过', () => {
    const world = worldWithSchemas({ alpha: { type: 'object' } })
    expect(readMethodTimeouts(world)).toEqual({ entries: [], invalid: [] })
  })

  it('resolveMethodTimeoutMs：精确匹配优先，裸方法名兜底；无声明返回 undefined', () => {
    const world = worldWithSchemas({
      alpha: { method_timeouts: { 'toy.slow.echo': 200, echo: 50, chat: 90 } },
    })
    expect(resolveMethodTimeoutMs(world, 'alpha', 'toy.slow', 'echo')).toBe(200)
    expect(resolveMethodTimeoutMs(world, 'alpha', 'other', 'echo')).toBe(50)
    expect(resolveMethodTimeoutMs(world, 'alpha', 'model', 'chat')).toBe(90)
    expect(resolveMethodTimeoutMs(world, 'alpha', 'toy.slow', 'missing')).toBeUndefined()
    expect(resolveMethodTimeoutMs(world, 'beta', 'toy.slow', 'echo')).toBeUndefined()
  })

  it('readMethodTimeouts：超过计时器硬上限（2^31-1）按非法处理、无覆盖；边界值放行', () => {
    const world = worldWithSchemas({
      alpha: { method_timeouts: { chat: 1e300, echo: 2 ** 31 } },
      beta: { method_timeouts: { chat: 2 ** 31 - 1 } },
    })
    const { entries, invalid } = readMethodTimeouts(world)
    expect(entries).toEqual([{ identity: 'beta', key: 'chat', timeoutMs: 2 ** 31 - 1 }])
    expect(invalid).toEqual([
      { identity: 'alpha', reason: 'bad_timeout_ms' },
      { identity: 'alpha', reason: 'bad_timeout_ms' },
    ])
    expect(resolveMethodTimeoutMs(world, 'alpha', 'model', 'chat')).toBeUndefined()
  })
})
