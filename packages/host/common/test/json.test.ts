import { describe, expect, it } from 'vitest'
import type { Json } from '../../../kernel/index.ts'
import {
  PROTOTYPE_KEYS,
  asRecord,
  isRecord,
  isStringArray,
  isStringMap,
  jsonByteLength,
} from '../json.ts'

describe('common/json', () => {
  it('isRecord / asRecord 只认非 null、非数组对象', () => {
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([])).toBeNull()
  })

  it('isStringArray / isStringMap 形态判定', () => {
    expect(isStringArray(['a', 'b'])).toBe(true)
    expect(isStringArray(['a', 1])).toBe(false)
    expect(isStringArray('a')).toBe(false)
    expect(isStringMap({ a: 'x' })).toBe(true)
    expect(isStringMap({ a: 1 })).toBe(false)
    expect(isStringMap(null)).toBe(false)
  })

  it('PROTOTYPE_KEYS 恰为三个 JS 原型键', () => {
    expect([...PROTOTYPE_KEYS].sort()).toEqual(['__proto__', 'constructor', 'prototype'])
  })

  it('jsonByteLength 取序列化字符数；序列化异常按 0 计', () => {
    expect(jsonByteLength({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length)
    const cyclic: { [k: string]: unknown } = {}
    cyclic['self'] = cyclic
    expect(jsonByteLength(cyclic as unknown as Json)).toBe(0)
  })
})
