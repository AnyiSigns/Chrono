// 规范序列化一致性：SDK 自带实现与内核口径逐字节相同（键序 / undefined 剔除 / -0 / 数字表示）。
// 这条是「服务协议统一按内核口径序列化」的地基——插件 TS 曾用 JSON.stringify，与宿主不一致。

import { describe, expect, it } from 'vitest'

import { canonicalJson } from '../canonical.ts'
import { canonicalJson as kernelCanonicalJson } from '../../packages/kernel/index.ts'
import type { Json } from '../json.ts'

const CASES: Json[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  1.5,
  -1.5,
  1e21,
  1e-7,
  9007199254740991,
  '',
  'plain',
  '中文',
  'quote"slash\\newline\n',
  [],
  [1, 'a', null, [true]],
  {},
  { b: 1, a: 2 },
  { '2': 'two', '10': 'ten', a: 'x' },
  { nested: { z: [1, { y: 2 }], a: null } },
  { keep: 1, drop: undefined } as unknown as Json,
]

describe('规范序列化', () => {
  it('与内核口径逐字节相同', () => {
    for (const value of CASES) {
      expect(canonicalJson(value), JSON.stringify(value)).toBe(kernelCanonicalJson(value))
    }
  })

  it('键按 code-unit 升序、剔除 undefined、-0 归一为 0', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ keep: 1, drop: undefined } as unknown as Json)).toBe('{"keep":1}')
    expect(canonicalJson(-0)).toBe('0')
  })

  it('顶层 undefined / 非有限数 / 超深嵌套抛错', () => {
    expect(() => canonicalJson(undefined)).toThrow()
    expect(() => canonicalJson(Number.NaN)).toThrow()
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow()
    let deep: Json = null
    for (let i = 0; i < 80; i++) deep = [deep]
    expect(() => canonicalJson(deep)).toThrow()
  })
})
