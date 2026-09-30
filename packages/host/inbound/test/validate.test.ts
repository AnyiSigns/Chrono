// 入站消息与 directive 草稿的形状校验：畸形提交一律拒（返回 null），不得打崩写者。

import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS } from '../../run-registry.ts'
import { asDirectives, readMessage, resolveCaps, resolveLimits } from '../validate.ts'

describe('inbound/validate', () => {
  it('readMessage：v / id / kind 皆字符串才认；否则回报可配对的 id', () => {
    expect(readMessage({ v: '1', id: 'a', kind: 'status' })).toEqual({
      ok: true,
      message: { v: '1', id: 'a', kind: 'status' },
    })
    // 缺 / 错型 v / kind，但 id 可解析 → {ok:false, id}，调用方据此回 bad_directive
    expect(readMessage({ v: '1', id: 'a' })).toEqual({ ok: false, id: 'a' })
    expect(readMessage({ id: 'a', kind: 'status' })).toEqual({ ok: false, id: 'a' })
    expect(readMessage({ v: 1, id: 'a', kind: 'status' })).toEqual({ ok: false, id: 'a' })
    expect(readMessage({ v: '1', id: 'a', kind: 5 })).toEqual({ ok: false, id: 'a' })
    // id 缺 / 非字符串：协议上无法配对 → id:null
    expect(readMessage({ v: '1', kind: 'status' })).toEqual({ ok: false, id: null })
    expect(readMessage({ v: '1', id: 2, kind: 'status' })).toEqual({ ok: false, id: null })
    expect(readMessage('not-an-object')).toEqual({ ok: false, id: null })
    expect(readMessage(null)).toEqual({ ok: false, id: null })
  })

  it('asDirectives：eval / extern / write 合法', () => {
    expect(asDirectives([{ kind: 'eval', entry: 'h' }])).not.toBeNull()
    expect(asDirectives([{ kind: 'extern', payload: null }])).not.toBeNull()
    expect(asDirectives([{ kind: 'write', request: { op: 'put', args: {} } }])).not.toBeNull()
  })

  it('asDirectives：未知 kind / 缺 entry / 坏 op / 非数组 一律拒', () => {
    expect(asDirectives([{ kind: 'unknown' }])).toBeNull()
    expect(asDirectives([{ kind: 'eval', entry: '' }])).toBeNull()
    expect(asDirectives([{ kind: 'write', request: { op: 'nope' } }])).toBeNull()
    expect(asDirectives([{ kind: 'write', request: null }])).toBeNull()
    expect(asDirectives('nope')).toBeNull()
  })
})

describe('inbound/validate resolveCaps', () => {
  it('缺省（undefined）回落空表', () => {
    expect(resolveCaps(undefined)).toEqual({})
  })

  it('合法布尔表原样保留（含空表）', () => {
    expect(resolveCaps({})).toEqual({})
    expect(resolveCaps({ a: true, b: false })).toEqual({ a: true, b: false })
  })

  it('非对象 / 数组 / null 一律拒', () => {
    expect(resolveCaps(null)).toBeNull()
    expect(resolveCaps('x')).toBeNull()
    expect(resolveCaps([])).toBeNull()
    expect(resolveCaps(0)).toBeNull()
  })

  it('值非布尔一律拒', () => {
    expect(resolveCaps({ a: 'yes' })).toBeNull()
    expect(resolveCaps({ a: 1 })).toBeNull()
    expect(resolveCaps({ a: null })).toBeNull()
    expect(resolveCaps({ a: {} })).toBeNull()
  })

  it('原型键（自有）一律 fail-closed，不静默变形', () => {
    // JSON.parse 造出真正的自有键：字面量 __proto__ 会改原型而非建键
    expect(resolveCaps(JSON.parse('{"__proto__":true}'))).toBeNull()
    expect(resolveCaps(JSON.parse('{"constructor":true}'))).toBeNull()
    expect(resolveCaps(JSON.parse('{"prototype":true}'))).toBeNull()
    expect(resolveCaps(JSON.parse('{"__proto__":{"polluted":true}}'))).toBeNull()
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    // 普通布尔表不受影响
    expect(resolveCaps({ a: true, b: false })).toEqual({ a: true, b: false })
  })
})

describe('inbound/validate resolveLimits', () => {
  it('缺省（undefined）回落 DEFAULT_LIMITS', () => {
    expect(resolveLimits(undefined)).toEqual(DEFAULT_LIMITS)
  })

  it('空对象逐字段回落默认（limits:{} 合法）', () => {
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS)
  })

  it('字段缺失取默认对应值', () => {
    expect(resolveLimits({ gas: 5 })).toEqual({ gas: 5, depth: DEFAULT_LIMITS.depth })
    expect(resolveLimits({ depth: 2 })).toEqual({ gas: DEFAULT_LIMITS.gas, depth: 2 })
  })

  it('显式正整数生效；未知多余键忽略', () => {
    expect(resolveLimits({ gas: 5, depth: 2 })).toEqual({ gas: 5, depth: 2 })
    expect(resolveLimits({ gas: 5, depth: 2, extra: true })).toEqual({ gas: 5, depth: 2 })
  })

  it('边界：gas:1 / depth:1 合法', () => {
    expect(resolveLimits({ gas: 1 })).toEqual({ gas: 1, depth: DEFAULT_LIMITS.depth })
    expect(resolveLimits({ depth: 1 })).toEqual({ gas: DEFAULT_LIMITS.gas, depth: 1 })
  })

  it('非对象 / 数组 / null / 字符串一律拒', () => {
    expect(resolveLimits(null)).toBeNull()
    expect(resolveLimits('x')).toBeNull()
    expect(resolveLimits([])).toBeNull()
    expect(resolveLimits(5)).toBeNull()
  })

  it('字段存在但非正整数一律拒', () => {
    expect(resolveLimits({ gas: 0 })).toBeNull()
    expect(resolveLimits({ gas: -1 })).toBeNull()
    expect(resolveLimits({ gas: 1.5 })).toBeNull()
    expect(resolveLimits({ gas: Number.NaN })).toBeNull()
    expect(resolveLimits({ gas: Number.POSITIVE_INFINITY })).toBeNull()
    expect(resolveLimits({ depth: 0 })).toBeNull()
    expect(resolveLimits({ depth: -1 })).toBeNull()
    expect(resolveLimits({ gas: '5' })).toBeNull()
    expect(resolveLimits({ depth: true })).toBeNull()
  })

  it('超大正整数（> 2**31-1）仍属正整数、按口径放行', () => {
    expect(resolveLimits({ gas: 2 ** 40 })).toEqual({ gas: 2 ** 40, depth: DEFAULT_LIMITS.depth })
  })
})
