// value.ts 验收测试：覆盖类型判定顺序、canonicalJson 边界、键序无关性与 deepEq。只经公共面 index.ts 导入。

import { canonicalJson, deepEq, KernelError, t, TYPE_ORDER } from '../index.ts'
import type { Json } from '../index.ts'
import { describe, expect, it } from 'vitest'

/** 错误断言口径：抛 KernelError、code 即错误码、message === code。 */
function expectCode(fn: () => unknown, code: string): void {
  let caught: KernelError | undefined
  try {
    fn()
  } catch (e) {
    caught = e as KernelError
  }
  expect(caught).toBeInstanceOf(KernelError)
  expect(caught?.code).toBe(code)
  expect(caught?.message).toBe(code)
}

// Json 类型无法表达“键在但值为 undefined”的运行时输入——边界用例恰来自这种输入，造一个。
const missing: Json = undefined as unknown as Json

const NONFINITE: number[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
const SIX_CASES: [Json | undefined, string][] = [
  [42, 'Int'],
  ['s', 'Str'],
  [true, 'Bool'],
  [[1, 2], 'List'],
  [{ a: 1 }, 'Json'],
  [null, 'None'],
  [undefined, 'None'],
]

function nest(levels: number, leaf: Json): Json {
  let v = leaf
  for (let i = 0; i < levels; i++) v = [v]
  return v
}

/** mulberry32：固定种子 PRNG，随机口径是种子写死在测试内，保证用例可重跑。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function shuffledKeys(keys: readonly string[], rand: () => number): string[] {
  const out = keys.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

// 键一律带非数字前缀：整数样键会被 V8 自动重排，测不出“插入顺序”这个变量。
const SEED_KEYS = 20260916
const SORTED_KEYS = ['k00', 'k01', 'k02', 'k03', 'k04', 'k05', 'k06', 'k07', 'k08', 'k09', 'k10']
const suffixOf = (key: string): number => 100 + Number(key.slice(1))

function buildValue(keys: readonly string[]): Json {
  const pairs: [string, number][] = keys.map((key): [string, number] => [key, suffixOf(key)])
  return Object.fromEntries(pairs)
}

function canonicalFor(keys: readonly string[]): string {
  return '{' + keys.map((key) => `"${key}":${suffixOf(key)}`).join(',') + '}'
}

describe('t() 判定顺序（焊死）', () => {
  it('TYPE_ORDER 六型标签按规格全序', () => {
    expect(Array.from(TYPE_ORDER)).toEqual(['Int', 'Str', 'Bool', 'List', 'Json', 'None'])
  })

  it('六型各一例（undefined 与 null 同格 None）', () => {
    for (const [v, want] of SIX_CASES) expect(t(v)).toBe(want)
  })

  it('顺序敏感例：true 判 Bool 不可判 Int', () => {
    expect(t(true)).toBe('Bool')
    expect(t(false)).toBe('Bool')
    expect(t(1)).toBe('Int')
  })

  it('浮点例：Int 值域是全体有限数，1.5 仍是 Int', () => {
    expect(t(1.5)).toBe('Int')
    expect(t(-7.25)).toBe('Int')
    expect(t(Number.MAX_VALUE)).toBe('Int')
  })

  it('t(NaN) / t(±Infinity) → Err(nonfinite)，非有限数不进值域', () => {
    for (const v of NONFINITE) expectCode(() => t(v), 'nonfinite')
  })
})

describe('canonicalJson 边界（7 例逐条）', () => {
  it('顶层 undefined → Err(undefined)', () => {
    expectCode(() => canonicalJson(undefined), 'undefined')
  })

  it('{a:undefined,b:1} 的键被剔除而非保留为 null', () => {
    expect(canonicalJson({ a: missing, b: 1 })).toBe('{"b":1}')
  })

  it('-0 归一为 0，否则 H(-0) ≠ H(0)', () => {
    expect(canonicalJson(-0)).toBe('0')
    expect(canonicalJson({ z: -0 })).toBe('{"z":0}')
  })

  it('NaN / Infinity → Err(nonfinite)', () => {
    for (const v of NONFINITE) expectCode(() => canonicalJson(v), 'nonfinite')
  })

  it('空对象 / 空数组 → {} / []', () => {
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson([])).toBe('[]')
  })

  it('{b:1,a:2} 按 code-unit 升序，与插入顺序无关', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('深度 65 的嵌套 → Err(depth)；深度 64 恰好通过', () => {
    expect(canonicalJson(nest(64, null))).toBe('['.repeat(64) + 'null' + ']'.repeat(64))
    expectCode(() => canonicalJson(nest(65, null)), 'depth')
  })

  it('数字走最短往返表示，字符串走标准转义', () => {
    expect(canonicalJson(0.1 + 0.2)).toBe('0.30000000000000004')
    expect(canonicalJson(1e21)).toBe('1e+21')
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(canonicalJson('\n\t')).toBe('"\\n\\t"')
  })
})

describe('键序无关性与 deepEq', () => {
  it('键序无关性：固定种子洗牌 10 组键序，canonicalJson 同值', () => {
    const rand = mulberry32(SEED_KEYS)
    const sorted = [...SORTED_KEYS].sort()
    const expected = canonicalFor(sorted)
    const sortedJoin = sorted.join()
    let sawPermutation = false
    for (let round = 0; round < 10; round++) {
      const keys = shuffledKeys(SORTED_KEYS, rand)
      if (keys.join() !== sortedJoin) sawPermutation = true
      expect(canonicalJson(buildValue(keys))).toBe(expected)
      expect(deepEq(buildValue(keys), buildValue(sorted))).toBe(true)
    }
    expect(sawPermutation).toBe(true)
  })

  it('deepEq 正例：undefined 键剔除、键序、嵌套、undefined 双方', () => {
    expect(deepEq({ a: missing, b: 1 }, { b: 1 })).toBe(true)
    expect(deepEq({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true)
    expect(deepEq([1, [2, { x: 'y' }]], [1, [2, { x: 'y' }]])).toBe(true)
    expect(deepEq({ a: { x: missing, y: 1 } }, { a: { y: 1 } })).toBe(true)
    expect(deepEq(undefined, undefined)).toBe(true)
    expect(deepEq(null, null)).toBe(true)
  })

  it('deepEq 反例：键集 / 变序 / 跨型一律 false', () => {
    expect(deepEq({ a: 1 }, { a: 1, b: 1 })).toBe(false)
    expect(deepEq([1, 2], [2, 1])).toBe(false)
    expect(deepEq({ a: { b: 2 } }, { a: { b: 3 } })).toBe(false)
    expect(deepEq({}, [])).toBe(false)
  })

  it('不做隐式转换：true 与 1 不等，任何输入都返回布尔不抛错', () => {
    expect(deepEq(true, 1)).toBe(false)
    expect(deepEq(1, true)).toBe(false)
    expect(deepEq(42, '42')).toBe(false)
    expect(deepEq(false, 0)).toBe(false)
    for (const [a, b] of [
      [NaN, NaN],
      [Infinity, -1],
      [{}, undefined],
    ] as [Json | undefined, Json | undefined][]) {
      expect(() => deepEq(a, b)).not.toThrow()
      expect(typeof deepEq(a, b)).toBe('boolean')
    }
  })
})
