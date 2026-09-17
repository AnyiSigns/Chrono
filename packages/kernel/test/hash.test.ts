// hash.ts 验收测试：sha256 已知向量就地自证、utf8 编码、H 的流式与两段式口径。只从 index.ts 导入。

import { canonicalJson, H, KernelError, sha256, utf8 } from '../index.ts'
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

/** 测试侧组装小写 hex（公共面未导出 hex；两段式口径 = hex(sha256(utf8(canonicalJson(v))))）。 */
function hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function twoStage(v: Json | undefined): string {
  return hex(sha256(utf8(canonicalJson(v))))
}

const VECTORS: [string, string][] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
]

const UTF8_CASES: [string, number[]][] = [
  ['A', [0x41]], // 1 字节：U+0041
  ['é', [0xc3, 0xa9]], // 2 字节：U+00E9
  ['中', [0xe4, 0xb8, 0xad]], // 3 字节：U+4E2D
  ['\ud83d\ude00', [0xf0, 0x9f, 0x98, 0x80]], // 4 字节：代理对 → U+1F600
]

const LONE_INPUTS: string[] = ['\ud800', '\udc00', '\ud83dA', 'A\udfff', '\ud800\ud800']

const H_SAMPLES: Json[] = [{}, 'abc', [1, 2, 3], { k: 'é\u4e2d\ud83d\ude00' }]

const PAYLOADS: Json[] = [
  {},
  { a: 1, b: [true, null, 'x', 3] },
  { m: [{ x: 'y' }, [1, 2]] },
  { k: 'a'.repeat(60) }, // canonical 68 字节：数据跨 2 个 512 位块
  { k: 'a'.repeat(63) },
  { k: 'a'.repeat(64) }, // 恰好整块，pad 溢入下一块
  { k: 'a'.repeat(65) },
  { s: '中'.repeat(30) }, // 3 字节码元跨块
  { e: '\ud83d\ude00'.repeat(30) }, // 4 字节码元跨块
  { big: 'a'.repeat(5_000) }, // 大载荷：约 79 块
]

describe('sha256', () => {
  it('四条已知向量：全串 64 个十六进制字符逐条断言', () => {
    for (const [input, want] of VECTORS) {
      const digest = hex(sha256(utf8(input)))
      expect(digest).toHaveLength(64)
      expect(digest).toBe(want)
    }
  })

  it('输出 32 字节全量不截断', () => {
    expect(sha256(utf8('abc'))).toHaveLength(32)
    expect(sha256(new Uint8Array(0))).toHaveLength(32)
  })
})

describe('utf8', () => {
  it('1/2/3/4 字节码元各一例', () => {
    for (const [input, want] of UTF8_CASES) expect(Array.from(utf8(input))).toEqual(want)
  })

  it('混合串逐 code unit 编码 = 各段字节顺序拼接', () => {
    const mixed = Array.from(utf8('Aé\u4e2d\ud83d\ude00'))
    expect(mixed).toEqual([0x41, 0xc3, 0xa9, 0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x98, 0x80])
  })

  it('合法代理对不误报（最低代理对 U+10000 → 4 字节）', () => {
    expect(Array.from(utf8('\ud800\udc00'))).toEqual([0xf0, 0x90, 0x80, 0x80])
  })

  it('孤立代理一律 Err(lone_surrogate)：高、低、跟错码元、对半截断', () => {
    for (const input of LONE_INPUTS) expectCode(() => utf8(input), 'lone_surrogate')
  })
})

describe('H', () => {
  it('H({}) 两次调用同值（确定性，无隐藏状态）', () => {
    expect(H({})).toBe(H({}))
  })

  it('H 输出全 64 个小写十六进制字符，不截断', () => {
    for (const v of H_SAMPLES) {
      expect(H(v)).toMatch(/^[0-9a-f]{64}$/)
      expect(H(v)).toHaveLength(64)
    }
  })

  // 口径：H(v) === hex(sha256(utf8(canonicalJson(v))))；PAYLOADS 覆盖跨 512 位块两侧与大载荷。
  it('流式与两段式等价，含跨 512 位块的大载荷例', () => {
    for (const payload of PAYLOADS) expect(H(payload)).toBe(twoStage(payload))
  })

  it('跨 1,000,000 字符载荷（与百万级已知向量同量级）流式 = 两段式', () => {
    const huge = 'a'.repeat(1_000_000)
    expect(H({ big: huge })).toBe(twoStage({ big: huge }))
    expect(H(huge)).toBe(twoStage(huge))
  })

  it('孤立代理只在 utf8 边界被拒；H 路径经 canonicalJson 转义为 ASCII 不触发', () => {
    expectCode(() => utf8('\ud800'), 'lone_surrogate')
    expect(H({ weird: '\ud800' })).toHaveLength(64)
    expect(H({ weird: '\ud800' })).toBe(twoStage({ weird: '\ud800' }))
  })
})
